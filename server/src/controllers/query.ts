import type { Context } from 'hono';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import openai from '../utils/openai';
import { qdrant, COLLECTION } from '../utils/qdrant';
import { toSparseVector } from '../utils/sparse';
import { driver } from '../utils/neo4j';
import {
  recordAccessQueue,
  RECORD_ACCESS_QUEUE,
} from '../queue/record-access';

const N_EXPANSIONS = 3;
const PREFETCH_LIMIT = 30;
const FINAL_TOP_K = 10;
const GRAPH_PATH_LIMIT = 50;
const EXPANSION_PER_CHUNK_LIMIT = 10;
// Paper's variable-length traversal: P_graph = Path(E_start →*1..n E_end)
const GRAPH_MAX_DEPTH = 2;
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Paper's Stage 2A weighted formula:
// S_retrieval(q, c) = x · sim(content) + y · sim(latent) + α · BM25(sparse)
// Scores are min-max normalised per-stream before weighting so the weights are meaningful.
const WEIGHT_CONTENT = 0.4; // x
const WEIGHT_LATENT = 0.4; // y
const WEIGHT_SPARSE = 0.2; // α

// Paper's Stage 4 triple-tier rerank:
// S_rerank^vs(c) = γ · S_semantic(c) + (1-γ) · S_lexical(c)
// S_final^vs(c) = β · S_vs(c) + (1-β) · S_rerank^vs(c)
const GAMMA = 0.7; // semantic vs lexical weight in S_rerank^vs
const BETA = 0.3; // vector-confidence vs rerank weight in S_final^vs

// Paper's Stage 5 fusion: TopK_1(vector ⊕ expansion) ∪ TopK_2(graph)
const K1 = 6; // vector + expansion stream
const K2 = 6; // entity-based graph stream

const expansionSchema = z.object({
  expansions: z.array(z.string()).min(N_EXPANSIONS).max(N_EXPANSIONS),
});

const queryEntitiesSchema = z.object({
  entities: z.array(z.string()).max(5),
});

const answerSchema = z.object({
  reasoning: z.string(),
  answer: z.string(),
  citedMemoryNumbers: z.array(z.number().int().min(1)),
});

const EXPANSION_PROMPT = `You are an expert at rewriting user queries to maximize retrieval recall from a memory system.

Given a user's question, produce exactly ${N_EXPANSIONS} alternative phrasings that preserve the intent but vary in surface form. Each expansion should attack the question from a slightly different angle so that vector search has multiple chances to match relevant memories.

Rules:
- Each expansion is a complete sentence or question.
- Vary word choice, specificity, and perspective — not just trivial synonym swaps.
- Keep the same semantic intent. Do not drift, add new meaning, or change scope.
- Do not repeat the original query verbatim.`;

const ENTITY_EXTRACTION_PROMPT = `Extract proper-noun named entities from the user's query.

Rules:
- Return canonical names matching how they'd appear in a knowledge graph (Title Case for people and places, lowercase for general concepts).
- Only extract specific named entities (e.g., "Karthik", "Mumbai", "Stripe"), NOT generic concepts (e.g., "drink", "thing", "house").
- Possessive pronouns ("my", "your") and generic referents do not extract.
- If the query refers to a person by pronoun only (no name), return an empty array.
- Maximum 5 entities.`;

