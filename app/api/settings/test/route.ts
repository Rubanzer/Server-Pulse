import { type NextRequest } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { parseServerLink } from "@/lib/config";
import { info } from "@/lib/netdata";
import { getLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().max(2048).optional() });

/** Connection test with the exact error text on failure. Tests the given link, or the current one. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return Response.json({ ok: false, error: "Bad request" }, { status: 400 });
  const started = Date.now();
  try {
    const state = await getLink(s.sid);
    // a typed link is never trusted: it goes through the SSRF guard (only SERVER_URL from the env is)
    const link = body.data.url ? parseServerLink(body.data.url, { sid: s.sid, trusted: false }) : state.link;
    if (!link) return Response.json({ ok: false, error: state.error ?? "No server link configured" });
    const i = await info(link);
    return Response.json({ ok: true, ms: Date.now() - started, info: i, tunnel: link.tunnel });
  } catch (e) {
    return Response.json({ ok: false, ms: Date.now() - started, error: (e as Error).message });
  }
}
