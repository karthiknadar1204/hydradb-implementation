import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  RETENTION_QUEUE,
  retentionQueue,
  type RetentionJob,
} from '../queue/retention';
import { qdrant, COLLECTION } from '../utils/qdrant';

const connection = createWorkerConnection();

// Tunable retention dynamics
const LAMBDA = 0.05; // decay rate per day — lower = slower forgetting
const SIGMA = 0.2; // reinforcement strength — higher = bigger access boost

function computeTier(r: number): number {
  if (r > 0.7) return 0; // Hot
  if (r > 0.3) return 1; // Warm
  if (r > 0.1) return 2; // Cold
  return 3; // Stale
}

type PointPayload = {
  salience?: number;
  tCommit?: string;
  accessTimestamps?: string[];
  retentionScore?: number;
  tier?: number;
};

function computeRetention(
  payload: PointPayload,
  nowMs: number
): { retentionScore: number; tier: number } | null {
  const salience = payload.salience;
  if (salience === undefined || !payload.tCommit) return null;

  const tCommitMs = new Date(payload.tCommit).getTime();
  const dtDays = (nowMs - tCommitMs) / (1000 * 60 * 60 * 24);

  // R(m, t) = I_salience · e^(-λΔt) + σ · Σ(1 / (t - t_access_i))
  const decay = salience * Math.exp(-LAMBDA * dtDays);

  // Reinforcement: floor age at 1 day so each access contributes at most σ.
  // Without this floor, recent access (seconds ago) sends 1/age → ∞ and breaks
  // the bounded retention range that tiers depend on.
  const accessTimestamps = payload.accessTimestamps ?? [];
  const reinforcement =
    accessTimestamps.reduce((sum, ts) => {
      const ageDays = Math.max(
        (nowMs - new Date(ts).getTime()) / (1000 * 60 * 60 * 24),
        1.0
      );
      return sum + 1 / ageDays;
    }, 0) * SIGMA;

  // Clamp R to [0, 1] so tier mapping is meaningful and stable.
  const newR = Math.min(decay + reinforcement, 1.0);
  const newTier = computeTier(newR);

  const currentR = payload.retentionScore ?? salience;
  const currentTier = payload.tier ?? 0;
  if (Math.abs(newR - currentR) < 0.001 && newTier === currentTier) {
    return null;
  }

  return { retentionScore: newR, tier: newTier };
}

async function handler(job: Job<RetentionJob>) {
  console.log(
    `[${RETENTION_QUEUE}] starting recompute (reason: ${job.data.reason ?? 'scheduled'})`
  );
  const nowMs = Date.now();

  let offset: string | number | Record<string, unknown> | undefined =
    undefined;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const result = await qdrant.scroll(COLLECTION, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });

    if (!result.points || result.points.length === 0) break;

    for (const point of result.points) {
      scanned++;
      const updates = computeRetention(point.payload as PointPayload, nowMs);
      if (updates) {
        await qdrant.setPayload(COLLECTION, {
          points: [point.id as string],
          payload: updates,
        });
        updated++;
      }
    }

    offset = result.next_page_offset ?? undefined;
    if (!offset) break;
  }

  console.log(
    `[${RETENTION_QUEUE}] done — scanned=${scanned} updated=${updated}`
  );
}

export const retentionWorker = new Worker<RetentionJob>(
  RETENTION_QUEUE,
  handler,
  { connection, concurrency: 1 } // singleton — only one recompute at a time
);

retentionWorker.on('failed', (job, err) => {
  console.error(`[${RETENTION_QUEUE}] job ${job?.id} failed:`, err);
});

retentionWorker.on('error', (err) => {
  console.error(`[${RETENTION_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${RETENTION_QUEUE}] shutting down...`);
  await retentionWorker.close();
  await connection.quit();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Phase 4 — register the nightly recompute as a repeatable job.
// Idempotent via fixed jobId; safe to call on every startup.
async function scheduleDailyRecompute() {
  try {
    await retentionQueue.add(
      'daily-retention-recompute',
      { reason: 'scheduled' },
      {
        repeat: { pattern: '0 3 * * *' },
        jobId: 'retention-daily',
      }
    );
    console.log(
      `[${RETENTION_QUEUE}] daily recompute scheduled (cron: 0 3 * * *)`
    );
  } catch (err) {
    console.error(
      `[${RETENTION_QUEUE}] failed to schedule daily job:`,
      err
    );
  }
}

scheduleDailyRecompute();

console.log(`[${RETENTION_QUEUE}] worker started (concurrency=1)`);
