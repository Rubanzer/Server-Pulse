import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { getLink } from "@/lib/settings";
import { catchUpPending, catchUpStep } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Is the dashboard behind the server (never synced, or more than an hour behind)? */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const { link } = await getLink(s.sid);
  return Response.json({ pending: link ? await catchUpPending(s.sid).catch(() => false) : false });
}

/** HIS-2: one budgeted step of copying missing history from the server; the page calls again while `pending`. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const { link, error } = await getLink(s.sid);
  if (!link) return Response.json({ error: error ?? "No server link configured" }, { status: 400 });
  try {
    return Response.json(await catchUpStep(link));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
