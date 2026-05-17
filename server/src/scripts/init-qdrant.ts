import { qdrant, COLLECTION } from '../utils/qdrant';

const PAYLOAD_INDEXES: { field: string; schema: 'uuid' | 'keyword' }[] = [
  { field: 'userId', schema: 'uuid' },
  { field: 'sessionId', schema: 'uuid' },
];

async function ensurePayloadIndex(
  field: string,
  schema: 'uuid' | 'keyword'
) {
  try {
    await qdrant.createPayloadIndex(COLLECTION, {
      field_name: field,
      field_schema: schema,
    });
    console.log(`  Payload index "${field}" (${schema}) created.`);
  } catch (err: unknown) {
    const e = err as {
      data?: { status?: { error?: string } };
      message?: string;
    };
    const msg = e.data?.status?.error ?? e.message ?? String(err);
    if (msg.toLowerCase().includes('already')) {
      console.log(`  Payload index "${field}" already exists. Skipping.`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const { exists } = await qdrant.collectionExists(COLLECTION);

  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        content: { size: 1536, distance: 'Cosine' },
        latent: { size: 1536, distance: 'Cosine' },
      },
      sparse_vectors: {
        sparse: { modifier: 'idf' },
      },
    });
    console.log(
      `Collection "${COLLECTION}" created — named vectors (content, latent @ 1536 Cosine) + sparse (IDF modifier).`
    );
  } else {
    console.log(
      `Collection "${COLLECTION}" already exists. Leaving data intact.`
    );
  }

  console.log(`Ensuring payload indexes for fast filtering:`);
  for (const idx of PAYLOAD_INDEXES) {
    await ensurePayloadIndex(idx.field, idx.schema);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed to initialize Qdrant collection:', err);
  process.exit(1);
});
