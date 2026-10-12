import "server-only";
import { sql } from "drizzle-orm";
import { derive } from "@/lib/charts";
import { db } from "@/lib/db";
import { demoRaw } from "@/lib/demo";

export type MonthRow = {
  month: number; // unix seconds, first instant of the month (UTC)
  cpuAvg: number | null;
  cpuPeak: number | null;
  ramAvg: number | null;
  ramPeak: number | null;
  loadAvg: number | null;
  loadPeak: number | null;
  netInGB: number | null;
  netOutGB: number | null;
  diskPeak: number | null;
};

const KBIT_S_TO_GB = 1 / 8 / 1024 / 1024; // kbit/s × s → kB → GB

/**
 * HIS-6: 12 months of aggregates in one query. Averages are weighted by resolution_s, so months
 * that mix 1-minute and hourly rows are not skewed toward the denser rows.
 */
export async function monthlyReport(sid: string): Promise<MonthRow[]> {
  if (!db) return [];
  const r = await db.execute(sql`
    WITH r AS (
      SELECT date_trunc('month', ts, 'UTC') AS m, chart, resolution_s AS w,
             (SELECT sum(value::float8) FROM jsonb_each_text("values")) AS total,
             ("values"->>'used')::float8 AS used,
             ("values"->>'avail')::float8 AS avail,
             ("values"->>'load1')::float8 AS load1,
             abs(("values"->>'received')::float8) AS rx,
             abs(("values"->>'sent')::float8) AS tx
      FROM samples
      WHERE server_id = ${sid} AND ts >= date_trunc('month', now(), 'UTC') - interval '11 months'
    )
    SELECT extract(epoch FROM m)::bigint AS month,
      sum(total * w) FILTER (WHERE chart = 'cpu') / nullif(sum(w) FILTER (WHERE chart = 'cpu'), 0) AS cpu_avg,
      max(total) FILTER (WHERE chart = 'cpu') AS cpu_peak,
      sum(100 * used / nullif(total, 0) * w) FILTER (WHERE chart = 'ram') / nullif(sum(w) FILTER (WHERE chart = 'ram'), 0) AS ram_avg,
      max(100 * used / nullif(total, 0)) FILTER (WHERE chart = 'ram') AS ram_peak,
      sum(load1 * w) FILTER (WHERE chart = 'load') / nullif(sum(w) FILTER (WHERE chart = 'load'), 0) AS load_avg,
      max(load1) FILTER (WHERE chart = 'load') AS load_peak,
      sum(rx * w) FILTER (WHERE chart = 'net') * ${KBIT_S_TO_GB} AS net_in,
      sum(tx * w) FILTER (WHERE chart = 'net') * ${KBIT_S_TO_GB} AS net_out,
      max(100 * used / nullif(used + avail, 0)) FILTER (WHERE chart = 'disk') AS disk_peak
    FROM r GROUP BY m ORDER BY m DESC`);
  const n = (v: unknown) => (v == null ? null : Number(v));
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    month: Number(x.month),
    cpuAvg: n(x.cpu_avg),
    cpuPeak: n(x.cpu_peak),
    ramAvg: n(x.ram_avg),
    ramPeak: n(x.ram_peak),
    loadAvg: n(x.load_avg),
    loadPeak: n(x.load_peak),
    netInGB: n(x.net_in),
    netOutGB: n(x.net_out),
    diskPeak: n(x.disk_peak),
  }));
}

/** Same shape from demo data, sampled hourly. */
export function demoReport(): MonthRow[] {
  const out: MonthRow[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1) / 1000;
    const end = Math.min(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1) / 1000, Date.now() / 1000);
    const acc = { cpu: [] as number[], ram: [] as number[], load: [] as number[], disk: [] as number[], rx: 0, tx: 0 };
    for (let t = start; t < end; t += 3600) {
      acc.cpu.push(derive("cpu", demoRaw("cpu", t)).cpu!);
      acc.ram.push(derive("ram", demoRaw("ram", t)).pct!);
      acc.load.push(demoRaw("load", t).load1!);
      acc.disk.push(derive("disk", demoRaw("disk", t)).pct!);
      const net = derive("net", demoRaw("net", t));
      acc.rx += net.in! * 3600;
      acc.tx += net.out! * 3600;
    }
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const peak = (a: number[]) => (a.length ? Math.max(...a) : null);
    out.push({
      month: start,
      cpuAvg: avg(acc.cpu),
      cpuPeak: peak(acc.cpu),
      ramAvg: avg(acc.ram),
      ramPeak: peak(acc.ram),
      loadAvg: avg(acc.load),
      loadPeak: peak(acc.load),
      netInGB: acc.rx * KBIT_S_TO_GB,
      netOutGB: acc.tx * KBIT_S_TO_GB,
      diskPeak: peak(acc.disk),
    });
  }
  return out;
}
