import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { isMetric } from "@/lib/charts";
import { getLink } from "@/lib/settings";
import { backfill, backfillPending } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Which metrics still need their 30-day import. */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const { link } = await getLink(s.sid);
  return Response.json({ pending: link ? await backfillPending(s.sid).catch(() => []) : [] });
}

/** HIS-2: import one metric per request, so no call gets near the function time cap. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const chart = req.nextUrl.searchParams.get("chart");
  if (!isMetric(chart)) return Response.json({ error: "Unknown chart" }, { status: 400 });
  const { link, error } = await getLink(s.sid);
  if (!link) return Response.json({ error: error ?? "No server link configured" }, { status: 400 });
  try {
    return Response.json({ chart, rows: await backfill(link, chart) });
  } catch (e) {
    return Response.json({ chart, error: (e as Error).message }, { status: 502 });
  }
}
