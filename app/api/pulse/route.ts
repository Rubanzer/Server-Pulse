import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { demoPulse } from "@/lib/demo";
import { NetdataError, pulseSnapshot } from "@/lib/netdata";
import { getLink } from "@/lib/settings";
import { getUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

const PAUSED =
  "Live updates are paused to save this month's ngrok requests (80% used). They resume next month, or switch to Tailscale for no limit.";

/** Fallback when the browser can't stream from the agent directly: one frame fetched by the dashboard. */
export async function GET(req: NextRequest) {
  const s = await guard(req);
  if (s instanceof Response) return s;
  const { link, demo, error } = await getLink(s.sid);
  if (demo)
    return Response.json(demoPulse(), {
      headers: { "cache-control": "no-store" },
    });
  if (!link)
    return Response.json(
      { error: error ?? "Connect a server first" },
      { status: 400 },
    );
  // same 80% pause the Live page honours: this fallback must not spend the rest of the ngrok month
  if ((await getUsage(link.sid).catch(() => null))?.paused)
    return Response.json({ error: PAUSED, paused: true }, { status: 429 });
  try {
    return Response.json(await pulseSnapshot(link), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    const status = e instanceof NetdataError && e.status === 404 ? 404 : 502;
    return Response.json(
      {
        error:
          status === 404
            ? "This server runs an older agent or the classic Netdata kit."
            : (e as Error).message,
      },
      { status },
    );
  }
}
