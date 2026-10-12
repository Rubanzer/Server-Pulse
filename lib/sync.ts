import "server-only";
import { and, desc, eq, gte, isNotNull, min, sql } from "drizzle-orm";
import { chunk } from "@/lib/algo";
import { METRICS, type Metric } from "@/lib/charts";
import { LIMITS, type ServerLink } from "@/lib/config";
import { affected, db, schema } from "@/lib/db";
import { ENV_SERVER } from "@/lib/db/schema";
import { mailConfigured, sendMail } from "@/lib/mail";
import { info, series, type RawPoint } from "@/lib/netdata";
import { deleteSetting, getLink, getSetting, k, setSetting } from "@/lib/settings";
import { flushUsage } from "@/lib/usage";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Batched idempotent insert; returns the number of new rows. */
async function insert(sid: string, metric: Metric, points: RawPoint[], resolutionS: number): Promise<number> {
  if (!db || !points.length) return 0;
  let n = 0;
  // 5 bind params per row → 1000 rows stays far below Postgres' 65 535-parameter cap
  for (const part of chunk(points, 1000)) {
    const rows = await db
      .insert(schema.samples)
      .values(part.map((p) => ({ serverId: sid, chart: metric, ts: new Date(p.t * 1000), values: p.d, resolutionS })))
      .onConflictDoNothing()
      .returning({ id: schema.samples.id });
    n += rows.length;
  }
  return n;
}

/**
 * HIS-1: last 26 h at 1-minute resolution for every metric, in parallel. 5-minute backfill rows inside
 * the window are replaced, so the same minutes are never stored twice (no double-counted traffic).
 */
async function syncRecent(link: ServerLink) {
  const after = nowSec() - LIMITS.syncHours * 3600;
  const points = LIMITS.syncHours * 60;
  const results = await Promise.allSettled(
    METRICS.map(async (m) => {
      const pts = await series(link, m, after, nowSec(), points);
      if (pts.length)
        await db!
          .delete(schema.samples)
          .where(
            and(
              eq(schema.samples.serverId, link.sid),
              eq(schema.samples.chart, m),
              eq(schema.samples.resolutionS, LIMITS.backfillStepSec),
              gte(schema.samples.ts, new Date(pts[0]!.t * 1000)),
            ),
          );
      return insert(link.sid, m, pts, 60);
    }),
  );
  let rows = 0;
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") rows += r.value;
    else errors.push(`${METRICS[i]}: ${(r.reason as Error).message}`);
  });
  return { rows, errors };
}

/** HIS-5: atomically replace 1-min / 5-min rows older than 30 days with hourly averages. Whole hours only, all servers. */
export async function rollup(): Promise<number> {
  if (!db) return 0;
  const r = await db.execute(sql`
    WITH old AS (
      DELETE FROM samples
      WHERE resolution_s < 3600
        AND ts < date_trunc('hour', now() - make_interval(days => ${LIMITS.rollupAfterDays}))
      RETURNING server_id, chart, ts, "values"
    ), kv AS (
      SELECT server_id, chart, date_trunc('hour', ts) AS h, kv.key, avg(kv.value::float8) AS v
      FROM old, jsonb_each_text(old."values") kv
      GROUP BY 1, 2, 3, 4
    )
    INSERT INTO samples (server_id, chart, ts, "values", resolution_s)
    SELECT server_id, chart, h, jsonb_object_agg(key, v), 3600 FROM kv GROUP BY server_id, chart, h
    ON CONFLICT (server_id, chart, ts, resolution_s) DO NOTHING
  `);
  return affected(r);
}

async function startRun(sid: string, kind: "sync" | "backfill") {
  if (!db) return null;
  const [r] = await db.insert(schema.syncRuns).values({ serverId: sid, kind, startedAt: new Date() }).returning({ id: schema.syncRuns.id });
  return r?.id ?? null;
}

async function finishRun(id: number | null, rows: number, status: string, error?: string) {
  if (!db || id === null) return;
  await db
    .update(schema.syncRuns)
    .set({ finishedAt: new Date(), rowsInserted: rows, status, error: error?.slice(0, 2000) ?? null })
    .where(eq(schema.syncRuns.id, id));
}

/** HIS-10: one email per outage after about a day offline; cleared when the server answers again. */
async function trackOffline(sid: string, online: boolean, error?: string) {
  if (online) {
    if (await getSetting(k(sid, "offline_since"))) {
      await deleteSetting(k(sid, "offline_since"));
      await deleteSetting(k(sid, "offline_mailed"));
    }
    return;
  }
  const since = Number(await getSetting(k(sid, "offline_since"))) || 0;
  if (!since) return setSetting(k(sid, "offline_since"), String(nowSec()));
  const due = nowSec() - since >= LIMITS.offlineEmailAfterSec - LIMITS.cronSlackSec;
  // Only the owner-configured address (ALERT_EMAIL_TO) for the env server. Account emails are not
  // verified, so mailing them would let anyone make this app send mail to an address they typed.
  // v2: email verification, then per-account alerts.
  if (sid === ENV_SERVER && due && !(await getSetting(k(sid, "offline_mailed"))) && mailConfigured()) {
    const sent = await sendMail(
      "[Server Pulse] server unreachable for over a day",
      `Server Pulse has not reached your server since ${new Date(since * 1000).toUTCString()}.\n\nLast error: ${error}\n\n` +
        `Netdata keeps 30 days locally, so bring it back before then and the next sync fills the gap.`,
    );
    if (sent) await setSetting(k(sid, "offline_mailed"), "1");
  }
}

