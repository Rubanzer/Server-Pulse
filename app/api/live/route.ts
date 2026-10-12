import { type NextRequest } from "next/server";
import { cached } from "@/lib/algo";
import { guard } from "@/lib/auth";
import { LIMITS, type ServerLink } from "@/lib/config";
import { demoInfo, demoSnapshot } from "@/lib/demo";
import { info, snapshot, type ServerInfo, type Snapshot } from "@/lib/netdata";
import { getLink } from "@/lib/settings";
import { getUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

type Entry = { snap: () => Promise<Snapshot>; info: () => Promise<ServerInfo>; lastSeen: number | null };

// LIV-6: one shared upstream request per refresh interval for every viewer of a server on this instance.
// Keyed by the full credential set, so a link saved with a new password never reuses the old entry.
const entries = new Map<string, Entry>();

function forLink(link: ServerLink): Entry {
  const key = [link.sid, link.base, link.user, link.pass].join("\n");
  const hit = entries.get(key);
  if (hit) return hit;
  for (const k of entries.keys()) if (k.startsWith(link.sid + "\n")) entries.delete(k); // drop the server's old link
  const entry: Entry = {
    lastSeen: null,
    snap: cached(
      async () => {
        const s = await snapshot(link);
        entry.lastSeen = s.t;
        return s;
      },
      () => LIMITS.liveMs[link.tunnel] - 250,
    ),
    info: cached(() => info(link), () => 10 * 60_000),
  };
  entries.set(key, entry);
  return entry;
}

export async function GET(req: NextRequest) {
  const s = await guard(req);
  if (s instanceof Response) return s;
  const state = await getLink(s.sid);
  const headers = { "cache-control": "no-store" };

  if (state.demo)
    return Response.json({ mode: "demo", intervalMs: 2000, tunnel: null, info: demoInfo, snapshot: demoSnapshot() }, { headers });
  if (!state.link && !state.error) return Response.json({ mode: "connect", intervalMs: 30_000 }, { headers });
  if (!state.link) return Response.json({ mode: "error", intervalMs: 10_000, tunnel: null, error: state.error }, { headers });

  const link = state.link;
  const intervalMs = LIMITS.liveMs[link.tunnel];
  if (link.tunnel === "ngrok") {
    const usage = await getUsage(link.sid).catch(() => null);
    if (usage?.paused) return Response.json({ mode: "paused", intervalMs: 60_000, tunnel: link.tunnel, usage }, { headers });
  }
  const e = forLink(link);
  try {
    const [snap, inf] = await Promise.all([e.snap(), e.info().catch(() => null)]);
    return Response.json(
      { mode: "live", intervalMs, tunnel: link.tunnel, info: inf, snapshot: snap, btopUrl: link.root },
      { headers },
    );
  } catch (err) {
    return Response.json(
      { mode: "offline", intervalMs, tunnel: link.tunnel, error: (err as Error).message, lastSeen: e.lastSeen },
      { headers },
    );
  }
}
