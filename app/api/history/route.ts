import { type NextRequest } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { METRICS } from "@/lib/charts";
import { history, historyMany } from "@/lib/history";

export const dynamic = "force-dynamic";

const Query = z
  .object({
    /** one chart; without it, every chart in one response (one database query) */
    chart: z.enum(METRICS).optional(),
    from: z.coerce.number().int().positive(),
    to: z.coerce.number().int().positive(),
    points: z.coerce.number().int().min(10).max(2000).optional(),
  })
  .refine((q) => q.from < q.to && q.to - q.from <= 2 * 366 * 86400, "from must be before to, range at most 2 years");

export async function GET(req: NextRequest) {
  const s = await guard(req);
  if (s instanceof Response) return s;
  const q = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return Response.json({ error: q.error.issues[0]?.message ?? "Bad query" }, { status: 400 });
  const { chart, from, to, points } = q.data;
  // a window that ended over an hour ago only changes when a catch-up fills it: the browser may reuse it briefly
  const headers = { "cache-control": to < Date.now() / 1000 - 3600 ? "private, max-age=120" : "no-store" };
  try {
    return Response.json(chart ? await history(s.sid, chart, from, to, points) : { charts: await historyMany(s.sid, METRICS, from, to, points) }, { headers });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
