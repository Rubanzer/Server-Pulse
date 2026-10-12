import { type NextRequest } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { demoReport, monthlyReport } from "@/lib/reports";
import { getLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await guard(req);
  if (s instanceof Response) return s;
  if ((await getLink(s.sid)).demo) return Response.json({ source: "demo", months: demoReport() });
  if (!db) return Response.json({ error: "Connect a Neon database to keep monthly history" }, { status: 503 });
  try {
    return Response.json({ source: "database", months: await monthlyReport(s.sid) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
