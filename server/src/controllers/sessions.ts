import type { Context } from 'hono';
import { and, eq, asc, desc } from 'drizzle-orm';
import { db } from '../config/db';
import { sessions, messages } from '../config/schema';

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

export async function listSessions(c: Context) {
  const userId = c.get('userId') as string;
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt));
  return c.json({ sessions: rows });
}

export async function listMessages(c: Context) {
  const userId = c.get('userId') as string;
  const sessionId = c.req.param('id');

  if (!sessionId) {
    return c.json({ error: 'Session id is required' }, 400);
  }

  const [owned] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);

  if (!owned) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  return c.json({ messages: rows });
}
