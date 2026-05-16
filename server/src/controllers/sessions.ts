import type { Context } from 'hono';
import { db } from '../config/db';
import { sessions } from '../config/schema';

export async function createSession(c: Context) {
  const userId = c.get('userId') as string;

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = typeof body.title === 'string' ? body.title : null;

  const [session] = await db
    .insert(sessions)
    .values({ userId, title })
    .returning();

  return c.json({ session }, 201);
}
