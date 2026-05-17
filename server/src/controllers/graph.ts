import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { verify } from 'hono/jwt';
import { driver } from '../utils/neo4j';

const JWT_SECRET = process.env.JWT_SECRET as string;

type GraphNode = { id: string; name: string };
type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  sentiment: string | null;
  tValid: string | null;
  tCommit: string;
};
type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

async function fetchGraph(userId: string): Promise<GraphSnapshot> {
  const session = driver.session();
  try {
    const nodesResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {userId: $userId})
         RETURN e.name AS name
         ORDER BY name`,
        { userId }
      )
    );

    const nodes: GraphNode[] = nodesResult.records.map((r) => {
      const name = r.get('name') as string;
      return { id: name, name };
    });

    const edgesResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (a:Entity {userId: $userId})-[r:RELATION]->(b:Entity {userId: $userId})
         RETURN a.name AS fromName,
                b.name AS toName,
                r.type AS type,
                r.sentiment AS sentiment,
                r.t_valid AS tValid,
                r.t_commit AS tCommit,
                r.edge_id AS edgeId
         ORDER BY tCommit ASC`,
        { userId }
      )
    );

    const edges: GraphEdge[] = edgesResult.records.map((r) => ({
      id: (r.get('edgeId') as string) ?? `${r.get('fromName')}|${r.get('type')}|${r.get('toName')}|${r.get('tCommit')}`,
      from: r.get('fromName') as string,
      to: r.get('toName') as string,
      type: (r.get('type') as string) ?? 'RELATION',
      sentiment: (r.get('sentiment') as string | null) ?? null,
      tValid: (r.get('tValid') as string | null) ?? null,
      tCommit: r.get('tCommit') as string,
    }));

    return { nodes, edges };
  } finally {
    await session.close();
  }
}

function snapshotFingerprint(g: GraphSnapshot): string {
  // Cheap change detector — recompute and emit when fingerprint moves.
  const lastTCommit = g.edges.length > 0 ? g.edges[g.edges.length - 1].tCommit : '';
  return `${g.nodes.length}|${g.edges.length}|${lastTCommit}`;
}

export async function getGraph(c: Context) {
  const userId = c.get('userId') as string;
  const snapshot = await fetchGraph(userId);
  return c.json(snapshot);
}

export async function streamGraph(c: Context) {
  // EventSource can't send headers, so accept the token via query string.
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'Missing token' }, 401);
  }

  let userId: string;
  try {
    const payload = await verify(token, JWT_SECRET, 'HS256');
    userId = payload.sub as string;
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }

  return streamSSE(c, async (stream) => {
    let lastFp = '';

    const send = async () => {
      const snapshot = await fetchGraph(userId);
      const fp = snapshotFingerprint(snapshot);
      if (fp !== lastFp) {
        lastFp = fp;
        await stream.writeSSE({
          event: 'graph',
          data: JSON.stringify(snapshot),
        });
      }
    };

    // Initial snapshot.
    try {
      const initial = await fetchGraph(userId);
      lastFp = snapshotFingerprint(initial);
      await stream.writeSSE({ event: 'graph', data: JSON.stringify(initial) });
    } catch (err) {
      console.error('[graph/stream] initial fetch failed:', err);
    }

    // Poll every 3s until the client disconnects.
    while (!stream.aborted) {
      await stream.sleep(3000);
      if (stream.aborted) break;
      try {
        await send();
      } catch (err) {
        console.error('[graph/stream] poll error:', err);
      }
    }
  });
}
