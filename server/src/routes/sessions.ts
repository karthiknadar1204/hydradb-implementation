import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createSession, listSessions, listMessages } from '../controllers/sessions';
import { ingestSession } from '../controllers/ingest';

const sessions = new Hono();

sessions.use('*', requireAuth);
sessions.get('/', listSessions);
sessions.post('/', createSession);
sessions.get('/:id/messages', listMessages);
sessions.post('/:id/ingest', ingestSession);

export default sessions;
