import { Hono } from 'hono';
import auth from './routes/auth';
import sessions from './routes/sessions';
import queryRoute from './routes/query';
import { logger } from 'hono/logger'

const app = new Hono();

app.use(logger())

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

app.route('/auth', auth);
app.route('/sessions', sessions);
app.route('/query', queryRoute);

export default {
  port: 3004,
  fetch: app.fetch,
};
