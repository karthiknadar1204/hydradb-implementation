import type { Context } from 'hono';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import openai from '../utils/openai';

const N_EXPANSIONS = 3;

const expansionSchema = z.object({
  expansions: z.array(z.string()).min(N_EXPANSIONS).max(N_EXPANSIONS),
});

const SYSTEM_PROMPT = `You are an expert at rewriting user queries to maximize retrieval recall from a memory system.

Given a user's question, produce exactly ${N_EXPANSIONS} alternative phrasings that preserve the intent but vary in surface form. Each expansion should attack the question from a slightly different angle so that vector search has multiple chances to match relevant memories.

Rules:
- Each expansion is a complete sentence or question.
- Vary word choice, specificity, and perspective — not just trivial synonym swaps.
- Keep the same semantic intent. Do not drift, add new meaning, or change scope.
- Do not repeat the original query verbatim.
- If the query is abstract (e.g., "what's been going on"), produce more concrete reformulations.
- If the query is specific (e.g., "where did i live in 2023"), produce slightly more general or differently-phrased variants.`;

export async function query(c: Context) {
  const userId = c.get('userId') as string;

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json({ error: 'query must be a non-empty string' }, 400);
  }

  const originalQuery = body.query.trim();

  const result = await openai.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Original query: ${originalQuery}` },
    ],
    response_format: zodResponseFormat(expansionSchema, 'query_expansion'),
  });

  const parsed = result.choices[0]?.message.parsed;
  if (!parsed) {
    return c.json({ error: 'Failed to parse expansion' }, 500);
  }

  console.log(`[query] userId=${userId}`);
  console.log(`[query] original:   ${originalQuery}`);
  console.log(`[query] expansions:`);
  parsed.expansions.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));

  return c.json({
    originalQuery,
    expansions: parsed.expansions,
  });
}
