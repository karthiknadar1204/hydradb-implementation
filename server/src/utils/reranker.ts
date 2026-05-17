import Together from 'together-ai';

const RERANKER_MODEL = 'Salesforce/Llama-Rank-v1';

let _client: Together | null = null;

function getClient(): Together {
  if (_client) return _client;
  const apiKey = process.env.RERANKER_API_KEY;
  if (!apiKey) {
    throw new Error('RERANKER_API_KEY environment variable is required');
  }
  _client = new Together({ apiKey });
  return _client;
}

/**
 * Cross-encoder rerank via Together AI (Salesforce/Llama-Rank-v1).
 * Returns relevance scores in the SAME ORDER as the input documents.
 * Empty input → empty output.
 */
export async function rerank(
  query: string,
  documents: string[]
): Promise<number[]> {
  if (documents.length === 0) return [];

  const client = getClient();

  const response = await client.rerank.create({
    model: RERANKER_MODEL,
    query,
    documents,
  });

  const scores = new Array<number>(documents.length).fill(0);
  for (const r of response.results) {
    scores[r.index] = r.relevance_score;
  }
  return scores;
}
