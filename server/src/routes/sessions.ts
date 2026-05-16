import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createSession } from '../controllers/sessions';
import { ingestSession } from '../controllers/ingest';

const sessions = new Hono();

sessions.use('*', requireAuth);
sessions.post('/', createSession);
sessions.post('/:id/ingest', ingestSession);

export default sessions;
