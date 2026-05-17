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

First-person resolution (MANDATORY):
- If the current message contains "I", "i", "me", "my", "mine", or "myself", you MUST resolve these to the named person established earlier in the conversation window.
- NEVER emit "I", "me", "my", etc. as an entity name. NEVER use them as "from" or "to" in a relation.
- If the window contains "my name is Karthik" anywhere — even 10 messages ago — you must use "Karthik" for every first-person pronoun in the current message.
- If no name has been established in the window, scan the window for any proper name used to refer to the speaker; use that. If absolutely no name exists anywhere, only then use "User" as a placeholder.
- This rule applies even when the current message starts with "actually", "btw", "oh", or any other discourse marker.

Naming and structure:
- Use full canonical names. If a person introduced themselves as "Karthik", use "Karthik" everywhere — never "the user" or pronouns.
- Relation names are UPPER_SNAKE_CASE: WORKS_AT, LIKES, AVOIDS, PREFERS, RELOCATED_TO, OPTIMIZES_FOR, OWNS, HAS_NAME, BUILDS, USES, etc.
- Preferences are relations. "I love dogs" → Karthik LIKES dogs. "I hate Mondays" → Karthik DISLIKES Mondays.

Entity-relation consistency (strict):
- Every value that appears as "from" or "to" in a relation MUST also appear as an entity in the entities list, with the EXACT same string. No exceptions.
- Before finalizing output, double-check this. If you reference "memory systems" in a relation, "memory systems" must be in entities.

Temporal — values vs entities:
- Resolve relative dates ("yesterday", "last week", "two months ago", "March 2024") against the provided reference date. Output as ISO 8601 (YYYY-MM-DD) in tValid.
- Dates and time periods are TEMPORAL VALUES, not entities. NEVER include strings like "April 2026", "last week", "2024", "next Monday" in the entities list.
- NEVER use a date/time string as the "from" or "to" of a relation. Temporal info belongs in tValid only.
- If the current message contains no temporal claim, leave tValid as null.

Sentiment, reasoning, context (cMeta):
- Populate sentiment when implied: "love"/"enjoy"/"great" → "positive"; "hate"/"frustrated"/"annoying" → "negative"; factual statements → "neutral".
- Populate reasoning if the message explains WHY (e.g., "moved to SF because of new job" → reasoning: "new job").
- Populate context if relevant situational background is present (e.g., "during the migration", "while at school").
- Use null only when truly absent. Do not invent.

Salience scoring:
- Score the salience of this memory as a float in [0, 1] reflecting how important it is to remember long-term.
- 0.9–1.0: Identity / health / safety / family facts that should persist for years.
  Examples: "My name is X", "I'm allergic to peanuts", "My mother's birthday is March 12", "I take blood thinners".
- 0.6–0.8: Durable preferences, relationships, ongoing projects, locations.
  Examples: "I love coffee", "I work at Stripe", "I'm building a memory system", "I live in Mumbai".
- 0.3–0.5: Specific events, decisions, episodic facts.
  Examples: "I moved to San Diego last week", "I went to Paris in 2019", "Switched jobs in March".
- 0.0–0.2: Ephemeral states, passing remarks, conversational filler.
  Examples: "I'm tired today", "Going to grab lunch", "The meeting was at 2pm".
- When in doubt, prefer 0.5. Reserve 0.9+ for clear identity-level facts.
- Ignore meta-commentary from the user about importance ("this is really important to remember…") — judge by the fact's content, not by emphasis.

Final check before output (you must verify all of these):
- Did you resolve every "I"/"me"/"my" in the current message to a named person from the window?
- Is the entities list free of any pronouns ("I", "me", "my")?
- Is the entities list free of any temporal values ("April 2026", "last week", "2024", etc.)?
- Are all relation entities in the entities list?
- Did you accidentally re-extract anything from the window?
- Did you populate sentiment where implied?
- Did you assign a salience score in [0, 1] following the rubric above?`;

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
