// Every tunable limit lives here, so a free-tier change is a one-line edit. Pure: no I/O.

export const LIMITS = {
  liveMs: { funnel: 2_000, ngrok: 10_000, other: 2_000 },
  ngrokMonthlyRequests: 20_000,
  ngrokPauseAt: 0.8,
  requestTimeoutMs: 8_000,
  /** Time one server's nightly catch-up may take before the next server gets its turn. */
  syncBudgetMs: 20_000,
  /** One catch-up step while the owner has the dashboard open (repeated until up to date). */
  catchUpStepMs: 40_000,
  rollupAfterDays: 30,
  /** Ranges that end within this window read Netdata directly (full detail); older ones read Postgres. */
  directWindowSec: 24 * 3600,
  historyPoints: 500,
  offlineEmailAfterSec: 24 * 3600,
  cronThrottleSec: 600,
  /** Hobby cron fires within ±59 min, so "a day offline" allows an hour of slack. */
  cronSlackSec: 3600,
  /** Stop starting new server syncs after this, so the function ends before its 60 s cap. */
  cronBudgetMs: 45_000,
  neonStorageBytes: 512 * 1024 * 1024,
} as const;

export type Tunnel = "funnel" | "ngrok" | "other";

export type ServerLink = {
  /** Netdata base URL without credentials, e.g. https://host.ts.net/history */
  base: string;
  /** Caddy root (where btop lives), e.g. https://host.ts.net */
  root: string;
  host: string;
  user: string;
  pass: string;
  tunnel: Tunnel;
  /** Which server this link belongs to ("env" or an account's server id). */
  sid: string;
  /** Env-configured links are trusted; links typed by accounts go through the SSRF guard. */
  trusted: boolean;
};

export function detectTunnel(host: string): Tunnel {
  if (/\.ngrok(-free)?\.(app|dev|io)$/i.test(host)) return "ngrok";
  if (/\.ts\.net$/i.test(host)) return "funnel";
  return "other";
}

/** Parses `https://USER:PASS@host[/history]`. Throws a readable Error on bad input. */
export function parseServerLink(raw: string, opts: { sid?: string; trusted?: boolean } = {}): ServerLink {
  const trusted = opts.trusted ?? true;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Server link is not a valid URL");
  }
  const httpOk = trusted || !!process.env.ALLOW_PRIVATE_LINKS;
  if (u.protocol !== "https:" && (u.protocol !== "http:" || !httpOk)) throw new Error("Server link must start with https://");
  if (!u.username || !u.password) throw new Error("Server link must include USER:PASS@ before the host");
  const path = u.pathname.replace(/\/+$/, "");
  const root = u.origin;
  return {
    base: root + (path === "" ? "/history" : path),
    root,
    host: u.hostname,
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password),
    tunnel: detectTunnel(u.hostname),
    sid: opts.sid ?? "env",
    trusted,
  };
}

/** For display: never reveal the password. */
export function maskLink(l: ServerLink): string {
  return l.base.replace("://", `://${l.user}:••••••@`);
}

export const envLink = () => process.env.SERVER_URL || process.env.NGROK_URL || "";
export const databaseUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
