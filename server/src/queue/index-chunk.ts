import { Queue } from 'bullmq';
import { z } from 'zod';
import { queueOptions } from './defaults';

export const INDEX_CHUNK_QUEUE = 'index-chunk';

export const entitySchema = z.object({
  name: z.string(),
  type: z.string(),
});

export const relationSchema = z.object({
  from: z.string(),
  relation: z.string(),
  to: z.string(),
  tValid: z.string().nullable(),
  cMeta: z.object({
    sentiment: z.string().nullable(),
    reasoning: z.string().nullable(),
    context: z.string().nullable(),
  }),
});

export const enrichmentSchema = z.object({
  enrichedText: z.string(),
  entities: z.array(entitySchema),
  relations: z.array(relationSchema),
});

export type Entity = z.infer<typeof entitySchema>;
export type Relation = z.infer<typeof relationSchema>;
export type EnrichmentOutput = z.infer<typeof enrichmentSchema>;

export type IndexChunkJob = {
  sessionId: string;
  userId: string;
  chunkId: string;
  rawText: string;
  tCommit: string;
} & EnrichmentOutput;

export const indexChunkQueue = new Queue<IndexChunkJob>(
  INDEX_CHUNK_QUEUE,
  queueOptions
);
