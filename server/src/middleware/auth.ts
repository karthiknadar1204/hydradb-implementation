import type { Context, Next } from 'hono';
import { verify } from 'hono/jwt';

const JWT_SECRET = process.env.JWT_SECRET as string;

export async function requireAuth(c: Context, next: Next) {
  const auth = c.req.header('Authorization');

  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = auth.slice(7);

  try {
    const payload = await verify(token, JWT_SECRET, 'HS256');
    c.set('userId', payload.sub as string);
    c.set('email', payload.email as string);
    await next();
  } catch (err) {
    console.error('[requireAuth] verify failed:', err);
    console.error('[requireAuth] JWT_SECRET length:', JWT_SECRET?.length);
    return c.json({ error: 'Invalid token', reason: (err as Error)?.message }, 401);
  }
}
