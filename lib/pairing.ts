import "server-only";
import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { parseServerLink } from "@/lib/config";
import { decrypt, encrypt } from "@/lib/crypto";
import { db, schema } from "@/lib/db";
import { info } from "@/lib/netdata";
import { appSecret } from "@/lib/session";
import { saveLink } from "@/lib/settings";

// Pairing: the dashboard shows a one-line install command with a short code; the agent on the server
// redeems it and hands over its link; the owner approves it on the Add server screen. The approval step
// means a code someone else saw (a screenshot, the server's process list) can't attach their server.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const TTL_MS = 10 * 60_000;
const APPROVE_WITHIN_MS = 30 * 60_000;

/** "abcd 2345" / "ABCD-2345" → "ABCD2345" */
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hash = (code: string) => createHash("sha256").update("server-pulse pairing:" + normalizeCode(code)).digest("hex");

/** 8 characters from a 31-letter alphabet (≈ 8.5 × 10¹¹ codes), valid 10 minutes, single use. */
export async function createPairingCode(serverId: string): Promise<{ code: string; expiresAt: string }> {
  if (!db) throw new Error("No database connected");
  let raw = "";
  for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = new Date(Date.now() + TTL_MS);
  // housekeeping: codes for this server that can't be used or approved any more
  await db
    .delete(schema.pairings)
    .where(and(eq(schema.pairings.serverId, serverId), lt(schema.pairings.expiresAt, new Date(Date.now() - APPROVE_WITHIN_MS))));
  await db.insert(schema.pairings).values({ codeHash: hash(raw), serverId, expiresAt });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: expiresAt.toISOString() };
}

export type PairStatus = {
  status: "waiting" | "pending" | "paired" | "rejected" | "expired" | "error" | "unknown";
  hostname?: string;
  host?: string; // where the agent's link points, shown so the owner can recognise it
  version?: string;
  error?: string;
};

export async function pairingStatus(code: string, serverId: string): Promise<PairStatus> {
  if (!db) return { status: "unknown" };
  const [row] = await db
    .select()
    .from(schema.pairings)
    .where(and(eq(schema.pairings.codeHash, hash(code)), eq(schema.pairings.serverId, serverId)))
    .limit(1);
  if (!row) return { status: "unknown" };
  const who = { hostname: row.hostname ?? undefined, version: row.agentVersion ?? undefined };
  if (row.approvedAt) return { status: "paired", ...who };
  if (row.rejectedAt) return { status: "rejected", ...who };
  if (row.usedAt && row.pendingLinkEnc) {
    if (row.usedAt.getTime() + APPROVE_WITHIN_MS < Date.now()) return { status: "expired" };
    const link = decrypt(row.pendingLinkEnc, appSecret());
    let host: string | undefined;
    try {
      host = link ? new URL(link).hostname : undefined;
    } catch {}
    return { status: "pending", host, ...who };
  }
  if (row.expiresAt.getTime() < Date.now()) return { status: "expired" };
  if (row.error) return { status: "error", error: row.error, ...who };
  return { status: "waiting" };
}

/**
 * Called by the agent (no session). The link is tested BEFORE the code is spent, so a failed attempt can
 * be retried; the claim is one atomic UPDATE, so a code is used once. The link is only parked
 * (encrypted) until the owner approves it.
 */
export async function redeemPairingCode(input: {
  code: string;
  link: string;
  hostname?: string;
  version?: string;
}): Promise<{ ok: true; pending: true } | { ok: false; error: string }> {
  if (!db) return { ok: false, error: "This dashboard has no database yet, so it can't pair servers" };
  const h = hash(input.code);
  const [row] = await db
    .select()
    .from(schema.pairings)
    .where(and(eq(schema.pairings.codeHash, h), isNull(schema.pairings.usedAt), gt(schema.pairings.expiresAt, new Date())))
    .limit(1);
  if (!row) return { ok: false, error: "This pairing code is wrong, expired or already used. Get a new one from Add server in the dashboard." };

  const hostname = input.hostname?.slice(0, 120) ?? null;
  const note = (error: string) => db!.update(schema.pairings).set({ error: error.slice(0, 500), hostname }).where(eq(schema.pairings.codeHash, h));

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
    .set({
      usedAt: new Date(),
      error: null,
      hostname,
      agentVersion: input.version?.slice(0, 40) ?? null,
      pendingLinkEnc: encrypt(input.link.trim(), appSecret()),
    })
    .where(and(eq(schema.pairings.codeHash, h), isNull(schema.pairings.usedAt), gt(schema.pairings.expiresAt, sql`now()`)))
    .returning({ serverId: schema.pairings.serverId });
  if (!claimed.length) return { ok: false, error: "This pairing code was just used. Get a new one from Add server." };
  return { ok: true, pending: true };
}

/** The owner approves (link saved, data starts flowing) or rejects (link discarded). */
export async function decidePairing(code: string, serverId: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!db) return { ok: false, error: "No database connected" };
  const [row] = await db
    .select()
    .from(schema.pairings)
    .where(and(eq(schema.pairings.codeHash, hash(code)), eq(schema.pairings.serverId, serverId)))
    .limit(1);
  if (!row?.usedAt || !row.pendingLinkEnc || row.approvedAt || row.rejectedAt)
    return { ok: false, error: "There's nothing waiting for approval with this code." };
  if (row.usedAt.getTime() + APPROVE_WITHIN_MS < Date.now()) return { ok: false, error: "This request expired. Run the install command again." };
  const link = decrypt(row.pendingLinkEnc, appSecret());
  if (approve && !link) return { ok: false, error: "The saved link can't be read. Run the install command again." };
  const claimed = await db
    .update(schema.pairings)
    .set(approve ? { approvedAt: new Date(), pendingLinkEnc: null } : { rejectedAt: new Date(), pendingLinkEnc: null })
    .where(
      and(
        eq(schema.pairings.codeHash, row.codeHash),
        isNull(schema.pairings.approvedAt),
        isNull(schema.pairings.rejectedAt),
        isNotNull(schema.pairings.pendingLinkEnc),
      ),
    )
    .returning({ codeHash: schema.pairings.codeHash });
  if (!claimed.length) return { ok: false, error: "This request was already answered." };
  if (approve && link) {
    try {
      await saveLink(serverId, link);
    } catch (e) {
      // put the request back, so "Approve" can simply be clicked again
      await db
        .update(schema.pairings)
        .set({ approvedAt: null, pendingLinkEnc: row.pendingLinkEnc })
        .where(eq(schema.pairings.codeHash, row.codeHash))
        .catch(() => {});
      return { ok: false, error: `Couldn't save the server: ${(e as Error).message}. Try Approve again.` };
    }
  }
  return { ok: true };
}
