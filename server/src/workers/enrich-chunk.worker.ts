import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  ENRICH_CHUNK_QUEUE,
  type EnrichChunkJob,
} from '../queue/enrich-chunk';

const connection = createWorkerConnection();

async function handler(job: Job<EnrichChunkJob>) {
  console.log(`[${ENRICH_CHUNK_QUEUE}] job ${job.id}`, {
    sessionId: job.data.sessionId,
    chunkIndex: job.data.chunkIndex,
  });
  // TODO: LLM enrichment (entity resolution + preference mapping) → enqueue index-chunk
}

export const enrichChunkWorker = new Worker<EnrichChunkJob>(
  ENRICH_CHUNK_QUEUE,
  handler,
  { connection, concurrency: 20 }
);

enrichChunkWorker.on('failed', (job, err) => {
  console.error(`[${ENRICH_CHUNK_QUEUE}] job ${job?.id} failed:`, err);
});

enrichChunkWorker.on('error', (err) => {
  console.error(`[${ENRICH_CHUNK_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${ENRICH_CHUNK_QUEUE}] shutting down...`);
  await enrichChunkWorker.close();
  await connection.quit();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${ENRICH_CHUNK_QUEUE}] worker started (concurrency=20)`);
