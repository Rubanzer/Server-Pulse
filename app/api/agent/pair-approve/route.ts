import { type NextRequest } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { decidePairing } from "@/lib/pairing";

export const dynamic = "force-dynamic";

const Body = z.object({ code: z.string().min(4).max(20), approve: z.boolean() });

/** The owner approves or rejects a server that redeemed their pairing code. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: "Bad request" }, { status: 400 });
  const r = await decidePairing(body.data.code, s.sid, body.data.approve);
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
