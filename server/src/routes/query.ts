import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { query } from '../controllers/query';

const queryRoute = new Hono();

queryRoute.use('*', requireAuth);
queryRoute.post('/', query);

export default queryRoute;
