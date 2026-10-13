import "server-only";
import { eq, sql } from "drizzle-orm";
import { cached } from "@/lib/algo";
import { envLink, parseServerLink, type ServerLink } from "@/lib/config";
import { decrypt, encrypt } from "@/lib/crypto";
import { db, schema } from "@/lib/db";
import { ENV_SERVER } from "@/lib/db/schema";
import { appSecret } from "@/lib/session";

export async function getSetting(key: string): Promise<string | null> {
  if (!db) return null;
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  if (!db) throw new Error("No database connected");
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

export async function deleteSetting(key: string) {
  if (!db) return;
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
}

/** Atomic `value += n` on a numeric setting; returns the new total. */
export async function incrementSetting(key: string, n: number): Promise<number> {
  if (!db) return n;
  const rows = await db
    .insert(schema.settings)
    .values({ key, value: String(n) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`(${schema.settings.value}::bigint + ${n})::text` },
    })
    .returning({ value: schema.settings.value });
  return Number(rows[0]?.value ?? n);
}

/** Per-server setting key. */
export const k = (sid: string, key: string) => `${sid}:${key}`;

export type LinkState = {
  link: ServerLink | null;
  error: string | null;
  source: "settings" | "env" | "account" | null;
  /** Shared/env server with nothing configured → generated demo data. */
  demo: boolean;
};

async function resolve(sid: string): Promise<LinkState> {
  if (sid === ENV_SERVER) {
    const enc = await getSetting(k(sid, "server_url")).catch(() => null);
    const fromDb = enc ? decrypt(enc, appSecret()) : null;
    const raw = fromDb || envLink();
    if (!raw) return { link: null, error: null, source: null, demo: true };
    const source = fromDb ? "settings" : "env";
    try {
      // only the SERVER_URL env var is trusted; a link saved in the app (Settings or pairing) is guarded
      return { link: parseServerLink(raw, { sid, trusted: !fromDb }), error: null, source, demo: false };
    } catch (e) {
      return { link: null, error: (e as Error).message, source, demo: false };
    }
  }
  if (!db) return { link: null, error: "No database connected", source: "account", demo: false };
  const [row] = await db.select({ enc: schema.servers.linkEnc }).from(schema.servers).where(eq(schema.servers.id, sid)).limit(1);
  if (!row?.enc) return { link: null, error: null, source: "account", demo: false };
  const raw = decrypt(row.enc, appSecret());
  if (!raw) return { link: null, error: "Saved link can't be read (the app secret changed). Connect your server again.", source: "account", demo: false };
  try {
    return { link: parseServerLink(raw, { sid, trusted: false }), error: null, source: "account", demo: false };
  } catch (e) {
    return { link: null, error: (e as Error).message, source: "account", demo: false };
  }
}

// cached 10 min per server per instance (saving a link calls invalidateLink()). Reading it every 30 s
// kept a serverless Postgres from ever sleeping while a Live tab was open.
const caches = new Map<string, ReturnType<typeof cached<LinkState>>>();
export function getLink(sid: string): Promise<LinkState> {
  let c = caches.get(sid);
  if (!c) caches.set(sid, (c = cached(() => resolve(sid), () => 600_000)));
  return c();
}
export const invalidateLink = (sid: string) => caches.get(sid)?.reset();

/** Save a link for a server: env server → settings override; account → encrypted on its row. */
export async function saveLink(sid: string, raw: string) {
  if (!db) throw new Error("No database connected");
  if (sid === ENV_SERVER) await setSetting(k(sid, "server_url"), encrypt(raw, appSecret()));
  else await db.update(schema.servers).set({ linkEnc: encrypt(raw, appSecret()) }).where(eq(schema.servers.id, sid));
  invalidateLink(sid);
}

export async function clearLink(sid: string) {
  if (sid === ENV_SERVER) await deleteSetting(k(sid, "server_url"));
  else if (db) await db.update(schema.servers).set({ linkEnc: null }).where(eq(schema.servers.id, sid));
  invalidateLink(sid);
}
