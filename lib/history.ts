import "server-only";
import { like, sql } from "drizzle-orm";
import { bucketStep, coverage, findGaps, gapReason, type Gap, type RunInfo } from "@/lib/algo";
import { derive, METRICS, type Dims, type Metric, type Point } from "@/lib/charts";
import { LIMITS } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { demoSeries } from "@/lib/demo";
import { series, type RawPoint } from "@/lib/netdata";
import { getLink, getSetting, k } from "@/lib/settings";

export type History = {
  source: "netdata" | "database" | "demo";
  step: number;
  /** a null-valued point sits inside every gap, so lines break there instead of bridging it */
  points: Point[];
  note?: string;
  /** holes inside [max(from, firstSample), min(to, now)], with why they exist */
  gaps: Gap[];
  /** the oldest reading this server has anywhere (dashboard or agent); null = nothing yet */
  firstSample: number | null;
  /** share of the monitored part of the window that has data, 0..1 */
  coverage: number;
};
export type HistoryResult = History | { error: string };

type Bucketed = RawPoint & { r: number };

/**
 * ≈500 buckets for several charts in ONE query. Averages are weighted by resolution, so buckets that
 * mix hourly and 1-minute rows aren't skewed toward the denser rows; `r` is the coarsest resolution in
 * the bucket, which sets how far apart rows may be before it counts as a gap.
 */
async function fromDb(sid: string, metrics: readonly Metric[], from: number, to: number, step: number): Promise<Map<Metric, Bucketed[]>> {
  const r = await db!.execute(sql`
    SELECT s.chart AS c,
           extract(epoch FROM date_bin(make_interval(secs => ${step}), s.ts, timestamptz 'epoch'))::bigint AS b,
           kv.key AS k,
           sum(kv.value::float8 * s.resolution_s) / sum(s.resolution_s) AS v,
           max(s.resolution_s) AS r
    FROM samples s, jsonb_each_text(s."values") kv
    WHERE s.server_id = ${sid} AND s.chart IN (${sql.join(
      metrics.map((m) => sql`${m}`),
      sql`, `,
    )}) AND s.ts >= to_timestamp(${from}) AND s.ts < to_timestamp(${to})
    GROUP BY 1, 2, 3
    ORDER BY 1, 2`);
  // rows arrive ordered by chart then bucket, so pivoting is one linear pass
  const out = new Map<Metric, Bucketed[]>();
  let cur: Bucketed | undefined;
  for (const row of r.rows as { c: Metric; b: string; k: string; v: number; r: number }[]) {
    const t = Number(row.b);
    let list = out.get(row.c);
    if (!list) out.set(row.c, (list = []));
    if (!cur || cur.t !== t || list[list.length - 1] !== cur) list.push((cur = { t, d: {}, r: Number(row.r) }));
    cur.d[row.k] = Number(row.v);
  }
  return out;
}

/** Seconds of readings stored per chart in [from, to): each row covers its own resolution. */
async function coveredSeconds(sid: string, metrics: readonly Metric[], from: number, to: number): Promise<Partial<Record<Metric, number>>> {
  const r = await db!.execute(sql`
    SELECT chart AS c, sum(resolution_s)::float8 AS s FROM samples
    WHERE server_id = ${sid} AND chart IN (${sql.join(
      metrics.map((m) => sql`${m}`),
      sql`, `,
    )}) AND ts >= to_timestamp(${from}) AND ts < to_timestamp(${to})
    GROUP BY 1`);
  return Object.fromEntries((r.rows as { c: Metric; s: number }[]).map((x) => [x.c, Number(x.s)]));
}

/** The oldest stored reading of each chart (one index probe each) and how far the dashboard has copied. */
async function dbBounds(sid: string): Promise<{ first: Partial<Record<Metric, number>>; syncedTo: number | null }> {
  if (!db) return { first: {}, syncedTo: null };
  const [firstRow, marks] = await Promise.all([
    db.execute(sql`
      SELECT c, extract(epoch FROM (SELECT min(ts) FROM samples WHERE server_id = ${sid} AND chart = c))::bigint AS first
      FROM unnest(ARRAY[${sql.join(
        METRICS.map((m) => sql`${m}`),
        sql`, `,
      )}]::text[]) AS c`),
    db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(like(schema.settings.key, k(sid, "synced_to:%"))),
  ]);
  const first: Partial<Record<Metric, number>> = {};
  for (const r of firstRow.rows as { c: Metric; first: string | null }[]) if (r.first) first[r.c] = Number(r.first);
  const synced = marks.map((m) => Number(m.value)).filter((n) => n > 0);
  return { first, syncedTo: synced.length ? Math.min(...synced) : null };
}

/** What the agent told the last sync: its oldest reading and its start history. */
async function agentFacts(sid: string): Promise<{ oldest: number | null; runs: RunInfo[] }> {
  const [oldest, runs] = await Promise.all([getSetting(k(sid, "agent_oldest")), getSetting(k(sid, "agent_runs"))]);
  let parsed: RunInfo[] = [];
  try {
    parsed = runs ? (JSON.parse(runs) as RunInfo[]) : [];
  } catch {}
  return { oldest: Number(oldest) || null, runs: parsed };
}

