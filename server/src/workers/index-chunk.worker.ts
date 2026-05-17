import { Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { createWorkerConnection } from './connection';
import {
  INDEX_CHUNK_QUEUE,
  type IndexChunkJob,
  type Entity,
  type Relation,
} from '../queue/index-chunk';
import openai from '../utils/openai';
import { qdrant, COLLECTION } from '../utils/qdrant';
import { toSparseVector } from '../utils/sparse';
import { driver } from '../utils/neo4j';

const connection = createWorkerConnection();
const EMBEDDING_MODEL = 'text-embedding-3-small';

function edgeId(
  from: string,
  relation: string,
  to: string,
  tCommit: string
): string {
  return createHash('sha256')
    .update(`${from}|${relation}|${to}|${tCommit}`)
    .digest('hex');
}

async function writeToNeo4j(
  entities: Entity[],
  relations: Relation[],
  tCommit: string
): Promise<{ entityCount: number; edgeCount: number }> {
  // Build complete entity set; backfill any entity referenced only in relations
  const allEntities = new Map<string, string>();
  for (const e of entities) {
    allEntities.set(e.name, e.type);
  }
  for (const r of relations) {
    if (!allEntities.has(r.from)) allEntities.set(r.from, 'Unknown');
    if (!allEntities.has(r.to)) allEntities.set(r.to, 'Unknown');
  }

  const entityList = Array.from(allEntities.entries()).map(([name, type]) => ({
    name,
    type,
  }));

  const edgeParams = relations.map((r) => ({
    from: r.from,
    to: r.to,
    edge_id: edgeId(r.from, r.relation, r.to, tCommit),
    type: r.relation,
    t_commit: tCommit,
    t_valid: r.tValid,
    sentiment: r.cMeta.sentiment,
    reasoning: r.cMeta.reasoning,
    context: r.cMeta.context,
  }));

  const session = driver.session();
  try {
    if (entityList.length > 0) {
      await session.run(
        `UNWIND $entities AS entity
         MERGE (e:Entity {name: entity.name})
         SET e.type = entity.type`,
        { entities: entityList }
      );
    }

    if (edgeParams.length > 0) {
      await session.run(
        `UNWIND $edges AS edge
         MATCH (a:Entity {name: edge.from})
         MATCH (b:Entity {name: edge.to})
         MERGE (a)-[r:RELATION {edge_id: edge.edge_id}]->(b)
         ON CREATE SET
           r.type = edge.type,
           r.t_commit = edge.t_commit,
           r.t_valid = edge.t_valid,
           r.sentiment = edge.sentiment,
           r.reasoning = edge.reasoning,
           r.context = edge.context`,
        { edges: edgeParams }
      );
    }
  } finally {
    await session.close();
  }

  return { entityCount: entityList.length, edgeCount: edgeParams.length };
}

async function handler(job: Job<IndexChunkJob>) {
  const {
    sessionId,
    userId,
    chunkId,
    rawText,
    enrichedText,
    entities,
    relations,
    tCommit,
  } = job.data;

  console.log(`[${INDEX_CHUNK_QUEUE}] job ${job.id}`, {
    chunkId,
    entities: entities.length,
    relations: relations.length,
  });

  // 3.1 + 3.2: dense embeddings (one round-trip for both)
  const embedRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: [rawText, enrichedText],
  });
  const vContent = embedRes.data[0].embedding;
  const vLatent = embedRes.data[1].embedding;

  // 3.3: BM25 sparse vector (raw TFs; Qdrant applies IDF at query time)
  const vSparse = toSparseVector(rawText);

  // 3.4: Qdrant upsert (idempotent on chunkId)
  await qdrant.upsert(COLLECTION, {
    points: [
      {
        id: chunkId,
        vector: {
          content: vContent,
          latent: vLatent,
          sparse: vSparse,
        },
        payload: {
          userId,
          sessionId,
          chunkId,
          rawText,
          enrichedText,
          entityRefs: entities.map((e) => e.name),
          tCommit,
        },
      },
    ],
  });

  console.log(`[${INDEX_CHUNK_QUEUE}] qdrant upsert done`, {
    chunkId,
    contentDim: vContent.length,
    latentDim: vLatent.length,
    sparseTerms: vSparse.indices.length,
  });

  // 3.5 + 3.6: Neo4j MERGE entities + append versioned edges
  const { entityCount, edgeCount } = await writeToNeo4j(
    entities,
    relations,
    tCommit
  );

  console.log(`[${INDEX_CHUNK_QUEUE}] neo4j write done`, {
    chunkId,
    entityCount,
    edgeCount,
  });
}

export const indexChunkWorker = new Worker<IndexChunkJob>(
  INDEX_CHUNK_QUEUE,
  handler,
  { connection, concurrency: 8 }
);

indexChunkWorker.on('failed', (job, err) => {
  console.error(`[${INDEX_CHUNK_QUEUE}] job ${job?.id} failed:`, err);
});

indexChunkWorker.on('error', (err) => {
  console.error(`[${INDEX_CHUNK_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${INDEX_CHUNK_QUEUE}] shutting down...`);
  await indexChunkWorker.close();
  await connection.quit();
  await driver.close();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${INDEX_CHUNK_QUEUE}] worker started (concurrency=8)`);
