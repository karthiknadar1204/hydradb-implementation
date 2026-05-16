import type { DefaultJobOptions, QueueOptions } from 'bullmq';
import redis from '../utils/redis';

export const defaultJobOptions: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

export const queueOptions: QueueOptions = {
  connection: redis,
  defaultJobOptions,
};
