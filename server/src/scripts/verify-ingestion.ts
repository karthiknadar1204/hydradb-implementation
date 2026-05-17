import { qdrant, COLLECTION } from '../utils/qdrant';
import { driver } from '../utils/neo4j';

async function verifyQdrant() {
  console.log('\n=== QDRANT ===\n');

  const count = await qdrant.count(COLLECTION, { exact: true });
  console.log(`Point count: ${count.count}`);

  const scrolled = await qdrant.scroll(COLLECTION, {
    limit: 20,
    with_payload: true,
    with_vector: false,
  });

  console.log(`\nPoints (with payload, no vectors):`);
  for (const p of scrolled.points ?? []) {
    const payload = p.payload as Record<string, unknown>;
    console.log(`  - id: ${p.id}`);
    console.log(`    rawText:      ${payload.rawText}`);
    console.log(`    enrichedText: ${payload.enrichedText}`);
    console.log(`    entityRefs:   ${JSON.stringify(payload.entityRefs)}`);
    console.log(`    sessionId:    ${payload.sessionId}`);
    console.log(`    tCommit:      ${payload.tCommit}`);
  }

  if (scrolled.points && scrolled.points.length > 0) {
    const firstId = scrolled.points[0].id as string;
    const detail = await qdrant.retrieve(COLLECTION, {
      ids: [firstId],
      with_vector: true,
      with_payload: false,
    });
    const vec = detail[0]?.vector as Record<string, unknown> | undefined;
    if (vec && typeof vec === 'object') {
      const keys = Object.keys(vec);
      const dims: Record<string, number | string> = {};
      for (const k of keys) {
        const v = (vec as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          dims[k] = v.length;
        } else if (
          v &&
          typeof v === 'object' &&
          'indices' in (v as Record<string, unknown>)
        ) {
          dims[k] = `sparse(${
            ((v as { indices: number[] }).indices ?? []).length
          } terms)`;
        }
      }
      console.log(`\nFirst point vector keys: ${JSON.stringify(keys)}`);
      console.log(`Vector dims: ${JSON.stringify(dims)}`);
    }
  }
}

async function verifyNeo4j() {
  console.log('\n=== NEO4J ===\n');

  const session = driver.session();
  try {
    const entityCountRes = await session.run(
      `MATCH (e:Entity) RETURN count(e) AS count`
    );
    const entityCount = entityCountRes.records[0].get('count');
    console.log(`Entity count: ${entityCount}`);

    const entitiesRes = await session.run(
      `MATCH (e:Entity) RETURN e.name AS name, e.type AS type ORDER BY name`
    );
    console.log(`\nEntities:`);
    for (const r of entitiesRes.records) {
      console.log(`  - ${r.get('name')} (${r.get('type')})`);
    }

    const edgeCountRes = await session.run(
      `MATCH ()-[r:RELATION]->() RETURN count(r) AS count`
    );
    const edgeCount = edgeCountRes.records[0].get('count');
    console.log(`\nEdge count: ${edgeCount}`);

    const edgesRes = await session.run(
      `MATCH (a:Entity)-[r:RELATION]->(b:Entity)
       RETURN a.name AS from, r.type AS type, b.name AS to,
              r.sentiment AS sentiment, r.t_valid AS t_valid,
              r.t_commit AS t_commit
       ORDER BY r.t_commit`
    );
    console.log(`\nEdges:`);
    for (const r of edgesRes.records) {
      const from = r.get('from');
      const to = r.get('to');
      const type = r.get('type');
      const sentiment = r.get('sentiment');
      const tValid = r.get('t_valid');
      console.log(
        `  - (${from}) -[${type}, sentiment=${sentiment}, tValid=${tValid}]-> (${to})`
      );
    }

    const dupRes = await session.run(
      `MATCH (e:Entity)
       WITH e.name AS name, count(*) AS c
       WHERE c > 1
       RETURN name, c`
    );
    if (dupRes.records.length === 0) {
      console.log(`\nDedup check: PASS — no duplicate entity names.`);
    } else {
      console.log(`\nDedup check: FAIL — duplicates found:`);
      for (const r of dupRes.records) {
        console.log(`  - ${r.get('name')}: ${r.get('c')}`);
      }
    }
  } finally {
    await session.close();
  }
}

async function main() {
  await verifyQdrant();
  await verifyNeo4j();
  await driver.close();
}

main().catch(async (err) => {
  console.error('Verification failed:', err);
  await driver.close().catch(() => {});
  process.exit(1);
});
