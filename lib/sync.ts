import "server-only";
import { and, desc, eq, gte, isNotNull, like, lt, lte, sql } from "drizzle-orm";
import { chunk } from "@/lib/algo";
import { DEFS, METRICS, type Metric } from "@/lib/charts";
import { LIMITS, type ServerLink } from "@/lib/config";
import { affected, db, peakRank, schema } from "@/lib/db";
import { ENV_SERVER } from "@/lib/db/schema";
import { pruneEvents, pullAgentEvents, recordEvent } from "@/lib/events";
import { mailConfigured, sendMail } from "@/lib/mail";
import { agentCoverage, info, series, type RawPoint } from "@/lib/netdata";
import { advanceSetting, deleteSetting, getLink, getSetting, k, setSetting } from "@/lib/settings";
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
      // a re-fetched minute overwrites its old row: two catch-ups at once both end with the right data
      .onConflictDoUpdate({ target: [schema.samples.serverId, schema.samples.chart, schema.samples.ts, schema.samples.resolutionS], set: { values: sql`excluded.values` } })
      .returning({ id: schema.samples.id });
    n += rows.length;
  }
  return n;
}

// ---------- HIS-1: catch-up sync ----------
//
// Each metric has a watermark: everything before it has been copied from the server. A sync copies
// [watermark, now] oldest first in 1-day chunks and moves the watermark after each stored chunk, so
// an outage of any length (up to the server's own 30 days) is filled in on the next run, a run that
// times out resumes where it stopped, and a time the server returns nothing for (it was off) is not
// asked for again.

const syncedKey = (sid: string, m: Metric) => k(sid, `synced_to:${m}`);
const CHUNK_SEC = 86_400;
/** Never refill time the nightly rollup has already turned into hourly rows. */
const REFILL_LIMIT_SEC = (LIMITS.rollupAfterDays - 1) * 86_400;

/**
 * Minutes [a, b] on the agent's own grid: bucket width exactly 60 s, stamps on whole minutes. The
 * same minute always gets the same timestamp, so fetching it twice can't store it twice.
 */
function fetchMinutes(link: ServerLink, m: Metric, a: number, b: number) {
  const after = Math.floor(a / 60) * 60 + 1;
  const n = Math.max(1, Math.ceil((b - after + 1) / 60));
  return series(link, m, after, after + 60 * n - 1, n);
}

/**
 * Store a chunk: the server is the source of truth for the span it answered. Write first (upsert on the
 * minute grid), then remove only rows that aren't on that grid (old 5-minute import rows, the duplicate
 * 61-second rows of the old sync). A run killed between the two steps leaves extra rows, never a hole,
 * and two runs at once can't delete each other's data.
 */
async function replaceSpan(sid: string, m: Metric, pts: RawPoint[]) {
  if (!pts.length) return 0;
  const n = await insert(sid, m, pts, 60);
  await db!
    .delete(schema.samples)
    .where(
      and(
        eq(schema.samples.serverId, sid),
        eq(schema.samples.chart, m),
        lt(schema.samples.resolutionS, 3600),
        gte(schema.samples.ts, new Date(pts[0]!.t * 1000)),
        lte(schema.samples.ts, new Date(pts[pts.length - 1]!.t * 1000)),
        sql`(${schema.samples.resolutionS} <> 60 or extract(epoch from ${schema.samples.ts})::bigint % 60 <> 0)`,
      ),
    );
  return n;
}

export type CatchUp = { rows: number; errors: string[]; pending: boolean; syncedTo: number | null };

/**
 * Copy everything the dashboard doesn't have yet, until `deadline` (ms). Concurrent runs (cron, several
 * tabs) are safe: writes are upserts, cleanup never deletes grid rows, and the watermark only moves forward.
 */
