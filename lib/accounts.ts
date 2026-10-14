import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/crypto";
import { db, schema } from "@/lib/db";
import { fingerprint, type Session } from "@/lib/session";

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(254));
export const NewPassword = z.string().min(10, "Use at least 10 characters").max(256, "Use at most 256 characters");

const sessionFor = (u: { id: string; email: string; passwordHash: string }, sid: string): Session => ({
  role: "owner",
  sid,
  uid: u.id,
  email: u.email,
  pv: fingerprint(u.passwordHash),
});

/** Creates the user and their server in one atomic statement. Returns null if the email is taken. */
export async function createAccount(email: string, password: string): Promise<Session | null> {
  if (!db) throw new Error("No database connected");
  const id = randomUUID();
  const sid = randomUUID();
  const passwordHash = hashPassword(password);
  const r = await db.execute(sql`
    WITH u AS (
      INSERT INTO users (id, email, password_hash) VALUES (${id}, ${email}, ${passwordHash})
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    )
    INSERT INTO servers (id, user_id) SELECT ${sid}, id FROM u
    RETURNING id`);
  if (!r.rows.length) return null;
  return sessionFor({ id, email, passwordHash }, sid);
}

/** Email + password → session. Same work whether or not the account exists. */
export async function authenticate(email: string, password: string): Promise<Session | null> {
  if (!db) return null;
  const [row] = await db
    .select({ id: schema.users.id, email: schema.users.email, passwordHash: schema.users.passwordHash, sid: schema.servers.id })
    .from(schema.users)
    .innerJoin(schema.servers, eq(schema.servers.userId, schema.users.id))
    .where(eq(schema.users.email, email))
    .limit(1);
  const ok = verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
  return row && ok ? sessionFor(row, row.sid) : null;
}

/** Changing the password signs out every other device (their session fingerprint no longer matches). */
export async function changePassword(s: Session, current: string, next: string): Promise<Session | null> {
  if (!db || !s.uid) return null;
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.uid)).limit(1);
  if (!u || !verifyPassword(current, u.passwordHash)) return null;
  const passwordHash = hashPassword(next);
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, u.id));
  return sessionFor({ ...u, passwordHash }, s.sid);
}

/** Deletes the account and everything stored for its server, atomically. */
export async function deleteAccount(s: Session, password: string): Promise<boolean> {
  if (!db || !s.uid) return false;
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.uid)).limit(1);
  if (!u || !verifyPassword(password, u.passwordHash)) return false;
  await db.execute(sql`
    WITH a AS (DELETE FROM samples WHERE server_id = ${s.sid}),
         b AS (DELETE FROM sync_runs WHERE server_id = ${s.sid}),
         c AS (DELETE FROM settings WHERE key LIKE ${s.sid + ":%"}),
         e AS (DELETE FROM events WHERE server_id = ${s.sid}),
         p AS (DELETE FROM pairings WHERE server_id = ${s.sid}),
         d AS (DELETE FROM servers WHERE id = ${s.sid})
    DELETE FROM users WHERE id = ${u.id}`);
  return true;
}