/** Points → display values with a null point inside each gap, the labelled gaps and the coverage. */
function finish(
  metric: Metric,
  raw: (RawPoint & { r?: number })[],
  o: {
    from: number;
    to: number;
    step: number;
    source: History["source"];
    first: number | null;
    syncedTo: number | null;
    runs: RunInfo[];
    note?: string;
    /** seconds of stored readings in the window (database): exact coverage at any zoom level */
    covered?: number;
  },
): History {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.max(o.from, o.first ?? raw[0]?.t ?? o.to);
  const end = Math.min(o.to, now - 120); // the current minute is still being averaged
  const res = new Map(raw.map((p) => [p.t, p.r ?? 0]));
  const holes =
    o.first === null && !raw.length
      ? []
      : findGaps(
          raw.map((p) => p.t),
          start,
          end,
          (t) => 2 * Math.max(o.step, res.get(t) ?? 0) + 1,
        );
  const gaps: Gap[] = holes.map((g) => {
    const seen = { from: g.from, to: g.to >= end ? now : g.to }; // a hole up to the window's end may be explained by a restart after it
    return { ...g, reason: gapReason(seen, o.source === "database" ? o.syncedTo : null, o.runs) };
  });

  const blank = Object.fromEntries(Object.keys(derive(metric, {})).map((key) => [key, null])) as unknown as Dims;
  const points: Point[] = [];
  let gi = 0;
  for (const p of raw) {
    while (gi < gaps.length && gaps[gi]!.to <= p.t) points.push({ t: Math.round((gaps[gi]!.from + gaps[gi++]!.to) / 2), v: blank });
    points.push({ t: p.t, v: derive(metric, p.d) });
  }
  while (gi < gaps.length) points.push({ t: Math.round((gaps[gi]!.from + gaps[gi++]!.to) / 2), v: blank });
  points.sort((a, b) => a.t - b.t);

  return { source: o.source, step: o.step, points, note: o.note, gaps, firstSample: o.first ?? raw[0]?.t ?? null, coverage: o.covered !== undefined && end > start ? Math.min(1, o.covered / (end - start)) : coverage(start, end, gaps) };
}

/**
 * HIS-3 routing for one or more charts: ranges inside the last 24 h read the server (full detail,
 * falls back to the DB); older ranges read Postgres in one query (falls back to the server's own
 * 30 days when no DB is connected).
 */
export async function historyMany(
  sid: string,
  metrics: readonly Metric[],
  from: number,
  to: number,
  points: number = LIMITS.historyPoints,
): Promise<Record<string, HistoryResult>> {
  const step = bucketStep(to - from, points, 1);
  const state = await getLink(sid);
  const out: Record<string, HistoryResult> = {};
  if (state.demo) {
    for (const m of metrics) out[m] = finish(m, demoSeries(m, from, to, points), { from, to, step, source: "demo", first: from, syncedTo: null, runs: [] });
    return out;
  }
  const link = state.link;
  if (!link && !state.error) throw new Error("Connect your server first");
  const [bounds, agent] = await Promise.all([dbBounds(sid), agentFacts(sid)]);
  // where each chart's history starts: the oldest copy we have, or what the agent still holds. A chart
  // that never had a reading (no temperature sensors) has no start, so it shows "no readings", not a gap.
  const firstOf = (m: Metric, raw: RawPoint[]) => {
    const known = [bounds.first[m], raw.length ? (agent.oldest ?? raw[0]!.t) : undefined].filter((x): x is number => !!x);
    return known.length ? Math.min(...known) : null;
  };
  const base = { from, to, syncedTo: bounds.syncedTo, runs: agent.runs };

  const recent = from >= Date.now() / 1000 - LIMITS.directWindowSec;
  let fromDbList = [...metrics];
  if (link && (recent || !db)) {
    fromDbList = [];
    await Promise.all(
      metrics.map(async (m) => {
        try {
          const raw = await series(link, m, from, to, points);
          out[m] = finish(m, raw, { ...base, first: firstOf(m, raw), step, source: "netdata" });
        } catch (e) {
          if (db) fromDbList.push(m);
          else out[m] = { error: (e as Error).message };
        }
      }),
    );
  }
  if (!fromDbList.length) return out;
  if (!db) throw new Error(state.error ?? "No database connected");
  const dbStep = bucketStep(to - from, points, 60);
  const [rows, covered] = await Promise.all([fromDb(sid, fromDbList, from, to, dbStep), coveredSeconds(sid, fromDbList, from, to)]);
  for (const m of fromDbList) {
    const raw = rows.get(m) ?? [];
    out[m] = finish(m, raw, {
      ...base,
      first: firstOf(m, raw),
      step: dbStep,
      source: "database",
      covered: covered[m] ?? 0, // finish() divides by the monitored part of the window only
      note: recent ? "Server unreachable, showing stored history" : undefined,
    });
  }
  return out;
}

export async function history(sid: string, metric: Metric, from: number, to: number, points: number = LIMITS.historyPoints): Promise<History> {
  const r = (await historyMany(sid, [metric], from, to, points))[metric]!;
  if ("error" in r) throw new Error(r.error);
  return r;
}
