import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import { db } from '../config/db';
import { users } from '../config/schema';

const JWT_SECRET = process.env.JWT_SECRET as string;

export async function signup(c: Context) {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    return c.json({ error: 'Invalid email' }, 400);
  }

  if (typeof password !== 'string' || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: 'Email already in use' }, 409);
  }

  const hash = await Bun.password.hash(password);

  const [user] = await db
    .insert(users)
    .values({ email, password: hash })
    .returning({ id: users.id, email: users.email });

  const token = await sign({ sub: user.id, email: user.email }, JWT_SECRET, 'HS256');

  return c.json({ user, token }, 201);
}

export async function login(c: Context) {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await Bun.password.verify(password, user.password);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await sign({ sub: user.id, email: user.email }, JWT_SECRET, 'HS256');

  return c.json({ user: { id: user.id, email: user.email }, token });
}
