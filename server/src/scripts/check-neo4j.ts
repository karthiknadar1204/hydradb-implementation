import { driver } from '../utils/neo4j';

async function main() {
  const serverInfo = await driver.getServerInfo();
  console.log('Connection established');
  console.log(serverInfo);

  const session = driver.session();
  try {
    const result = await session.run('RETURN 1 AS test');
    console.log('Query result:', result.records[0].get('test'));
  } finally {
    await session.close();
  }

  await driver.close();
}

main().catch(async (err) => {
  console.error('Neo4j connection check failed:', err);
  await driver.close().catch(() => {});
  process.exit(1);
});
