import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const ENRICH_CHUNK_QUEUE = 'enrich-chunk';

export type EnrichChunkJob = {
  sessionId: string;
  userId: string;
  sessionDate: string;
  chunkIndex: number;
  segmentText: string;
  contextWindow: {
    prev: string[];
    next: string[];
  };
};

export const enrichChunkQueue = new Queue<EnrichChunkJob>(
  ENRICH_CHUNK_QUEUE,
  queueOptions
);
