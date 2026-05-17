import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const RECORD_ACCESS_QUEUE = 'record-access';

export type RecordAccessJob = {
  chunkIds: string[];
  accessTime: string; // ISO timestamp
};

export const recordAccessQueue = new Queue<RecordAccessJob>(
  RECORD_ACCESS_QUEUE,
  queueOptions
);
