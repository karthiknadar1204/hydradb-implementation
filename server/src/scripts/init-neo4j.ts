import { driver } from '../utils/neo4j';

async function main() {
  const session = driver.session();
  try {
    // Drop the old single-field constraint if present (replaced by composite)
    await session.run(`DROP CONSTRAINT entity_name_unique IF EXISTS`);
    console.log('Dropped (or skipped) old constraint: entity_name_unique');

    // Composite uniqueness: each user has their own namespace of entity names.
    // Different users can both have an "Entity {name: 'Karthik'}" without collision.
    await session.run(`
      CREATE CONSTRAINT entity_user_name_unique IF NOT EXISTS
      FOR (e:Entity) REQUIRE (e.userId, e.name) IS UNIQUE
    `);
    console.log('Ensured composite constraint: (:Entity).(userId, name) IS UNIQUE');
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
