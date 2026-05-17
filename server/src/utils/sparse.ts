const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she',
  'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'this', 'that', 'these', 'those', 'in', 'on', 'at',
  'to', 'for', 'of', 'with', 'by', 'from', 'as', 'or', 'but', 'if', 'so',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should', 'can',
  'could', 'may', 'might', 'must', 'shall', 'not', 'no', 'yes', 'just',
  's', 't', 'll', 've', 're', 'd', 'm',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function hashToken(token: string): number {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) + hash) ^ token.charCodeAt(i);
  }
  return hash >>> 0;
}

export function toSparseVector(text: string): {
  indices: number[];
  values: number[];
} {
  const tokens = tokenize(text);
  const counts = new Map<number, number>();
  for (const token of tokens) {
    const idx = hashToken(token);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  return {
    indices: Array.from(counts.keys()),
    values: Array.from(counts.values()),
  };
}
