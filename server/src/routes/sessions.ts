import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { createSession } from '../controllers/sessions';

const sessions = new Hono();

sessions.use('*', requireAuth);
sessions.post('/', createSession);

export default sessions;
