import { Hono } from 'hono';
import auth from './routes/auth';
import sessions from './routes/sessions';
import queryRoute from './routes/query';
import graph from './routes/graph';
import { logger } from 'hono/logger'
import { cors } from 'hono/cors';

const app = new Hono();

app.use(logger())
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  })
);

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

app.route('/auth', auth);
app.route('/sessions', sessions);
app.route('/query', queryRoute);
app.route('/graph', graph);

export default {
  port: 3004,
  fetch: app.fetch,
};