const ANSWER_SYSTEM_PROMPT = `You are a personal memory assistant. You answer the user's question using ONLY the provided memory context.

The context contains two streams:

1. **Memories** — relevant chunks from the user's conversation history. Each memory has:
   - Original: what the user originally said.
   - Resolved: the same statement rewritten with pronouns and references made explicit.
   - Ingested: the timestamp when the system learned this fact.
   - Related facts: structured relationships from the knowledge graph adjacent to this memory.

2. **Structured facts** — relationships from the user's knowledge graph, often with sentiment, t_valid (real-world time the fact is true), t_commit (when ingested), and reasoning.

Rules:
- Answer based ONLY on the provided context. If the context doesn't contain enough information, say "I don't know" or "I don't have enough information."
- Be direct and factual. No fluff.
- Do not invent facts. Do not assume things not stated.
- For temporal queries, use t_valid for "when in real world" questions and t_commit for "when did you tell me" questions.
- Cite the underlying memory or fact when it directly supports your answer.

## Memory freshness — Status and Retention metadata (informational only)

Each memory has metadata signaling how vivid it is in the system:
- Hot (Retention > 0.7) — recently mentioned or frequently reinforced.
- Warm (0.3–0.7) — established, not recently reinforced.
- Cold (0.1–0.3) — old, not actively reinforced for a long time.
- Stale (≤ 0.1) — very old.

IMPORTANT: Retention encodes how often a memory has been mentioned or retrieved — it is NOT a signal of truth. A Hot memory can be stale truth; a Warm memory can be current truth. Never use Retention to resolve a contradiction; use the precedence ladder below.

## Resolving conflicting facts — precedence order

When two memories contradict, resolve in this exact order. Higher rules beat lower ones absolutely.

1. **Explicit supersession wins.** If one memory describes a transition that obsoletes another — verbs like "moved", "switched", "changed", "left", "stopped", "no longer", "now instead", "used to" — the transition memory is the current truth. The superseded memory becomes historical. Retention is irrelevant here.

2. **Real-world time (t_valid) wins next.** Among graph facts with a t_valid field, the one whose t_valid is most recent (and ≤ today) is the current state.

3. **Ingestion time (t_commit) wins next.** When t_valid is missing or identical, the most recently ingested memory is the current state.

4. **Retention is a tie-breaker only.** Use Status/Retention to choose between memories that are temporally equivalent under rules 1–3.

## How to phrase

- Memories that lost the contradiction become historical — frame with "previously", "used to", "before X". Never present as current.
- A Stale memory is not necessarily wrong; just don't present it as current. Acknowledge uncertainty: "Based on something you told me a while ago…"
- If the user explicitly asks about the past, historical memories become MORE relevant, not less.

## Citations (REQUIRED)

After answering, populate \`citedMemoryNumbers\` with the 1-based numbers of the memories that DIRECTLY informed your answer (e.g., if Memory 1 and Memory 3 supported your conclusion, return [1, 3]). Do NOT include memories you read but chose not to use. Be honest — citing more memories does NOT improve your answer. Citing incorrectly skews the system's long-term retention model and degrades future answers. If you answered "I don't know", return an empty array.

Output JSON with:
- reasoning: step-by-step thinking about the question and which parts of the context apply.
- answer: the final direct answer to the user's question.
- citedMemoryNumbers: 1-based integer array of memories that directly informed the answer.`;

type Candidate = {
  chunkId: string;
  score: number; // S_vs from Stage 2A weighted formula
  rawText: string;
  enrichedText: string;
  entityRefs: string[];
  tCommit: string;
  expansion: GraphPath[];
  // Phase 4 — decay engine fields surfaced from Qdrant payload
  retentionScore: number;
  tier: number;
};

type GraphPath = {
  fromName: string;
  relation: string;
  toName: string;
  sentiment: string | null;
  tValid: string | null;
  tCommit: string;
  reasoning: string | null;
  context: string | null;
  contextString: string;
  hops: number;
  score: number; // S_graph(p) or S_expansion(p) after rerank
};

async function expandQuery(originalQuery: string): Promise<string[]> {
  const result = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: EXPANSION_PROMPT },
      { role: 'user', content: `Original query: ${originalQuery}` },
    ],
    response_format: zodResponseFormat(expansionSchema, 'query_expansion'),
  });

  const parsed = result.choices[0]?.message.parsed;
  if (!parsed) throw new Error('Failed to parse expansion');
  return parsed.expansions;
}

async function extractQueryEntities(originalQuery: string): Promise<string[]> {
  const result = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
      { role: 'user', content: `Query: ${originalQuery}` },
    ],
    response_format: zodResponseFormat(queryEntitiesSchema, 'query_entities'),
  });

  const parsed = result.choices[0]?.message.parsed;
  if (!parsed) throw new Error('Failed to parse query entities');
  return parsed.entities;
}

