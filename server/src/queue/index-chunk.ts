import { Queue } from 'bullmq';
import { queueOptions } from './defaults';

export const INDEX_CHUNK_QUEUE = 'index-chunk';

export type EntityRef = {
  name: string;
  type?: string;
};

export type RelationCommit = {
  from: EntityRef;
  relation: string;
  to: EntityRef;
  tValid?: string;
  cMeta?: Record<string, unknown>;
};

export type IndexChunkJob = {
  sessionId: string;
  userId: string;
  chunkIndex: number;
  rawText: string;
  enrichedText: string;
  entities: EntityRef[];
  relations: RelationCommit[];
  preferenceMap?: unknown[];
  tCommit: string;
};

export const indexChunkQueue = new Queue<IndexChunkJob>(
  INDEX_CHUNK_QUEUE,
  queueOptions
);
