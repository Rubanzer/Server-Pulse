import "server-only";
import { sql } from "drizzle-orm";
import { bucketStep } from "@/lib/algo";
import { derive, type Dims, type Metric, type Point } from "@/lib/charts";
import { LIMITS } from "@/lib/config";
import { db } from "@/lib/db";
import { demoSeries } from "@/lib/demo";
import { series, type RawPoint } from "@/lib/netdata";
import { getLink } from "@/lib/settings";

export type History = { source: "netdata" | "database" | "demo"; step: number; points: Point[]; note?: string };

const toPoints = (metric: Metric, raw: RawPoint[]): Point[] => raw.map((p) => ({ t: p.t, v: derive(metric, p.d) }));

/** ≈500 averaged buckets from Postgres via date_bin; the DB does the aggregation, not the function. */
async function fromDb(sid: string, metric: Metric, from: number, to: number, step: number): Promise<RawPoint[]> {
  const r = await db!.execute(sql`
    SELECT extract(epoch FROM date_bin(make_interval(secs => ${step}), s.ts, timestamptz 'epoch'))::bigint AS b,
           kv.key AS k, avg(kv.value::float8) AS v
    FROM samples s, jsonb_each_text(s."values") kv
    WHERE s.server_id = ${sid} AND s.chart = ${metric} AND s.ts >= to_timestamp(${from}) AND s.ts < to_timestamp(${to})
    GROUP BY 1, 2
    ORDER BY 1`);
  // rows arrive ordered by bucket, so pivoting is one linear pass
  const out: RawPoint[] = [];
  let cur: { t: number; d: Dims } | undefined;
  for (const row of r.rows as { b: string; k: string; v: number }[]) {
    const t = Number(row.b);
    if (!cur || cur.t !== t) out.push((cur = { t, d: {} }));
    cur.d[row.k] = Number(row.v);
  }
  return out;
}

/**
 * HIS-3 routing: ranges inside the last 24 h read Netdata (full detail, falls back to the DB);
 * older ranges read Postgres (falls back to Netdata's own 30 days when no DB is connected).
 */
export async function history(sid: string, metric: Metric, from: number, to: number, points: number = LIMITS.historyPoints): Promise<History> {
  const step = bucketStep(to - from, points, 1);
  const state = await getLink(sid);
  if (state.demo) return { source: "demo", step, points: toPoints(metric, demoSeries(metric, from, to, points)) };

  const link = state.link;
  const recent = from >= Date.now() / 1000 - LIMITS.directWindowSec;
  const tryNetdata = async () => toPoints(metric, await series(link!, metric, from, to, points));

  if (link && (recent || !db)) {
    try {
      return { source: "netdata", step, points: await tryNetdata() };
    } catch (e) {
      if (!db) throw e;
    }
  }
  if (!link && !state.error) throw new Error("Connect your server first");
  if (!db) throw new Error(state.error ?? "No database connected");
  const dbStep = bucketStep(to - from, points, 60);
  return {
    source: "database",
    step: dbStep,
    points: toPoints(metric, await fromDb(sid, metric, from, to, dbStep)),
    note: recent ? "Server unreachable — showing stored history" : undefined,
  };
}