type RawHit = {
  chunkId: string;
  score: number;
  payload: Record<string, unknown>;
};

async function searchOneVector(
  vector: number[] | { indices: number[]; values: number[] },
  using: 'content' | 'latent' | 'sparse',
  filter: { must: Array<{ key: string; match: { value: string } }> }
): Promise<RawHit[]> {
  const result = await qdrant.query(COLLECTION, {
    query: vector,
    using,
    limit: PREFETCH_LIMIT,
    filter,
    with_payload: true,
  });

  return (result.points ?? []).map((p) => ({
    chunkId: p.id as string,
    score: p.score ?? 0,
    payload: (p.payload ?? {}) as Record<string, unknown>,
  }));
}

function normalizeScores(hits: RawHit[]): Map<string, number> {
  if (hits.length === 0) return new Map();
  const scores = hits.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  const out = new Map<string, number>();
  for (const h of hits) {
    out.set(h.chunkId, range === 0 ? 1 : (h.score - min) / range);
  }
  return out;
}

async function hybridVectorSearch(
  queries: string[],
  userId: string
): Promise<Candidate[]> {
  const embedRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: queries,
  });

  const filter = {
    must: [{ key: 'userId', match: { value: userId } }],
  };

  const merged = new Map<string, Candidate>();

  for (let i = 0; i < queries.length; i++) {
    const denseVec = embedRes.data[i].embedding;
    const sparseVec = toSparseVector(queries[i]);

    // Three parallel sub-searches against the three named vectors, each returning raw scores
    const [contentHits, latentHits, sparseHits] = await Promise.all([
      searchOneVector(denseVec, 'content', filter),
      searchOneVector(denseVec, 'latent', filter),
      searchOneVector(sparseVec, 'sparse', filter),
    ]);

    // Min-max normalise each stream so weights are meaningful across heterogeneous score ranges
    const contentNorm = normalizeScores(contentHits);
    const latentNorm = normalizeScores(latentHits);
    const sparseNorm = normalizeScores(sparseHits);

    // Union of chunkIds touched by any of the three streams + carry forward each chunk's payload
    const payloads = new Map<string, Record<string, unknown>>();
    for (const h of [...contentHits, ...latentHits, ...sparseHits]) {
      if (!payloads.has(h.chunkId)) payloads.set(h.chunkId, h.payload);
    }

    // Apply the paper's weighted formula. Missing-from-stream defaults to 0 (chunk wasn't relevant there).
    for (const [chunkId, payload] of Array.from(payloads.entries())) {
      const cs = contentNorm.get(chunkId) ?? 0;
      const ls = latentNorm.get(chunkId) ?? 0;
      const ss = sparseNorm.get(chunkId) ?? 0;
      const score =
        WEIGHT_CONTENT * cs + WEIGHT_LATENT * ls + WEIGHT_SPARSE * ss;

      const existing = merged.get(chunkId);
      if (!existing || existing.score < score) {
        merged.set(chunkId, {
          chunkId,
          score,
          rawText: (payload.rawText as string) ?? '',
          enrichedText: (payload.enrichedText as string) ?? '',
          entityRefs: (payload.entityRefs as string[]) ?? [],
          tCommit: (payload.tCommit as string) ?? '',
          expansion: [],
          // Phase 4 — fall back to Hot/full-retention for pre-Phase-4 chunks
          retentionScore: (payload.retentionScore as number) ?? 1,
          tier: (payload.tier as number) ?? 0,
        });
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, FINAL_TOP_K);
}

type Neo4jNode = { identity: number; properties: Record<string, unknown> };
type Neo4jRel = {
  identity: number;
  start: number;
  end: number;
  type: string;
  properties: Record<string, unknown>;
};
type Neo4jSegment = { start: Neo4jNode; end: Neo4jNode; relationship: Neo4jRel };
type Neo4jPath = { segments: Neo4jSegment[] };

function formatHop(
  fromName: string,
  toName: string,
  props: Record<string, unknown>
): string {
  const meta: string[] = [];
  if (props.sentiment) meta.push(`sentiment=${props.sentiment}`);
  if (props.t_valid) meta.push(`t_valid=${props.t_valid}`);
  meta.push(`t_commit=${props.t_commit}`);
  if (props.reasoning) meta.push(`reasoning="${props.reasoning}"`);
  if (props.context) meta.push(`context="${props.context}"`);
  return `${fromName} ${props.type} ${toName} (${meta.join(', ')})`;
}

function pathToGraphPath(path: Neo4jPath): GraphPath | null {
  const segments = path.segments;
  if (!segments || segments.length === 0) return null;

  const hopStrings: string[] = [];
  const tCommits: string[] = [];

  let firstFromName = '';
  let lastToName = '';
  let firstProps: Record<string, unknown> = {};

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Resolve stored direction (segment.start/end is traversal order, may be reversed)
    const traversedForward = seg.start.identity === seg.relationship.start;
    const fromNode = traversedForward ? seg.start : seg.end;
    const toNode = traversedForward ? seg.end : seg.start;
    const fromName = fromNode.properties.name as string;
    const toName = toNode.properties.name as string;

    hopStrings.push(formatHop(fromName, toName, seg.relationship.properties));
    tCommits.push(seg.relationship.properties.t_commit as string);

    if (i === 0) {
      firstFromName = fromName;
      firstProps = seg.relationship.properties;
    }
    if (i === segments.length - 1) {
      lastToName = toName;
    }
  }

  const newestTCommit = tCommits.sort().reverse()[0];

  return {
    fromName: firstFromName,
    relation: firstProps.type as string,
    toName: lastToName,
    sentiment: (firstProps.sentiment as string | null) ?? null,
    tValid: (firstProps.t_valid as string | null) ?? null,
    tCommit: newestTCommit,
    reasoning: (firstProps.reasoning as string | null) ?? null,
    context: (firstProps.context as string | null) ?? null,
    contextString: hopStrings.join(' → '),
    hops: segments.length,
    score: 0,
  };
}

