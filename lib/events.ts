import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { ServerLink } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { agentEvents, type AgentEvent } from "@/lib/netdata";
import { getSetting, k, setSetting } from "@/lib/settings";

// Failure history. The agent detects failures on the server (error-level logs, crashes, OOM kills,
// failed services, disk errors, sustained CPU/memory/disk/temperature breaches) and keeps its own copy;
// the dashboard copies them into Postgres and adds what it sees itself (offline, back online, sync).

export type Severity = "critical" | "error" | "warning" | "info";
export type FailureEvent = {
  id: number;
  ts: number; // unix seconds, first seen
  last: number;
  count: number;
  severity: Severity;
  kind: string;
  source: string;
  message: string;
};

const RETENTION_DAYS = 180;
const MAX_PER_SERVER = 20_000; // keeps a free-tier database safe from a server that fails all day

/** Something the dashboard noticed itself (no agent involved). */
export async function recordEvent(serverId: string, severity: Severity, kind: string, message: string, source = "dashboard") {
  if (!db) return;
  const now = new Date();
  await db
    .insert(schema.events)
    .values({ serverId, key: `dash:${randomUUID()}`, ts: now, lastAt: now, severity, kind, source, message: message.slice(0, 2000) })
    .catch(() => {});
}

/**
 * Copy new failures from the agent. Idempotent: rows are keyed "<agent epoch>:<id>"; repeats only bump
 * the count. A new epoch (agent state wiped/reinstalled) restarts the cursor.
 */
export async function pullAgentEvents(link: ServerLink): Promise<number> {
  if (!db) return 0;
  const sid = link.sid;
  const [epoch, after, pulledAt] = await Promise.all([
    getSetting(k(sid, "events_epoch")),
    getSetting(k(sid, "events_after")),
    getSetting(k(sid, "events_pulled_at")),
  ]);
  const started = Math.floor(Date.now() / 1000);
  const res = await agentEvents(link, Number(after) || 0, Number(pulledAt) || 0);
  if (!res) return 0; // older agent without failure tracking
  let cursor = Number(after) || 0;
  if (res.epoch !== epoch) cursor = 0;
  let page = res.epoch !== epoch ? (await agentEvents(link, 0, 0))?.events ?? [] : res.events;
  let total = 0;
  // drain the whole backlog (an outage can leave thousands): pages until one comes back short.
  // ponytail: agents answer up to 500 per page (1.3: 2000, its whole ring); 10 pages is plenty.
  for (let i = 0; i < 10; i++) {
    await saveAgentEvents(sid, res.epoch, page);
    total += page.length;
    const before = cursor;
    for (const e of page) cursor = Math.max(cursor, e.id);
    await setSetting(k(sid, "events_epoch"), res.epoch);
    await setSetting(k(sid, "events_after"), String(cursor));
    if (page.length < 500 || cursor === before) break;
    page = (await agentEvents(link, cursor, 0))?.events ?? [];
  }
  // only now: repeats are re-read from this time on, so a truncated pull can't skip any
  await setSetting(k(sid, "events_pulled_at"), String(started - 60)); // overlap a minute for repeats
  return total;
}

async function saveAgentEvents(serverId: string, epoch: string, list: AgentEvent[]) {
  if (!db || !list.length) return;
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200).map((e) => ({
      serverId,
      key: `${epoch}:${e.id}`,
      ts: new Date(e.t * 1000),
      lastAt: new Date((e.last || e.t) * 1000),
      count: Math.max(1, e.n || 1),
      severity: (["critical", "error", "warning"].includes(e.sev) ? e.sev : "error") as Severity,
      kind: e.kind.slice(0, 40),
      source: (e.src || "").slice(0, 200),
      message: fullMessage(e),
    }));
    await db
      .insert(schema.events)
      .values(part)
      .onConflictDoUpdate({
        target: [schema.events.serverId, schema.events.key],
        // an incident gains lines and may change its headline while it happens
        set: { count: sql`excluded.count`, lastAt: sql`excluded.last_at`, message: sql`excluded.message`, severity: sql`excluded.severity`, kind: sql`excluded.kind` },
      });
  }
}

// at most one pull per server every 30 s per instance, however often the page asks
const lastPull = new Map<string, number>();
export async function pullThrottled(link: ServerLink) {
  const t = lastPull.get(link.sid) ?? 0;
  if (Date.now() - t < 30_000) return;
  lastPull.set(link.sid, Date.now());
  await pullAgentEvents(link);
}

export async function listEvents(
  serverId: string,
  opts: { before?: number; severities?: Severity[]; limit?: number; since?: number; until?: number },
): Promise<FailureEvent[]> {
  if (!db) return [];
  const conds = [...windowConds(serverId, opts)];
  if (opts.before) conds.push(lt(schema.events.id, opts.before));
  if (opts.severities?.length) conds.push(inArray(schema.events.severity, opts.severities));
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(...conds))
    .orderBy(desc(schema.events.id))
    .limit(Math.min(opts.limit ?? 50, 200));
  return rows.map((r) => ({
    id: r.id,
    ts: Math.floor(r.ts.getTime() / 1000),
    last: Math.floor(r.lastAt.getTime() / 1000),
    count: r.count,
    severity: r.severity as Severity,
    kind: r.kind,
    source: r.source,
    message: r.message,
  }));
}

/** A failure is in a window when it was active in it: first seen before the end, last seen after the start. */
function windowConds(serverId: string, w: { since?: number; until?: number }) {
  const conds = [eq(schema.events.serverId, serverId)];
  if (w.since) conds.push(gte(schema.events.lastAt, new Date(w.since * 1000)));
  if (w.until) conds.push(lte(schema.events.ts, new Date(w.until * 1000)));
  return conds;
}

/** How many failures of each severity were active in a window. */
export async function countEvents(serverId: string, w: { since?: number; until?: number }): Promise<Partial<Record<Severity, number>>> {
  if (!db) return {};
  const rows = await db
    .select({ severity: schema.events.severity, n: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(and(...windowConds(serverId, w)))
    .groupBy(schema.events.severity);
  return Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));
}

/** Without a database: show the agent's own copy (newest first). */
export function fromAgent(list: AgentEvent[]): FailureEvent[] {
  return list
    .map((e) => ({ id: e.id, ts: e.t, last: e.last || e.t, count: e.n || 1, severity: e.sev as Severity, kind: e.kind, source: e.src, message: fullMessage(e) }))
    .sort((a, b) => b.id - a.id);
}

/** The headline, then the incident's other lines (shown when the failure is opened). */
const fullMessage = (e: AgentEvent) => [e.msg, ...(e.more ?? [])].join("\n").slice(0, 2000);

export async function pruneEvents() {
  if (!db) return;
  await db.delete(schema.events).where(lt(schema.events.lastAt, new Date(Date.now() - RETENTION_DAYS * 86_400_000)));
  await db.execute(sql`
    delete from events e
    where e.id <= (select x.id from events x where x.server_id = e.server_id order by x.id desc offset ${MAX_PER_SERVER} limit 1)`);
}
