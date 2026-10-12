import { type NextRequest } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/auth";
import { METRICS } from "@/lib/charts";
import { history } from "@/lib/history";

export const dynamic = "force-dynamic";

const Query = z
  .object({
    chart: z.enum(METRICS),
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
  try {
    return Response.json(await history(s.sid, q.data.chart, q.data.from, q.data.to, q.data.points));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
