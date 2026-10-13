import "server-only";
import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { parseServerLink } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { info } from "@/lib/netdata";
import { saveLink } from "@/lib/settings";

// Pairing: the dashboard shows a one-line install command with a short code; the agent on the server
// redeems it and hands over its link. Nobody copies a URL or a password.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const TTL_MS = 10 * 60_000;

/** "abcd 2345" / "ABCD-2345" → "ABCD2345" */
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hash = (code: string) => createHash("sha256").update("server-pulse pairing:" + normalizeCode(code)).digest("hex");

/** 8 characters from a 31-letter alphabet (≈ 8.5 × 10¹¹ codes), valid 10 minutes, single use. */
export async function createPairingCode(serverId: string): Promise<{ code: string; expiresAt: string }> {
  if (!db) throw new Error("No database connected");
  let raw = "";
  for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = new Date(Date.now() + TTL_MS);
  // housekeeping: old codes for this server are no longer needed
  await db.delete(schema.pairings).where(and(eq(schema.pairings.serverId, serverId), lt(schema.pairings.expiresAt, new Date())));
  await db.insert(schema.pairings).values({ codeHash: hash(raw), serverId, expiresAt });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: expiresAt.toISOString() };
}

export type PairStatus = { status: "waiting" | "paired" | "expired" | "error" | "unknown"; hostname?: string; error?: string };

export async function pairingStatus(code: string, serverId: string): Promise<PairStatus> {
  if (!db) return { status: "unknown" };
  const [row] = await db
    .select()
    .from(schema.pairings)
    .where(and(eq(schema.pairings.codeHash, hash(code)), eq(schema.pairings.serverId, serverId)))
    .limit(1);
  if (!row) return { status: "unknown" };
  if (row.usedAt) return { status: "paired", hostname: row.hostname ?? undefined };
  if (row.expiresAt.getTime() < Date.now()) return { status: "expired" };
  if (row.error) return { status: "error", error: row.error, hostname: row.hostname ?? undefined };
  return { status: "waiting" };
}

/**
 * Called by the agent. The link is tested BEFORE the code is spent, so a failed attempt can be retried;
 * the final claim is one atomic UPDATE, so a code can never be used twice.
 */
export async function redeemPairingCode(input: { code: string; link: string; hostname?: string; version?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: "This dashboard has no database yet, so it can't pair servers" };
  const h = hash(input.code);
  const [row] = await db
    .select()
    .from(schema.pairings)
    .where(and(eq(schema.pairings.codeHash, h), isNull(schema.pairings.usedAt), gt(schema.pairings.expiresAt, new Date())))
    .limit(1);
  if (!row) return { ok: false, error: "This pairing code is wrong, expired or already used. Get a new one from Add server in the dashboard." };

  const note = (error: string) =>
    db!
      .update(schema.pairings)
      .set({ error: error.slice(0, 500), hostname: input.hostname?.slice(0, 120) ?? null })
      .where(eq(schema.pairings.codeHash, h));

  let link;
  try {
    // this request is unauthenticated (only the code vouches for it): always use the SSRF guard
    link = parseServerLink(input.link, { sid: row.serverId, trusted: false });
  } catch (e) {
    await note((e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
  try {
    await info(link);
  } catch (e) {
    const msg = `The dashboard can't reach your server yet: ${(e as Error).message}`;
    await note(msg);
    return { ok: false, error: msg };
  }

  const claimed = await db
    .update(schema.pairings)
    .set({ usedAt: new Date(), error: null, hostname: input.hostname?.slice(0, 120) ?? null, agentVersion: input.version?.slice(0, 40) ?? null })
    .where(and(eq(schema.pairings.codeHash, h), isNull(schema.pairings.usedAt), gt(schema.pairings.expiresAt, sql`now()`)))
    .returning({ serverId: schema.pairings.serverId });
  if (!claimed.length) return { ok: false, error: "This pairing code was just used. Get a new one from Add server." };
  await saveLink(row.serverId, input.link.trim());
  return { ok: true };
}
