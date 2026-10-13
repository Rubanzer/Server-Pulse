import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { demoLogs, demoRangeLogs } from "@/lib/demo";
import { agentLogs, NetdataError } from "@/lib/netdata";
import { getLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Owner only. Recent lines after a cursor (fallback when the browser can't stream from the agent), or a
 * past window with `since`/`until` (unix seconds), oldest first, paged with `after`.
 */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const q = req.nextUrl.searchParams;
  const prio = Math.min(7, Math.max(0, Number(q.get("prio") ?? 6) || 6));
  const unit = q.get("unit") ?? "";
  if (unit && !/^[A-Za-z0-9@:._-]{1,100}$/.test(unit)) return Response.json({ error: "Invalid service name" }, { status: 400 });
  const after = q.get("after") ?? "";
  if (after.length > 300) return Response.json({ error: "Invalid cursor" }, { status: 400 });
  const since = Math.floor(Number(q.get("since"))) || 0;
  const until = Math.floor(Number(q.get("until"))) || 0;
  if (since < 0 || until < 0 || (since && until && until <= since)) return Response.json({ error: "Pick an end time after the start time." }, { status: 400 });
  const { link, demo, error } = await getLink(s.sid);
  if (demo) return Response.json(since ? demoRangeLogs(since, until, after) : demoLogs(after), { headers: { "cache-control": "no-store" } });
  if (!link) return Response.json({ error: error ?? "Connect a server first" }, { status: 400 });
  try {
    const r = await agentLogs(link, { after: after || undefined, prio, unit: unit || undefined, n: since || after ? 500 : 200, since, until });
    if (since && !r.range)
      // an agent from before time ranges ignores since/until and would answer with the latest lines
      return Response.json({ error: "Browsing past logs needs agent 1.2 or newer. Open Add server and run its one command on your server: it installs the latest agent over the old one and keeps your history." }, { status: 404 });
    return Response.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const status = e instanceof NetdataError && e.status === 404 ? 404 : 502;
    return Response.json(
      { error: status === 404 ? "Live logs need agent 1.2 or newer. Open Add server and run its one command on your server: it installs the latest agent over the old one and keeps your history." : (e as Error).message },
      { status },
    );
  }
}
