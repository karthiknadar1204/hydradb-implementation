import { qdrant, COLLECTION } from '../utils/qdrant';

async function main() {
  const { exists } = await qdrant.collectionExists(COLLECTION);

  if (exists) {
    console.log(`Collection "${COLLECTION}" exists — deleting before recreate.`);
    await qdrant.deleteCollection(COLLECTION);
  }

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
}

main().catch((err) => {
  console.error('Failed to initialize Qdrant collection:', err);
  process.exit(1);
});
