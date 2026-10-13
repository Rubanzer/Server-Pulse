import { type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sessionOf } from "@/lib/auth";
import { LIMITS } from "@/lib/config";
import { db } from "@/lib/db";
import { getLink, getSetting, setSetting } from "@/lib/settings";
import { syncAll, syncServer } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bearerOk(req: NextRequest) {
  const s = process.env.CRON_SECRET;
  if (!s) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${s}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Vercel Cron (Bearer CRON_SECRET, or a 10-minute throttle when no secret is set) syncs every server.
 * An owner's "Sync now" (session) syncs only their own server.
 */
async function handle(req: NextRequest) {
  const s = await sessionOf(req);
  if (s?.role === "owner" && !bearerOk(req)) {
    const result = await syncServer((await getLink(s.sid)).link);
    return Response.json(result, { status: result.status === "error" ? 502 : 200 });
  }
  if (!bearerOk(req)) {
    if (process.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const last = Number(await getSetting("last_cron_at").catch(() => 0)) || 0;
    if (Date.now() / 1000 - last < LIMITS.cronThrottleSec)
      return Response.json({ error: "Throttled: runs at most once per 10 minutes" }, { status: 429 });
  }
  if (db) await setSetting("last_cron_at", String(Math.floor(Date.now() / 1000)));
  return Response.json(await syncAll());
}

export const GET = handle;
export const POST = handle;
