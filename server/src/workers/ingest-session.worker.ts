import { Worker, type Job } from 'bullmq';
import { and, desc, eq, ne } from 'drizzle-orm';
import { createWorkerConnection } from './connection';
import {
  INGEST_SESSION_QUEUE,
  type IngestSessionJob,
} from '../queue/ingest-session';
import {
  enrichChunkQueue,
  ENRICH_CHUNK_QUEUE,
} from '../queue/enrich-chunk';
import { db } from '../config/db';
import { messages } from '../config/schema';

const connection = createWorkerConnection();

const H_PREV = 5;

async function fetchPrevWindow(
  sessionId: string,
  currentChunkId: string
): Promise<string[]> {
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(eq(messages.sessionId, sessionId), ne(messages.id, currentChunkId))
    )
    .orderBy(desc(messages.createdAt))
    .limit(H_PREV);

  return rows.reverse().map((r) => r.content);
}

async function handler(job: Job<IngestSessionJob>) {
  const { sessionId, userId, chunkId, message, tCommit } = job.data;

  console.log(`[${INGEST_SESSION_QUEUE}] job ${job.id}`, {
    sessionId,
    chunkId,
    message: message.slice(0, 80),
  });

  const prev = await fetchPrevWindow(sessionId, chunkId);

  await enrichChunkQueue.add(
    ENRICH_CHUNK_QUEUE,
    {
      sessionId,
      userId,
      chunkId,
      segmentText: message,
      tCommit,
      contextWindow: { prev, next: [] },
    },
    { jobId: chunkId }
  );
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
