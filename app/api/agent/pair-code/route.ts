import { type NextRequest } from "next/server";
import { canSaveLink, guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { createPairingCode } from "@/lib/pairing";

export const dynamic = "force-dynamic";

/** Owner asks for a one-time install command for their server. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  if (!db) return Response.json({ error: "Finish setup first: this dashboard has no database yet." }, { status: 503 });
  // with only the public demo password protecting this dashboard, nobody may attach a server to it
  if (!canSaveLink(s))
    return Response.json({ error: "Create an account first (or set SERVER_URL / DASHBOARD_PASSWORD in Vercel), then add a server." }, { status: 403 });
  const { code, expiresAt } = await createPairingCode(s.sid);
  const origin = req.nextUrl.origin;
  return Response.json({
    code,
    expiresAt,
    command: `curl -fsSL ${origin}/install.sh | sudo bash -s -- ${code}`,
  });
}
