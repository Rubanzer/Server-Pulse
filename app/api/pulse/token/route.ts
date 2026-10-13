import { type NextRequest } from "next/server";
import { createHmac, randomBytes } from "node:crypto";
import { guard } from "@/lib/auth";
import { STREAM_KEY_LABEL } from "@/lib/pulse";
import { getLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

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
  if (!link) return Response.json({ error: "Connect a server first" }, { status: 400 });
  const key = createHmac("sha256", link.pass).update(STREAM_KEY_LABEL).digest();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const nonce = randomBytes(12).toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${exp}.${nonce}`).digest("base64url");
  return Response.json(
    { url: `${link.root}/api/v1/pulse/stream`, token: `v1.${exp}.${nonce}.${sig}`, tunnel: link.tunnel },
    { headers: { "cache-control": "no-store" } },
  );
}
