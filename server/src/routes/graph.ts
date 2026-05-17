import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { getGraph, streamGraph } from '../controllers/graph';

const graph = new Hono();

// SSE stream — authenticates via ?token=<jwt> query param (EventSource can't send headers).
graph.get('/stream', streamGraph);

// Snapshot endpoint — standard bearer auth.
graph.use('/', requireAuth);
graph.get('/', getGraph);

export default graph;
