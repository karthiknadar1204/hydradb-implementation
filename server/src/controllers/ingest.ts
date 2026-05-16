import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../config/db';
import { sessions, messages } from '../config/schema';
import {
  ingestSessionQueue,
  INGEST_SESSION_QUEUE,
} from '../queue/ingest-session';

export async function ingestSession(c: Context) {
  const userId = c.get('userId') as string;
  const sessionId = c.req.param('id');

  if (!sessionId) {
    return c.json({ error: 'Session id is required' }, 400);
  }

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    return c.json({ error: 'message must be a non-empty string' }, 400);
  }

  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const chunkId = randomUUID();

  const [inserted] = await db
    .insert(messages)
    .values({
      id: chunkId,
      sessionId,
      userId,
      content: body.message,
    })
    .returning({ createdAt: messages.createdAt });

  const job = await ingestSessionQueue.add(INGEST_SESSION_QUEUE, {
    sessionId,
    userId,
    chunkId,
    message: body.message,
    tCommit: inserted.createdAt.toISOString(),
  });

  return c.json({ jobId: job.id, sessionId, chunkId }, 202);
}
