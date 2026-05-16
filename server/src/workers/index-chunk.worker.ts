import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  INDEX_CHUNK_QUEUE,
  type IndexChunkJob,
} from '../queue/index-chunk';

const connection = createWorkerConnection();

async function handler(job: Job<IndexChunkJob>) {
  console.log(`[${INDEX_CHUNK_QUEUE}] job ${job.id}`, {
    chunkId: job.data.chunkId,
    entities: job.data.entities.length,
    relations: job.data.relations.length,
    enrichedText: job.data.enrichedText.slice(0, 100),
  });
  // TODO: embed 3 vectors → Qdrant upsert → Neo4j MERGE entities + append edges (idempotent)
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
