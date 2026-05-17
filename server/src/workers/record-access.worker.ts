import { Worker, type Job } from 'bullmq';
import { createWorkerConnection } from './connection';
import {
  RECORD_ACCESS_QUEUE,
  type RecordAccessJob,
} from '../queue/record-access';
import { qdrant, COLLECTION } from '../utils/qdrant';

const connection = createWorkerConnection();

async function handler(job: Job<RecordAccessJob>) {
  const { chunkIds, accessTime } = job.data;
  if (chunkIds.length === 0) return;

  console.log(
    `[${RECORD_ACCESS_QUEUE}] logging access for ${chunkIds.length} chunks at ${accessTime}`
  );

  const points = await qdrant.retrieve(COLLECTION, {
    ids: chunkIds,
    with_payload: true,
    with_vector: false,
  });

  // Append timestamp to each chunk's accessTimestamps[]
  await Promise.all(
    points.map((p) => {
      const existing =
        (p.payload?.accessTimestamps as string[] | undefined) ?? [];
      return qdrant.setPayload(COLLECTION, {
        points: [p.id as string],
        payload: { accessTimestamps: [...existing, accessTime] },
      });
    })
  );
}

export const recordAccessWorker = new Worker<RecordAccessJob>(
  RECORD_ACCESS_QUEUE,
  handler,
  { connection, concurrency: 5 }
);

recordAccessWorker.on('failed', (job, err) => {
  console.error(`[${RECORD_ACCESS_QUEUE}] job ${job?.id} failed:`, err);
});

recordAccessWorker.on('error', (err) => {
  console.error(`[${RECORD_ACCESS_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${RECORD_ACCESS_QUEUE}] shutting down...`);
  await recordAccessWorker.close();
  await connection.quit();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${RECORD_ACCESS_QUEUE}] worker started (concurrency=5)`);
