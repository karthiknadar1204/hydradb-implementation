import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const ENRICH_CHUNK_QUEUE = 'enrich-chunk';

export type EnrichChunkJob = {
  sessionId: string;
  userId: string;
  chunkId: string;
  segmentText: string;
  tCommit: string;
  contextWindow: {
    prev: string[];
    next: string[];
  };
};

export const enrichChunkQueue = new Queue<EnrichChunkJob>(
  ENRICH_CHUNK_QUEUE,
  queueOptions
);
