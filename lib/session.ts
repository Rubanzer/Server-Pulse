import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { databaseUrl, envLink, parseServerLink } from "@/lib/config";
import { ENV_SERVER } from "@/lib/db/schema";

// Session cookies only: no database access here, so proxy.ts can import it cheaply.

export type Role = "owner" | "viewer";
export type Session = {
  role: Role;
  /** Server whose data this session sees ("env" or the account's server id). */
  sid: string;
  /** Account id; absent for the shared env passwords. */
  uid?: string;
  email?: string;
  /** Fingerprint of the credential used to log in; a changed or removed password ends the session. */
  pv: string;
};

export const COOKIE = "sp_session";
const MAX_AGE = 30 * 86400;

function envPass(): string | null {
  try {
    return envLink() ? parseServerLink(envLink()).pass : null;
  } catch {
    return null;
  }
}

/** Demo mode = nothing configured in the environment. Only then is the shared password "demo". */
export const demoAuth = () => !envLink() && !process.env.DASHBOARD_PASSWORD;

export function ownerPassword(): string | null {
  return process.env.DASHBOARD_PASSWORD || envPass() || (demoAuth() ? "demo" : null);
}

/**
 * Saving a link in the app: always for accounts (their own server). For the shared env server only once
 * login no longer depends on the public demo password, i.e. SERVER_URL or DASHBOARD_PASSWORD is set.
 */
export const canSaveLink = (s: Pick<Session, "uid">) => !!s.uid || !demoAuth();

/** Signs cookies and encrypts stored links. SESSION_SECRET is best; the fallbacks are server-only values. */
export const appSecret = () =>
  process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || envLink() || databaseUrl() || "demo";

const key = () => new Uint8Array(createHash("sha256").update("server-pulse:" + appSecret()).digest());

export const fingerprint = (s: string) => createHash("sha256").update("pv:" + s).digest("base64url").slice(0, 16);

/** Constant-time compare that also hides length differences. */
export function same(a: string, b: string) {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

/** Shared (env) passwords → role. */
export function roleForPassword(pw: string): Role | null {
  const owner = ownerPassword();
  if (owner && same(pw, owner)) return "owner";
  const viewer = process.env.VIEWER_PASSWORD;
  if (viewer && same(pw, viewer)) return "viewer";
  return null;
}

export const envSession = (role: Role): Session => ({
  role,
  sid: ENV_SERVER,
  pv: fingerprint((role === "owner" ? ownerPassword() : process.env.VIEWER_PASSWORD) ?? ""),
});

export async function signSession(s: Session) {
  return new SignJWT({ ...s }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(key());
}

/** Signature + expiry + (for shared passwords) the password still being the one used to log in. */
export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload: p } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if ((p.role !== "owner" && p.role !== "viewer") || typeof p.sid !== "string" || typeof p.pv !== "string") return null;
    const s: Session = { role: p.role, sid: p.sid, pv: p.pv };
    if (typeof p.uid === "string") s.uid = p.uid;
    if (typeof p.email === "string") s.email = p.email;
    if (!s.uid) {
      const current = s.role === "owner" ? ownerPassword() : process.env.VIEWER_PASSWORD;
      if (!current || s.pv !== fingerprint(current)) return null; // password changed or removed
    }
    return s;
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE,
};
