import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const INGEST_SESSION_QUEUE = 'ingest-session';

export type IngestSessionJob = {
  sessionId: string;
  userId: string;
  sessionDate: string;
  turns: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
};

export const ingestSessionQueue = new Queue<IngestSessionJob>(
  INGEST_SESSION_QUEUE,
  queueOptions
);