export async function catchUp(link: ServerLink, deadline: number): Promise<CatchUp> {
  const sid = link.sid;
  // what the agent holds and when it ran: labels gaps and tells where its history starts
  const cov = await agentCoverage(link).catch(() => null);
  if (cov) {
    if (cov.oldest) await setSetting(k(sid, "agent_oldest"), String(cov.oldest));
    await setSetting(k(sid, "agent_runs"), JSON.stringify(cov.runs.slice(-100).map((r) => ({ start: r.start, btime: r.btime }))));
  }
  const now = (cov?.now ?? nowSec()) - 120; // the current minute is still being averaged
  const floor = now - REFILL_LIMIT_SEC;
  let rows = 0;
  const errors: string[] = [];
  const marks: number[] = [];
  await Promise.all(
    METRICS.map(async (m) => {
      let mark = 0;
      try {
        mark = Number(await getSetting(syncedKey(sid, m))) || 0;
        // first time: start where the agent's history starts (Netdata: 30 days back)
        let from = mark ? mark - 300 : (cov?.oldest ?? floor);
        from = Math.max(from, floor);
        while (from < now && Date.now() < deadline) {
          const to = Math.min(now, from + CHUNK_SEC);
          const stored = await replaceSpan(sid, m, await fetchMinutes(link, m, from, to));
          rows += stored; // not `rows += await …`: that reads `rows` before the await and loses the other charts' counts
          mark = to;
          await advanceSetting(syncedKey(sid, m), mark);
          from = to;
        }
      } catch (e) {
        errors.push(`${DEFS[m].label}: ${(e as Error).message}`);
      }
      marks.push(mark);
    }),
  );
  const syncedTo = marks.length ? Math.min(...marks) : null;
  return { rows, errors, pending: syncedTo === null || syncedTo < now - 600, syncedTo };
}

/**
 * HIS-5: atomically replace 1-min / 5-min rows older than 30 days with hourly rows: the average of
 * each value, plus the hour's peak minute (whole reading) so long ranges and reports keep true peaks.
 * Whole hours only, all servers. Hourly rows older than 2 years are dropped (queries stop at 2 years).
 */
