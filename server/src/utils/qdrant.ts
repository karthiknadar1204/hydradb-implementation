import { QdrantClient } from '@qdrant/js-client-rest';

if (!process.env.QDRANT_URL) {
  throw new Error('QDRANT_URL environment variable is required');
}

if (!process.env.QDRANT_API_KEY) {
  throw new Error('QDRANT_API_KEY environment variable is required');
}

if (!process.env.QDRANT_COLLECTION) {
  throw new Error('QDRANT_COLLECTION environment variable is required');
}

export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

export const COLLECTION = process.env.QDRANT_COLLECTION;
