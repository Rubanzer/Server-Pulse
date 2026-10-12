import "server-only";
import { eq } from "drizzle-orm";
import { WindowLimiter } from "@/lib/algo";
import { db, schema } from "@/lib/db";
import { COOKIE, fingerprint, verifySession, type Role, type Session } from "@/lib/session";

export * from "@/lib/session";

// ponytail: per-instance limiter (10 tries / 15 min / IP) shared by login and sign-up; add a Vercel WAF
// rate-limit rule for a global one.
export const authLimiter = new WindowLimiter(10, 15 * 60_000);
export const clientIp = (req: { headers: Headers }) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

/** Accounts can sign up when a database is connected, unless DISABLE_SIGNUP is set. */
export const signupOpen = () => !!db && !process.env.DISABLE_SIGNUP;

// Account sessions are re-checked against the DB so a changed password or deleted account logs out
// other devices. ponytail: cached 5 min per instance so live polling doesn't keep Neon awake.
const accountCheck = new Map<string, { ok: boolean; at: number }>();

async function accountValid(s: Session): Promise<boolean> {
  if (!s.uid) return true;
  if (!db) return false;
  const key = s.uid + s.pv;
  const hit = accountCheck.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.ok;
  try {
    const [u] = await db.select({ h: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, s.uid)).limit(1);
    const ok = !!u && fingerprint(u.h) === s.pv;
    accountCheck.set(key, { ok, at: Date.now() });
    return ok;
  } catch {
    // DB hiccup: keep the last verified answer so users aren't logged out, but never trust an
    // account this instance hasn't verified (fail closed)
    return hit?.ok ?? false;
  }
}

export const forgetAccountCheck = (uid: string) => {
  for (const k of accountCheck.keys()) if (k.startsWith(uid)) accountCheck.delete(k);
};

type HasCookies = { cookies: { get(name: string): { value: string } | undefined } };

export async function sessionOf(req: HasCookies): Promise<Session | null> {
  const s = await verifySession(req.cookies.get(COOKIE)?.value);
  return s && (await accountValid(s)) ? s : null;
}

/** Route guard: the session, or an error Response to return as-is. */
export async function guard(req: HasCookies, need: Role = "viewer"): Promise<Session | Response> {
  const s = await sessionOf(req);
  if (!s) return Response.json({ error: "Not logged in" }, { status: 401 });
  if (need === "owner" && s.role !== "owner") return Response.json({ error: "Owner only" }, { status: 403 });
  return s;
}