export async function rollup(): Promise<number> {
  if (!db) return 0;
  const r = await db.execute(sql`
    WITH old AS (
      DELETE FROM samples
      WHERE resolution_s < 3600
        AND ts < date_trunc('hour', now() - make_interval(days => ${LIMITS.rollupAfterDays}))
      RETURNING server_id, chart, ts, "values"
    ), kv AS (
      SELECT server_id, chart, date_trunc('hour', ts) AS h, kv.key, round(avg(kv.value::float8)::numeric, 3)::float8 AS v
      FROM old, jsonb_each_text(old."values") kv
      GROUP BY 1, 2, 3, 4
    ), avgs AS (
      SELECT server_id, chart, h, jsonb_object_agg(key, v) AS vals FROM kv GROUP BY 1, 2, 3
    ), pk AS (
      SELECT DISTINCT ON (server_id, chart, date_trunc('hour', ts)) server_id, chart, date_trunc('hour', ts) AS h, "values" AS peak
      FROM old
      ORDER BY server_id, chart, date_trunc('hour', ts), ${peakRank(sql`chart`, sql`"values"`)} DESC NULLS LAST
    )
    INSERT INTO samples (server_id, chart, ts, "values", peaks, resolution_s)
    SELECT a.server_id, a.chart, a.h, a.vals, p.peak, 3600 FROM avgs a JOIN pk p USING (server_id, chart, h)
    ON CONFLICT (server_id, chart, ts, resolution_s) DO NOTHING
  `);
  await db.execute(sql`DELETE FROM samples WHERE resolution_s >= 3600 AND ts < now() - interval '2 years'`);
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
    await setSetting(k(sid, "last_contact"), String(nowSec()));
    const was = Number(await getSetting(k(sid, "offline_since"))) || 0;
    if (was) {
      const mins = Math.max(1, Math.round((nowSec() - was) / 60));
      await recordEvent(sid, "info", "online", `Server is reachable again (was offline for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}).`);
      await deleteSetting(k(sid, "offline_since"));
      await deleteSetting(k(sid, "offline_mailed"));
    }
    return;
  }
  const since = Number(await getSetting(k(sid, "offline_since"))) || 0;
  if (!since) {
    const lastContact = Number(await getSetting(k(sid, "last_contact"))) || nowSec();
    await recordEvent(sid, "critical", "offline", `Server unreachable: ${error ?? "no answer"}`);
    return setSetting(k(sid, "offline_since"), String(lastContact));
  }
  const due = nowSec() - since >= LIMITS.offlineEmailAfterSec - LIMITS.cronSlackSec;
  // Only the owner-configured address (ALERT_EMAIL_TO) for the env server. Account emails are not
  // verified, so mailing them would let anyone make this app send mail to an address they typed.
  // v2: email verification, then per-account alerts.
  if (sid === ENV_SERVER && due && !(await getSetting(k(sid, "offline_mailed"))) && mailConfigured()) {
    const sent = await sendMail(
      "[Server Pulse] server unreachable for over a day",
      `Server Pulse has not reached your server since ${new Date(since * 1000).toUTCString()}.\n\nLast error: ${error}\n\n` +
        `Your server keeps 30 days of readings, so once it answers again the next sync fills the gap.`,
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
export async function syncServer(link: ServerLink | null, deadline?: number): Promise<SyncResult> {
  if (!db) return { status: "skipped", rows: 0, error: "No database connected" };
  if (!link) return { status: "skipped", rows: 0, error: "No server link configured" };
  const id = await startRun(link.sid, "sync");
  let result: SyncResult;
  try {
    await info(link);
  } catch (e) {
    // only a failed request to the server means "offline"; a database hiccup below is not
    const msg = (e as Error).message;
    await trackOffline(link.sid, false, msg).catch(() => {});
    result = { status: "offline", rows: 0, error: msg };
    await finishRun(id, 0, result.status, msg).catch(() => {});
    await flushUsage(link.sid).catch(() => {});
    return result;
  }
  try {
    await trackOffline(link.sid, true);
    const { rows, errors } = await catchUp(link, deadline ?? Date.now() + LIMITS.syncBudgetMs);
    const status = errors.length === 0 ? "ok" : errors.length === METRICS.length ? "error" : "partial";
    result = { status, rows, error: errors.join("; ") || undefined };
    if (status !== "ok") await recordEvent(link.sid, status === "error" ? "error" : "warning", "sync", `History sync ${status}: ${result.error}`);
    await pullAgentEvents(link).catch(() => 0); // keep the failure history even when nobody opens the page
  } catch (e) {
    result = { status: "error", rows: 0, error: (e as Error).message };
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
  // housekeeping first: if syncing servers runs long and the function is stopped, the database still
  // gets rolled up and pruned tonight (otherwise it grows until the free tier is full)
  const rolledUp = await rollup().catch(() => 0);
  await pruneEvents().catch(() => {});
  const results: Record<string, SyncResult> = {};
  let next = 0;
  const end = started + LIMITS.cronBudgetMs; // every server's catch-up stops by then
  const worker = async () => {
    // a server started late still has time to finish within the function limit
    while (next < sids.length && Date.now() < end - 20_000) {
      const sid = sids[next++]!;
      const { link } = await getLink(sid);
      if (link) results[sid] = await syncServer(link, Math.min(Date.now() + LIMITS.syncBudgetMs, end));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { servers: Object.keys(results).length, skipped: Math.max(0, sids.length - next), rolledUp, results };
}

// ---------- HIS-2: catch up while the owner is looking ----------

/** True when the dashboard is more than an hour behind the server (or has never synced). */
export async function catchUpPending(sid: string): Promise<boolean> {
  if (!db) return false;
  const marks = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(like(schema.settings.key, k(sid, "synced_to:%")));
  if (marks.length < METRICS.length) return true;
  return Math.min(...marks.map((m) => Number(m.value) || 0)) < nowSec() - 3600;
}

/** One budgeted step of catch-up for the owner's page; call again while `pending`. */
export async function catchUpStep(link: ServerLink): Promise<CatchUp> {
  if (!db) throw new Error("No database connected");
  const id = await startRun(link.sid, "backfill");
  try {
    const r = await catchUp(link, Date.now() + LIMITS.catchUpStepMs);
    await finishRun(id, r.rows, r.errors.length ? "partial" : "ok", r.errors.join("; ") || undefined);
    await flushUsage(link.sid);
    return r;
  } catch (e) {
    await finishRun(id, 0, "error", (e as Error).message);
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
