import { type NextRequest } from "next/server";
import { z } from "zod";
import { authLimiter, clientIp } from "@/lib/auth";
import { redeemPairingCode } from "@/lib/pairing";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  code: z.string().min(4).max(20),
  link: z.string().min(10).max(2048),
  hostname: z.string().max(200).optional(),
  version: z.string().max(60).optional(),
});

/** Called by the agent (server-to-server, no session): trades a one-time code for storing its link. */
export async function POST(req: NextRequest) {
  if (!authLimiter.hit("pair:" + clientIp(req))) return Response.json({ ok: false, error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: "Bad request" }, { status: 400 });
  const r = await redeemPairingCode(body.data);
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