async function graphSearch(
  entities: string[],
  userId: string
): Promise<GraphPath[]> {
  if (entities.length === 0) return [];

  const session = driver.session();
  const paths: GraphPath[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `UNWIND $names AS name
         MATCH p = (start:Entity {userId: $userId, name: name})-[:RELATION*1..${GRAPH_MAX_DEPTH}]-(other:Entity)
         WHERE all(n IN nodes(p) WHERE n.userId = $userId)
         RETURN p AS path
         LIMIT 200`,
        { names: entities, userId }
      )
    );

    const seen = new Set<string>();

    for (const rec of result.records) {
      const rawPath = rec.get('path') as Neo4jPath;
      const segments = rawPath.segments ?? [];
      if (segments.length === 0) continue;

      const edgeIds = segments.map(
        (s) => s.relationship.properties.edge_id as string
      );
      const pathKey = edgeIds.join('|');
      if (seen.has(pathKey)) continue;
      seen.add(pathKey);

      const gp = pathToGraphPath(rawPath);
      if (gp) paths.push(gp);
    }
  } finally {
    await session.close();
  }

  // Sort by newest first (no reranker → temporal recency is the only signal)
  paths.sort((a, b) => b.tCommit.localeCompare(a.tCommit));
  return paths.slice(0, GRAPH_PATH_LIMIT);
}

