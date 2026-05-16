import { Worker, type Job } from 'bullmq';
import { zodResponseFormat } from 'openai/helpers/zod';
import { createWorkerConnection } from './connection';
import {
  ENRICH_CHUNK_QUEUE,
  type EnrichChunkJob,
} from '../queue/enrich-chunk';
import {
  INDEX_CHUNK_QUEUE,
  indexChunkQueue,
  enrichmentSchema,
} from '../queue/index-chunk';
import openai from '../utils/openai';

const connection = createWorkerConnection();

const SYSTEM_PROMPT = `You are an expert at extracting structured memory from conversational text.

You will receive a single user message ("current message") and optionally a list of previous messages in the same conversation ("window"). You produce:
1. enrichedText — the current message rewritten with all pronouns and vague references resolved to explicit entities. Must be a self-contained sentence understandable without any prior context.
2. entities — every entity mentioned in the current message, with canonical full names.
3. relations — every fact, preference, or connection expressed in the current message, as (from, relation, to) triples.

CRITICAL — scope of extraction:
- Extract entities and relations ONLY from facts present in the CURRENT message.
- The window of previous messages is provided SOLELY to resolve pronouns and ambiguous references in the current message. Do NOT re-extract facts from the window — they were already captured when those messages were ingested.
- Example: if a prior message established "my name is Karthik" and the current message says "i am building X", you do NOT emit a HAS_NAME relation; you only emit the BUILDS relation. The name is used only to resolve "i" → "Karthik".

Naming and structure:
- Use full canonical names. If a person introduced themselves as "Karthik", use "Karthik" everywhere — never "the user" or pronouns.
- Relation names are UPPER_SNAKE_CASE: WORKS_AT, LIKES, AVOIDS, PREFERS, RELOCATED_TO, OPTIMIZES_FOR, OWNS, HAS_NAME, BUILDS, USES, etc.
- Preferences are relations. "I love dogs" → Karthik LIKES dogs. "I hate Mondays" → Karthik DISLIKES Mondays.

Entity-relation consistency (strict):
- Every value that appears as "from" or "to" in a relation MUST also appear as an entity in the entities list, with the EXACT same string. No exceptions.
- Before finalizing output, double-check this. If you reference "memory systems" in a relation, "memory systems" must be in entities.

Temporal:
- Resolve relative dates ("yesterday", "last week", "two months ago") against the provided reference date. Output tValid as ISO 8601 (YYYY-MM-DD).
- If the current message contains no temporal claim, leave tValid as null.

Sentiment, reasoning, context (cMeta):
- Populate sentiment when implied: "love"/"enjoy"/"great" → "positive"; "hate"/"frustrated"/"annoying" → "negative"; factual statements → "neutral".
- Populate reasoning if the message explains WHY (e.g., "moved to SF because of new job" → reasoning: "new job").
- Populate context if relevant situational background is present (e.g., "during the migration", "while at school").
- Use null only when truly absent. Do not invent.

Final check before output:
- Are all relation entities in the entities list?
- Did you accidentally re-extract anything from the window?
- Did you populate sentiment where implied?`;

function buildUserPrompt(
  segmentText: string,
  prev: string[],
  tCommit: string
): string {
  const prevBlock =
    prev.length === 0
      ? '(none — this is the first message of the session)'
      : prev.map((p, i) => `[${i + 1}] ${p}`).join('\n');

  return `Reference date (for resolving relative dates like "last week"): ${tCommit}

Previous messages in this session (oldest first):
${prevBlock}

Current message to enrich:
${segmentText}`;
}

async function handler(job: Job<EnrichChunkJob>) {
  const { sessionId, userId, chunkId, segmentText, tCommit, contextWindow } =
    job.data;

  console.log(`[${ENRICH_CHUNK_QUEUE}] job ${job.id}`, {
    sessionId,
    chunkId,
    prevLen: contextWindow.prev.length,
    segment: segmentText.slice(0, 80),
  });

  const userPrompt = buildUserPrompt(segmentText, contextWindow.prev, tCommit);

  const result = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: zodResponseFormat(enrichmentSchema, 'enrichment'),
  });

  const enrichment = result.choices[0]?.message.parsed;
  if (!enrichment) {
    throw new Error('OpenAI returned no parsed enrichment');
  }

  console.log(`[${ENRICH_CHUNK_QUEUE}] enriched chunkId=${chunkId}`);
  console.log(JSON.stringify(enrichment, null, 2));

  await indexChunkQueue.add(
    INDEX_CHUNK_QUEUE,
    {
      sessionId,
      userId,
      chunkId,
      rawText: segmentText,
      tCommit,
      ...enrichment,
    },
    { jobId: chunkId }
  );
}

export const enrichChunkWorker = new Worker<EnrichChunkJob>(
  ENRICH_CHUNK_QUEUE,
  handler,
  { connection, concurrency: 20 }
);

enrichChunkWorker.on('failed', (job, err) => {
  console.error(`[${ENRICH_CHUNK_QUEUE}] job ${job?.id} failed:`, err);
});

enrichChunkWorker.on('error', (err) => {
  console.error(`[${ENRICH_CHUNK_QUEUE}] worker error:`, err);
});

const shutdown = async () => {
  console.log(`[${ENRICH_CHUNK_QUEUE}] shutting down...`);
  await enrichChunkWorker.close();
  await connection.quit();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[${ENRICH_CHUNK_QUEUE}] worker started (concurrency=20)`);
