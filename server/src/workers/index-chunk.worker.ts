import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  INDEX_CHUNK_QUEUE,
  type IndexChunkJob,
} from '../queue/index-chunk';
import openai from '../utils/openai';
import { qdrant, COLLECTION } from '../utils/qdrant';
import { toSparseVector } from '../utils/sparse';

const connection = createWorkerConnection();

const EMBEDDING_MODEL = 'text-embedding-3-small';

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

  // TODO (3.5 + 3.6): Neo4j MERGE entities + append versioned edges
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
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${INDEX_CHUNK_QUEUE}] worker started (concurrency=8)`);
