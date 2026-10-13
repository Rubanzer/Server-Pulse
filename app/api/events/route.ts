import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { demoEvents } from "@/lib/demo";
import { countEvents, fromAgent, listEvents, pullThrottled, type Severity } from "@/lib/events";
import { agentEvents } from "@/lib/netdata";
import { getLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

const SEV = ["critical", "error", "warning", "info"] as const;

/** Owner only. Failure history, newest first: pulls anything new from the agent, then reads the database. */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const q = req.nextUrl.searchParams;
  const severities = (q.get("severity") ?? "").split(",").filter((x): x is Severity => (SEV as readonly string[]).includes(x));
  const before = Number(q.get("before")) || undefined;
  const since = Number(q.get("since")) || undefined;
  const until = Number(q.get("until")) || undefined;
  const inWindow = (e: { ts: number; last: number }) => (!since || e.last >= since) && (!until || e.ts <= until);
  const tally = (list: { severity: string }[]) => {
    const c: Record<string, number> = {};
    for (const e of list) c[e.severity] = (c[e.severity] ?? 0) + 1;
    return c;
  };
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const { link, demo } = await getLink(s.sid);
  if (demo) {
    const all = demoEvents().filter(inWindow);
    const list = severities.length ? all.filter((e) => (severities as string[]).includes(e.severity)) : all;
    return Response.json({ events: list.filter((e) => !before || e.id < before).slice(0, limit), counts: tally(all), stored: false });
  }

  let note: string | undefined;
  if (link) {
    try {
      if (db) await pullThrottled(link);
    } catch (e) {
      note = `Couldn't fetch new failures from the server right now (${(e as Error).message}). Showing what's saved.`;
    }
  }
  if (db) {
    const [events, counts] = await Promise.all([
      listEvents(s.sid, { before, severities, limit, since, until }),
      before ? Promise.resolve(undefined) : countEvents(s.sid, { since, until }),
    ]);
    return Response.json({ events, counts, stored: true, note }, { headers: { "cache-control": "no-store" } });
  }
  // no database: the agent's own recent copy (it keeps the last 2,000)
  if (!link) return Response.json({ events: [], stored: false });
  try {
    const r = await agentEvents(link, 0, 0);
    const all = fromAgent(r?.events ?? []).filter(inWindow);
    let list = severities.length ? all.filter((e) => severities.includes(e.severity)) : all;
    if (before) list = list.filter((e) => e.id < before);
    return Response.json({ events: list.slice(0, limit), counts: tally(all), stored: false, note: r ? undefined : "This agent doesn't record failures yet. Open Add server and run its one command on your server: it installs the latest agent over the old one and keeps your history." });
  } catch (e) {
    return Response.json({ events: [], stored: false, note: (e as Error).message });
  }
}
