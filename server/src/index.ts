import { Hono } from 'hono';
import auth from './routes/auth';
import sessions from './routes/sessions';
import { logger } from 'hono/logger'

const app = new Hono();

app.use(logger())

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

app.route('/auth', auth);
app.route('/sessions', sessions);

export default {
  port: 3004,
  fetch: app.fetch,
};
