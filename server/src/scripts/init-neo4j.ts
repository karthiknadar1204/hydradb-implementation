import { driver } from '../utils/neo4j';

async function main() {
  const session = driver.session();
  try {
    await session.run(`
      CREATE CONSTRAINT entity_name_unique IF NOT EXISTS
      FOR (e:Entity) REQUIRE e.name IS UNIQUE
    `);
    console.log('Constraint ensured: (:Entity).name IS UNIQUE');
  } finally {
    await session.close();
  }
  await driver.close();
}

main().catch(async (err) => {
  console.error('Failed to initialize Neo4j constraints:', err);
  await driver.close().catch(() => {});
  process.exit(1);
});
