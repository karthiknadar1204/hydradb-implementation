import type { Context } from 'hono';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import openai from '../utils/openai';
import { qdrant, COLLECTION } from '../utils/qdrant';
import { toSparseVector } from '../utils/sparse';
import { driver } from '../utils/neo4j';

const N_EXPANSIONS = 3;
const PREFETCH_LIMIT = 30;
const FINAL_TOP_K = 10;
const GRAPH_PATH_LIMIT = 50;
const EMBEDDING_MODEL = 'text-embedding-3-small';

const expansionSchema = z.object({
  expansions: z.array(z.string()).min(N_EXPANSIONS).max(N_EXPANSIONS),
});

const queryEntitiesSchema = z.object({
  entities: z.array(z.string()).max(5),
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

type Candidate = {
  chunkId: string;
  score: number;
  rawText: string;
  enrichedText: string;
  entityRefs: string[];
  tCommit: string;
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

    let result;
    try {
      result = await qdrant.query(COLLECTION, {
        prefetch: [
          { query: denseVec, using: 'content', limit: PREFETCH_LIMIT, filter },
          { query: denseVec, using: 'latent', limit: PREFETCH_LIMIT, filter },
          { query: sparseVec, using: 'sparse', limit: PREFETCH_LIMIT, filter },
        ],
        query: { fusion: 'rrf' },
        limit: FINAL_TOP_K,
        with_payload: true,
      });
    } catch (err: unknown) {
      const e = err as { data?: unknown };
      console.error(`[hybrid] q${i} failed:`, JSON.stringify(e.data, null, 2));
      throw err;
    }

    for (const point of result.points ?? []) {
      const id = point.id as string;
      const score = point.score ?? 0;
      const payload = (point.payload ?? {}) as Record<string, unknown>;

      const existing = merged.get(id);
      if (!existing || existing.score < score) {
        merged.set(id, {
          chunkId: id,
          score,
          rawText: (payload.rawText as string) ?? '',
          enrichedText: (payload.enrichedText as string) ?? '',
          entityRefs: (payload.entityRefs as string[]) ?? [],
          tCommit: (payload.tCommit as string) ?? '',
        });
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, FINAL_TOP_K);
}

async function graphSearch(
  entities: string[],
  userId: string
): Promise<GraphPath[]> {
  if (entities.length === 0) return [];

  const session = driver.session();
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `UNWIND $names AS name
         MATCH (start:Entity {userId: $userId, name: name})-[r:RELATION]-(other:Entity {userId: $userId})
         RETURN
           startNode(r).name AS fromName,
           r.type         AS relType,
           endNode(r).name   AS toName,
           r.sentiment    AS sentiment,
           r.t_valid      AS tValid,
           r.t_commit     AS tCommit,
           r.reasoning    AS reasoning,
           r.context      AS context,
           r.edge_id      AS edgeId
         ORDER BY r.t_commit DESC
         LIMIT 50`,
        { names: entities, userId }
      )
    );

    // Dedup by edge_id (same edge can appear twice if query mentions both endpoints)
    const seen = new Set<string>();
    const paths: GraphPath[] = [];

    for (const rec of result.records) {
      const edgeId = rec.get('edgeId') as string;
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);

      const fromName = rec.get('fromName') as string;
      const relation = rec.get('relType') as string;
      const toName = rec.get('toName') as string;
      const sentiment = rec.get('sentiment') as string | null;
      const tValid = rec.get('tValid') as string | null;
      const tCommit = rec.get('tCommit') as string;
      const reasoning = rec.get('reasoning') as string | null;
      const context = rec.get('context') as string | null;

      const meta: string[] = [];
      if (sentiment) meta.push(`sentiment=${sentiment}`);
      if (tValid) meta.push(`t_valid=${tValid}`);
      meta.push(`t_commit=${tCommit}`);
      if (reasoning) meta.push(`reasoning="${reasoning}"`);
      if (context) meta.push(`context="${context}"`);

      const contextString = `${fromName} ${relation} ${toName} (${meta.join(', ')})`;

      paths.push({
        fromName,
        relation,
        toName,
        sentiment,
        tValid,
        tCommit,
        reasoning,
        context,
        contextString,
      });

      if (paths.length >= GRAPH_PATH_LIMIT) break;
    }

    return paths;
  } finally {
    await session.close();
  }
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

  // R2 — Weighted hybrid vector search
  // R3 — Graph entity-based search (runs in parallel)
  const allQueries = [originalQuery, ...expansions];
  const [candidates, graphPaths] = await Promise.all([
    hybridVectorSearch(allQueries, userId),
    graphSearch(queryEntities, userId),
  ]);

  console.log(`[query] vector candidates (${candidates.length}):`);
  candidates.forEach((cand, i) => {
    console.log(
      `   ${i + 1}. score=${cand.score.toFixed(4)} chunkId=${cand.chunkId.slice(0, 8)}`
    );
    console.log(`      raw:      ${cand.rawText.slice(0, 80)}`);
  });

  console.log(`[query] graph paths (${graphPaths.length}):`);
  graphPaths.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.contextString}`);
  });

  return c.json({
    originalQuery,
    expansions,
    queryEntities,
    candidates,
    graphPaths,
  });
}
