import { qdrant, COLLECTION } from '../utils/qdrant';

async function main() {
  const { exists } = await qdrant.collectionExists(COLLECTION);

  if (exists) {
    console.log(`Collection "${COLLECTION}" already exists. Skipping.`);
    return;
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: {
      content: { size: 1536, distance: 'Cosine' },
      latent: { size: 1536, distance: 'Cosine' },
    },
    sparse_vectors: {
      sparse: {},
    },
  });

  console.log(
    `Collection "${COLLECTION}" created with named vectors (content, latent @ 1536-dim Cosine) and sparse vector (sparse).`
  );
}

main().catch((err) => {
  console.error('Failed to initialize Qdrant collection:', err);
  process.exit(1);
});