export type SyncResult = {
  status: "ok" | "partial" | "error" | "offline" | "skipped";
  rows: number;
  error?: string;
};

/** One server: offline check → 26 h sync → record. Idempotent, safe to re-run. */
export async function syncServer(link: ServerLink | null): Promise<SyncResult> {
  if (!db) return { status: "skipped", rows: 0, error: "No database connected" };
  if (!link) return { status: "skipped", rows: 0, error: "No server link configured" };
  const id = await startRun(link.sid, "sync");
  let result: SyncResult;
  try {
    await info(link);
    await trackOffline(link.sid, true);
    const { rows, errors } = await syncRecent(link);
    const status = errors.length === 0 ? "ok" : errors.length === METRICS.length ? "error" : "partial";
    result = { status, rows, error: errors.join("; ") || undefined };
  } catch (e) {
    const msg = (e as Error).message;
    await trackOffline(link.sid, false, msg).catch(() => {});
    result = { status: "offline", rows: 0, error: msg };
  }
  await finishRun(id, result.rows, result.status, result.error);
  if (link.sid !== ENV_SERVER) await db.update(schema.servers).set({ lastSyncAt: new Date() }).where(eq(schema.servers.id, link.sid));
  await flushUsage(link.sid);
  return result;
}

/**
 * Nightly job for every connected server, least-recently-synced first, 3 at a time, within a time budget.
 * ponytail: one function run fits ≈20-40 servers; past that, fan out one request per server.
 */
export async function syncAll() {
  const started = Date.now();
  const sids: string[] = [ENV_SERVER];
  if (db) {
    const rows = await db
      .select({ id: schema.servers.id })
      .from(schema.servers)
      .where(isNotNull(schema.servers.linkEnc))
      .orderBy(sql`${schema.servers.lastSyncAt} ASC NULLS FIRST`);
    sids.push(...rows.map((r) => r.id));
  }
  const results: Record<string, SyncResult> = {};
  let next = 0;
  const worker = async () => {
    while (next < sids.length && Date.now() - started < LIMITS.cronBudgetMs) {
      const sid = sids[next++]!;
      const { link } = await getLink(sid);
      if (link) results[sid] = await syncServer(link);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const rolledUp = await rollup();
  return { servers: Object.keys(results).length, skipped: Math.max(0, sids.length - next), rolledUp, results };
}

// ---------- HIS-2: backfill ----------

const doneKey = (sid: string, m: Metric) => k(sid, `backfill_done:${m}`);

export async function backfillPending(sid: string): Promise<Metric[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.settings)
    .where(sql`${schema.settings.key} LIKE ${k(sid, "backfill_done:%")}`);
  const done = new Set(rows.map((r) => r.key));
  return METRICS.filter((m) => !done.has(doneKey(sid, m)));
}

/**
 * 30 days at 5-minute resolution for ONE metric (one request keeps every call far below the function
 * time cap). Stops at the oldest 1-minute row, and the nightly sync replaces any 5-minute rows inside
 * its own window, so the two never overlap.
 */
export async function backfill(link: ServerLink, metric: Metric): Promise<number> {
  if (!db) throw new Error("No database connected");
  const sid = link.sid;
  const id = await startRun(sid, "backfill");
  try {
    const [first] = await db
      .select({ ts: min(schema.samples.ts) })
      .from(schema.samples)
      .where(and(eq(schema.samples.serverId, sid), eq(schema.samples.chart, metric), eq(schema.samples.resolutionS, 60)));
    const before = first?.ts ? Math.floor(new Date(first.ts).getTime() / 1000) - 1 : nowSec();
    const after = nowSec() - LIMITS.backfillDays * 86400;
    let rows = 0;
    if (before > after) {
      const points = Math.ceil((before - after) / LIMITS.backfillStepSec);
      rows = await insert(sid, metric, await series(link, metric, after, before, points), LIMITS.backfillStepSec);
    }
    await setSetting(doneKey(sid, metric), new Date().toISOString());
    await finishRun(id, rows, "ok", metric);
    await flushUsage(sid);
    return rows;
  } catch (e) {
    await finishRun(id, 0, "error", `${metric}: ${(e as Error).message}`);
    throw e;
  }
}

export async function recentRuns(sid: string, limit = 10) {
  if (!db) return [];
  return db.select().from(schema.syncRuns).where(eq(schema.syncRuns.serverId, sid)).orderBy(desc(schema.syncRuns.startedAt)).limit(limit);
}

export async function storageStats(sid: string) {
  if (!db) return null;
  const r = await db.execute(sql`
    SELECT pg_database_size(current_database())::bigint AS bytes,
           (SELECT count(*) FROM samples WHERE server_id = ${sid})::bigint AS rows,
           (SELECT extract(epoch FROM min(ts))::bigint FROM samples WHERE server_id = ${sid}) AS oldest`);
  const row = r.rows[0] as { bytes: string; rows: string; oldest: string | null } | undefined;
  return row ? { bytes: Number(row.bytes), rows: Number(row.rows), oldest: row.oldest ? Number(row.oldest) : null } : null;
}