async function chunkLevelExpansion(
  candidates: Candidate[],
  userId: string
): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;

  // Collect unique entity names across all candidates' pre-linked refs
  const allEntities = new Set<string>();
  for (const c of candidates) {
    for (const e of c.entityRefs) allEntities.add(e);
  }
  if (allEntities.size === 0) return candidates;

  // Paper Section 2.6.4: N(c) = union over e in E(c) of Path(e →*1..n)
  // Variable-length traversal, user-scoped on every node
  const session = driver.session();
  let records;
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `UNWIND $names AS name
         MATCH p = (start:Entity {userId: $userId, name: name})-[:RELATION*1..${GRAPH_MAX_DEPTH}]-(other:Entity)
         WHERE all(n IN nodes(p) WHERE n.userId = $userId)
         RETURN name AS startName, p AS path
         LIMIT 500`,
        { names: Array.from(allEntities), userId }
      )
    );
    records = result.records;
  } finally {
    await session.close();
  }

  // Group paths by source entity name, deduping by path identity per entity
  const entityToPaths = new Map<string, GraphPath[]>();
  const seenPerEntity = new Map<string, Set<string>>();

  for (const rec of records) {
    const startName = rec.get('startName') as string;
    const rawPath = rec.get('path') as Neo4jPath;
    const segments = rawPath.segments ?? [];
    if (segments.length === 0) continue;

    const edgeIds = segments.map(
      (s) => s.relationship.properties.edge_id as string
    );
    const pathKey = edgeIds.join('|');

    if (!seenPerEntity.has(startName)) seenPerEntity.set(startName, new Set());
    if (seenPerEntity.get(startName)!.has(pathKey)) continue;
    seenPerEntity.get(startName)!.add(pathKey);

    const gp = pathToGraphPath(rawPath);
    if (!gp) continue;

    if (!entityToPaths.has(startName)) entityToPaths.set(startName, []);
    entityToPaths.get(startName)!.push(gp);
  }

  // Attach paths to each candidate, dedup across this candidate's entityRefs
  return candidates.map((cand) => {
    const seenEdgeChains = new Set<string>();
    const expansion: GraphPath[] = [];

    for (const entity of cand.entityRefs) {
      const paths = entityToPaths.get(entity) ?? [];
      for (const p of paths) {
        if (seenEdgeChains.has(p.contextString)) continue;
        seenEdgeChains.add(p.contextString);
        expansion.push(p);
        if (expansion.length >= EXPANSION_PER_CHUNK_LIMIT) break;
      }
      if (expansion.length >= EXPANSION_PER_CHUNK_LIMIT) break;
    }

    // Sort by newest first (no reranker)
    expansion.sort((a, b) => b.tCommit.localeCompare(a.tCommit));

    return { ...cand, expansion };
  });
}

function tierName(tier: number): string {
  return ['Hot', 'Warm', 'Cold', 'Stale'][tier] ?? 'Hot';
}

// Paper's Stage 6 — Context Assembly + Final Generation
function formatContextForLLM(
  candidates: Candidate[],
  graphPaths: GraphPath[]
): string {
  const sections: string[] = [];

  if (candidates.length > 0) {
    sections.push('## Memories');
    candidates.forEach((c, i) => {
      sections.push(`### Memory ${i + 1}`);
      sections.push(`- Original: ${c.rawText}`);
      sections.push(`- Resolved: ${c.enrichedText}`);
      sections.push(`- Ingested: ${c.tCommit}`);
      sections.push(`- Status: ${tierName(c.tier)}`);
      sections.push(`- Retention: ${c.retentionScore.toFixed(2)}`);
      if (c.expansion.length > 0) {
        sections.push(`- Related facts:`);
        for (const p of c.expansion) {
          sections.push(`    • ${p.contextString}`);
        }
      }
      sections.push('');
    });
  }

  if (graphPaths.length > 0) {
    sections.push('## Structured facts (knowledge graph)');
    graphPaths.forEach((p, i) => {
      sections.push(`${i + 1}. ${p.contextString}`);
    });
  }

  return sections.join('\n');
}

async function generateAnswer(
  query: string,
  context: string,
  questionDate: string
): Promise<{ reasoning: string; answer: string; citedMemoryNumbers: number[] }> {
  const userPrompt = `Question: ${query}
Question Date: ${questionDate}

Context:
${context}`;

  const result = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: zodResponseFormat(answerSchema, 'memory_answer'),
  });

  const parsed = result.choices[0]?.message.parsed;
  if (!parsed) throw new Error('Failed to parse answer');
  return parsed;
}

