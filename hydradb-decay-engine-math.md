# Hydra DB — Decay Engine Math Walkthrough

How the reinforcement and decay terms are computed from timestamps, end to end, with a concrete worked example.

---

## The Inputs to a Single Recompute

For one chunk, when the retention worker runs:

```
salience:           0.6                            (immutable, from ingest)
tCommit:            "2026-05-01T10:00:00.000Z"     (immutable, the birth time)
accessTimestamps:   [                              (grew via retrieval logging)
  "2026-05-05T14:00:00.000Z",
  "2026-05-08T09:00:00.000Z",
  "2026-05-10T16:30:00.000Z"
]
now (worker fires):  "2026-05-11T03:00:00.000Z"     (Date.now() at this moment)
```

Two constants, defined at the top of `src/workers/retention.worker.ts`:

```ts
const LAMBDA = 0.05;  // decay rate per day
const SIGMA = 0.2;    // reinforcement strength
const DAY_MS = 1000 * 60 * 60 * 24;
```

---

## Step 1 — Compute the Decay Term

The decay term uses **one** timestamp: `tCommit`.

```ts
const tCommitMs = new Date(payload.tCommit).getTime();
//   ↳ parse the ISO string into milliseconds since epoch

const dtDays = (nowMs - tCommitMs) / DAY_MS;
//   ↳ subtract → milliseconds difference → divide by ms-per-day → fractional days

const decay = salience * Math.exp(-LAMBDA * dtDays);
//   ↳ salience × e^(-λ × age_in_days)
```

Plugging in the example values:

```
tCommitMs = 1746093600000  (2026-05-01T10:00:00Z)
nowMs     = 1746759600000  (2026-05-11T03:00:00Z)

(nowMs - tCommitMs) = 666,000,000 ms

dtDays = 666,000,000 / 86,400,000
       = 7.7083 days

decay = 0.6 × e^(-0.05 × 7.7083)
      = 0.6 × e^(-0.3854)
      = 0.6 × 0.6803
      = 0.408
```

That's the decay component. The memory's salience-derived value has decayed from `0.6` down to `0.408` over ~7.7 days.

**Key things to note:**
- `dtDays` is computed **fresh** every recompute — it always uses "now" as the reference
- Only `tCommit` and `nowMs` matter for this term — access timestamps are irrelevant here
- `salience` is the multiplier — high-salience memories decay from a higher ceiling

---

## Step 2 — Compute the Reinforcement Term

The reinforcement term uses **all** entries in `accessTimestamps[]`. It's a sum.

```ts
const reinforcement = (payload.accessTimestamps ?? [])
  .reduce((sum, ts) => {
    const tsMs = new Date(ts).getTime();
    //   ↳ parse each access timestamp into ms

    const ageDays = Math.max((nowMs - tsMs) / DAY_MS, 1.0);
    //   ↳ subtract → ms diff → days. FLOOR at 1 day so recent accesses
    //     don't blow up via division by ~zero.

    return sum + (1 / ageDays);
    //   ↳ contribution of THIS access = 1 / (days since it happened)
    //     more recent = bigger contribution

  }, 0) * SIGMA;
//  ↳ scale the whole sum by σ
```

Plugging in:

```
Access 1: 2026-05-05T14:00:00Z
  ageDays = (nowMs - 1746450000000) / DAY_MS = 5.541 days
  max(5.541, 1.0) = 5.541
  contribution = 1 / 5.541 = 0.1805

Access 2: 2026-05-08T09:00:00Z
  ageDays = 2.75 days
  max(2.75, 1.0) = 2.75
  contribution = 1 / 2.75 = 0.3636

Access 3: 2026-05-10T16:30:00Z
  ageDays = 0.4375 days  ← less than 1 day!
  max(0.4375, 1.0) = 1.0   ← floored
  contribution = 1 / 1.0 = 1.0

Sum: 0.1805 + 0.3636 + 1.0 = 1.5441

reinforcement = 1.5441 × 0.2 (sigma) = 0.3088
```

That's the reinforcement boost: `+0.309` to retention because there were three accesses in the last ~6 days, with the most recent one being today.

**Key things to note:**
- Each access is processed independently and its contribution is summed
- More recent accesses dominate (the `1/age` curve drops fast)
- The `Math.max(ageDays, 1.0)` floor caps the contribution at `1.0` per access — without it, an access from seconds ago would contribute `1/0.0001 = 10000`
- σ scales the whole thing — with σ=0.2, the maximum a single access can contribute is `0.2` (when it just happened today)

---

## Step 3 — Combine and Clamp

```ts
const newR = Math.min(decay + reinforcement, 1.0);
//        ↳ sum the two terms, then clamp at 1 so multiple recent accesses
//          can't push R above the valid range
```

