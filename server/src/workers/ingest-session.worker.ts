import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  INGEST_SESSION_QUEUE,
  type IngestSessionJob,
} from '../queue/ingest-session';

const connection = createWorkerConnection();

async function handler(job: Job<IngestSessionJob>) {
  console.log(`[${INGEST_SESSION_QUEUE}] job ${job.id}`, {
    sessionId: job.data.sessionId,
    userId: job.data.userId,
    turns: job.data.turns.length,
  });
  // TODO: segmentation → build windows → enqueue enrich-chunk jobs (idempotent jobIds)
}

export const ingestSessionWorker = new Worker<IngestSessionJob>(
  INGEST_SESSION_QUEUE,
  handler,
  { connection, concurrency: 2 }
);

ingestSessionWorker.on('failed', (job, err) => {
  console.error(`[${INGEST_SESSION_QUEUE}] job ${job?.id} failed:`, err);
});

ingestSessionWorker.on('error', (err) => {
  console.error(`[${INGEST_SESSION_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${INGEST_SESSION_QUEUE}] shutting down...`);
  await ingestSessionWorker.close();
  await connection.quit();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${INGEST_SESSION_QUEUE}] worker started (concurrency=2)`);
