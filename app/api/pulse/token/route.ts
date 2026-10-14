import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { getLink } from "@/lib/settings";
import { getUsage } from "@/lib/usage";
import { mintStreamToken } from "@/lib/stream-token";

export const dynamic = "force-dynamic";

const PAUSED =
  "Live updates are paused to save this month's ngrok requests (80% used). They resume next month, or switch to Tailscale for no limit.";

/**
 * A 60-second, single-use token that lets this browser stream straight from the agent (no Vercel hop,
 * no request per frame). Signed with a key derived from the server link's password, which never leaves
 * the dashboard; the token travels in a header, never in a URL.
 */
export async function GET(req: NextRequest) {
  const s = await guard(req);
  if (s instanceof Response) return s;
  const { link, demo } = await getLink(s.sid);
  if (demo) return Response.json({ demo: true });
  if (!link)
    return Response.json({ error: "Connect a server first" }, { status: 400 });
  // a direct stream through ngrok also counts: none while the 80% monthly pause is on
  if ((await getUsage(link.sid).catch(() => null))?.paused)
    return Response.json({ error: PAUSED, paused: true }, { status: 429 });
  return Response.json(
    {
      url: `${link.root}/api/v1/pulse/stream`,
      token: mintStreamToken(link.pass, "pulse"),
      tunnel: link.tunnel,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