Plugging in:
```
newR = min(0.408 + 0.3088, 1.0)
     = min(0.7168, 1.0)
     = 0.7168
```

The final `retentionScore` is **0.7168**.

Without any access, R would have been just `0.408` (the decay floor). The three accesses lifted it by ~0.31 net.

---

## Step 4 — Map to Tier

```ts
function computeTier(r: number): number {
  if (r > 0.7) return 0;  // Hot
  if (r > 0.3) return 1;  // Warm
  if (r > 0.1) return 2;  // Cold
  return 3;                // Stale
}
```

For R = 0.7168: > 0.7, so tier = **0 (Hot)**.

Without the access boost, R would have been 0.408 → tier = 1 (Warm). The accesses promoted this memory from Warm to Hot.

---

## Step 5 — Write Back (Conditionally)

```ts
const currentR = payload.retentionScore ?? salience;
const currentTier = payload.tier ?? 0;

if (Math.abs(newR - currentR) < 0.001 && newTier === currentTier) {
  return null;  // skip the write — nothing materially changed
}

return { retentionScore: newR, tier: newTier };
```

If R or tier moved meaningfully, write to Qdrant. Otherwise skip (saves bandwidth — many chunks won't change much night-over-night).

---

## The Whole Computation in One Block

Here's the actual function, slightly simplified:

```ts
function computeRetention(payload, nowMs) {
  const salience = payload.salience;
  if (salience === undefined || !payload.tCommit) return null;  // skip pre-Phase-4 chunks

  // DECAY: uses tCommit only
  const dtDays = (nowMs - new Date(payload.tCommit).getTime()) / DAY_MS;
  const decay = salience * Math.exp(-LAMBDA * dtDays);

  // REINFORCEMENT: sums over each access in accessTimestamps[]
  const accessTimestamps = payload.accessTimestamps ?? [];
  const reinforcement = accessTimestamps.reduce((sum, ts) => {
    const ageDays = Math.max((nowMs - new Date(ts).getTime()) / DAY_MS, 1.0);
    return sum + 1 / ageDays;
  }, 0) * SIGMA;

  // COMBINE and clamp
  const newR = Math.min(decay + reinforcement, 1.0);
  const newTier = computeTier(newR);

  // Skip if no material change
  if (sameAsBefore(newR, newTier, payload)) return null;
  return { retentionScore: newR, tier: newTier };
}
```

Three subtractions, one exponential, one sum, one min. That's all of Phase 4's math.

---

## Side-by-Side: What Each Timestamp Drives

| Timestamp | Used in | Operation | Effect |
|---|---|---|---|
| `tCommit` (birth) | Decay term | `(now - tCommit) / DAY_MS` → fed into `e^(-λ × age)` | The memory's baseline floor decreases as age grows |
| `accessTimestamps[i]` (each retrieval) | Reinforcement term | `(now - access_i) / DAY_MS` → fed into `1 / age`, summed, then × σ | Each access adds a boost weighted by recency |

Birth timestamp is one number, used once per recompute. Access timestamps are an array, processed in a loop, with each contributing independently.

---

## What Makes Some Accesses "Worth More" Than Others

Because of the `1/age` shape:

| Access age (days) | Contribution to sum (before σ) | After σ=0.2 |
|---|---|---|
| 1 (today, floored) | 1.000 | 0.200 |
| 2 | 0.500 | 0.100 |
| 5 | 0.200 | 0.040 |
| 10 | 0.100 | 0.020 |
| 30 | 0.033 | 0.007 |
| 90 | 0.011 | 0.002 |

So **two accesses today** contribute `2 × 0.2 = 0.4` to retention — more than **a hundred accesses 90 days ago** (`100 × 0.002 = 0.2`).

This is what makes recent activity dominant. The system "knows" a memory is currently relevant because of *recent* access density, not lifetime access count.

---

## TL;DR

For each chunk on the nightly recompute:

1. **Decay** = `salience × e^(-LAMBDA × ((now - tCommit) / DAY_MS))`. One subtraction. Drops monotonically as time passes.
2. **Reinforcement** = `SIGMA × Σ over accessTimestamps: 1 / max((now - that_access) / DAY_MS, 1.0)`. One subtraction per access. Each access contributes more if recent.
3. **R** = `min(decay + reinforcement, 1.0)`. The two are simply summed, then clamped.
4. **Tier** = mapped from R via fixed thresholds.

Both terms compute from timestamp subtraction. Decay uses ONE timestamp (birth). Reinforcement uses MANY (all accesses). They're independent — neither modifies the other. The net retention is just their sum, capped at 1.
