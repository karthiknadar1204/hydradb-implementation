import { driver } from '../utils/neo4j';

async function main() {
  const session = driver.session();
  try {
    const countRes = await session.run(`MATCH (n) RETURN count(n) AS total`);
    const total = countRes.records[0]?.get('total') ?? 0;

    if (total === 0) {
      console.log('Graph is already empty.');
      return;
    }

    console.log(`Deleting ${total} nodes and all their relationships...`);
    await session.run(`MATCH (n) DETACH DELETE n`);
    console.log('Done.');
  } finally {
    await session.close();
  }
  await driver.close();
}

main().catch(async (err) => {
  console.error('Failed to wipe Neo4j:', err);
  await driver.close().catch(() => {});
  process.exit(1);
});
