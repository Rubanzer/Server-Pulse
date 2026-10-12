import "server-only";
import { cached } from "@/lib/algo";
import { LIMITS, type ServerLink } from "@/lib/config";
import { getSetting, incrementSetting, k } from "@/lib/settings";

// ngrok budget meter (LIV-5), per server. Counts every request this app sends through an ngrok tunnel.
// ponytail: per-instance counters flushed to Postgres every FLUSH_EVERY requests; a recycled instance
// can lose up to FLUSH_EVERY-1 counts, so the meter slightly under-reads. Use ngrok's API if exactness matters.
const FLUSH_EVERY = 10;
const pending = new Map<string, number>();

const monthKey = (sid: string, d = new Date()) => k(sid, `ngrok_usage:${d.toISOString().slice(0, 7)}`);

export function countRequest(link: ServerLink) {
  if (link.tunnel !== "ngrok") return;
  const n = (pending.get(link.sid) ?? 0) + 1;
  pending.set(link.sid, n);
  if (n >= FLUSH_EVERY) void flushUsage(link.sid);
}

export async function flushUsage(sid: string) {
  const n = pending.get(sid) ?? 0;
  if (!n) return;
  pending.set(sid, 0);
  try {
    await incrementSetting(monthKey(sid), n);
    caches.get(sid)?.reset();
  } catch {
    pending.set(sid, (pending.get(sid) ?? 0) + n); // keep the counts for the next flush
  }
}

export type Usage = { month: string; used: number; limit: number; pct: number; resetsAt: string; paused: boolean };

async function readUsage(sid: string): Promise<Usage> {
  const now = new Date();
  const used = Number((await getSetting(monthKey(sid, now)).catch(() => null)) ?? 0) + (pending.get(sid) ?? 0);
  const limit = LIMITS.ngrokMonthlyRequests;
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    month: now.toISOString().slice(0, 7),
    used,
    limit,
    pct: used / limit,
    resetsAt: reset.toISOString(),
    paused: used >= limit * LIMITS.ngrokPauseAt,
  };
}

const caches = new Map<string, ReturnType<typeof cached<Usage>>>();
export function getUsage(sid: string): Promise<Usage> {
  let c = caches.get(sid);
  if (!c) caches.set(sid, (c = cached(() => readUsage(sid), () => 60_000)));
  return c();
}
