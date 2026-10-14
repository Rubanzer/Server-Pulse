import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { getLink } from "@/lib/settings";
import { mintStreamToken } from "@/lib/stream-token";

export const dynamic = "force-dynamic";

/** Owner only: a 60-second, single-use token scoped to the live log stream. */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const { link, demo } = await getLink(s.sid);
  if (demo) return Response.json({ demo: true });
  if (!link) return Response.json({ error: "Connect a server first" }, { status: 400 });
  return Response.json(
    { url: `${link.root}/api/v1/logs/stream`, token: mintStreamToken(link.pass, "logs"), tunnel: link.tunnel },
    { headers: { "cache-control": "no-store" } },
  );
}
