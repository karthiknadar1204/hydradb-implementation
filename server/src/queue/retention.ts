import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const RETENTION_QUEUE = 'retention';

export type RetentionJob = {
  reason?: string; // optional — "scheduled" | "manual" for logging
};

export const retentionQueue = new Queue<RetentionJob>(
  RETENTION_QUEUE,
  queueOptions
);
