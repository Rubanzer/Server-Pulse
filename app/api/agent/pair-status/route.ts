import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { pairingStatus } from "@/lib/pairing";

export const dynamic = "force-dynamic";

/** Polled by the Add server screen while it waits for the agent. */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  return Response.json(await pairingStatus(code, s.sid), { headers: { "cache-control": "no-store" } });
}