// Paper's Stage 5 — Fusion
// C_final = TopK_1(C_vs^final ⊕ C_expansion, k_1) ∪ TopK_2(C_graph, k_2)
function fusion(
  vectorCandidates: Candidate[],
  graphPaths: GraphPath[]
): { vectorTop: Candidate[]; graphTop: GraphPath[] } {
  const vectorSorted = [...vectorCandidates].sort((a, b) => b.score - a.score);
  const graphSorted = [...graphPaths].sort((a, b) => b.score - a.score);
  return {
    vectorTop: vectorSorted.slice(0, K1),
    graphTop: graphSorted.slice(0, K2),
  };
}

export async function query(c: Context) {
  const userId = c.get('userId') as string;

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json({ error: 'query must be a non-empty string' }, 400);
  }

  const originalQuery = body.query.trim();

  // R1 — Adaptive query expansion
  // R3 — Entity extraction (runs in parallel)
  const [expansions, queryEntities] = await Promise.all([
    expandQuery(originalQuery),
    extractQueryEntities(originalQuery),
  ]);

  console.log(`[query] userId=${userId}`);
  console.log(`[query] original:     ${originalQuery}`);
  console.log(`[query] expansions:`);
  expansions.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
  console.log(`[query] queryEntities: ${JSON.stringify(queryEntities)}`);

  // Stage 2A (vector hybrid) + Stage 2B (graph entity-based) in parallel
  const allQueries = [originalQuery, ...expansions];
  const [rawCandidates, graphPaths] = await Promise.all([
    hybridVectorSearch(allQueries, userId),
    graphSearch(queryEntities, userId),
  ]);

  // Stage 3: chunk-level expansion
  const candidates = await chunkLevelExpansion(rawCandidates, userId);

  // Stage 5: fusion (no reranker → ranking driven by S_vs for vectors, t_commit for graph)
  const { vectorTop, graphTop } = fusion(candidates, graphPaths);

  console.log(`[query] final vector candidates (${vectorTop.length}):`);
  vectorTop.forEach((cand, i) => {
    console.log(
      `   ${i + 1}. S_vs=${cand.score.toFixed(4)} chunkId=${cand.chunkId.slice(0, 8)} expansion=${cand.expansion.length}`
    );
    console.log(`      raw: ${cand.rawText.slice(0, 80)}`);
  });

  console.log(`[query] final graph paths (${graphTop.length}):`);
  graphTop.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.contextString.slice(0, 120)}`);
  });

  // Stage 6: assemble context + generate final answer
  const questionDate = new Date().toISOString().split('T')[0];
  const contextText = formatContextForLLM(vectorTop, graphTop);
  const { reasoning, answer, citedMemoryNumbers } = await generateAnswer(
    originalQuery,
    contextText,
    questionDate
  );

  console.log(`[query] reasoning: ${reasoning.slice(0, 200)}${reasoning.length > 200 ? '...' : ''}`);
  console.log(`[query] answer:    ${answer}`);
  console.log(`[query] cited memories: ${JSON.stringify(citedMemoryNumbers)}`);

  // Phase 4 — fire-and-forget access logging — ONLY for memories the LLM
  // actually cited. Surfaced-but-unused memories don't get reinforced.
  // This defends against reinforcement grooming and makes retention track
  // "memories that actually answered questions" rather than "memories that
  // appeared in retrieval".
  const citedChunkIds = citedMemoryNumbers
    .map((n) => vectorTop[n - 1]?.chunkId)
    .filter((id): id is string => typeof id === 'string');

  if (citedChunkIds.length > 0) {
    recordAccessQueue
      .add(RECORD_ACCESS_QUEUE, {
        chunkIds: citedChunkIds,
        accessTime: new Date().toISOString(),
      })
      .catch((err) =>
        console.error('[query] failed to enqueue access record:', err)
      );
  }

  return c.json({
    originalQuery,
    answer,
    reasoning,
    expansions,
    queryEntities,
    candidates: vectorTop,
    graphPaths: graphTop,
    citedMemoryNumbers,
  });
}
