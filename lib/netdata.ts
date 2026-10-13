import "server-only";
import { z } from "zod";
import { mergeMax } from "@/lib/algo";
import { DEFS, derive, isTempContext, METRICS, type Dims, type Metric } from "@/lib/charts";
import { LIMITS, type ServerLink } from "@/lib/config";
import { isPrivateAddress } from "@/lib/crypto";
import { guardedGet } from "@/lib/guarded-get";
import { invalidateLink } from "@/lib/settings";
import { countRequest } from "@/lib/usage";

// The ONLY module that talks to the server. Read-only GETs, server-side only.

export class NetdataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly notJson = false,
  ) {
    super(message);
  }
}

const HINTS: Record<number, string> = {
  401: "wrong user or password in the server link",
  403: "the server refused the request",
  404: "path not found — the link should end at the host or /history",
  502: "Caddy is up but Netdata is not answering (systemctl status netdata)",
  503: "the tunnel is up but nothing is listening behind it",
};

const MAX_BODY = 8 * 1024 * 1024; // Netdata JSON for 30 days of one chart is well under this

async function get<T>(link: ServerLink, path: string, schema: z.ZodType<T>): Promise<T> {
  countRequest(link);
  const headers = {
    authorization: "Basic " + Buffer.from(`${link.user}:${link.pass}`).toString("base64"),
    "ngrok-skip-browser-warning": "1",
    accept: "application/json",
  };
  // ALLOW_PRIVATE_LINKS=1: self-hosted dashboards on the same LAN as the server
  const guarded = !link.trusted && !process.env.ALLOW_PRIVATE_LINKS;
  let status: number;
  let text: string;
  let header: (name: string) => string;
  try {
    // SSRF-safe path for account links: see lib/guarded-get.ts
    if (guarded) {
      const r = await guardedGet(link.base + path, headers, {
        timeoutMs: LIMITS.requestTimeoutMs,
        maxBytes: MAX_BODY,
        isPrivate: isPrivateAddress,
      });
      status = r.status;
      text = r.text;
      header = (n) => {
        const v = r.headers[n];
        return Array.isArray(v) ? v.join(", ") : (v ?? "");
      };
    } else {
      const res = await fetch(link.base + path, { headers, signal: AbortSignal.timeout(LIMITS.requestTimeoutMs), cache: "no-store" });
      status = res.status;
      text = await res.text();
      header = (n) => res.headers.get(n) ?? "";
    }
  } catch (e) {
    const err = e as Error & { code?: string; cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError") throw new NetdataError(`Timed out after ${LIMITS.requestTimeoutMs / 1000} s — server or tunnel is down`);
    if (err.code === "EPRIVATE") throw new NetdataError(`${link.host} points to a private network address; use your public tunnel link`);
    if (err.code === "ETOOBIG") throw new NetdataError(`${link.host} sent an unexpectedly large response`);
    throw new NetdataError(`Cannot reach ${link.host}: ${err.code ?? err.cause?.code ?? err.cause?.message ?? err.message}`);
  }
  if (guarded && status >= 300 && status < 400) throw new NetdataError(`${link.host} tried to redirect; use the final link directly`);
  if (status < 200 || status >= 300) {
    if (status === 401) invalidateLink(link.sid); // the password changed: re-read the link next time
    // say what's actually answering, in plain words (the most common setup mistakes)
    const ngrokErr = header("ngrok-error-code");
    if (ngrokErr) throw new NetdataError(`${link.host}: the ngrok tunnel isn't serving the agent (${ngrokErr}). On the server, start ngrok pointing at 127.0.0.1:19998.`, status);
    if (status === 401 && !/server-pulse|netdata/i.test(header("www-authenticate")) && /realm/i.test(header("www-authenticate")))
      throw new NetdataError(`${link.host} asks for a different login than the Server Pulse agent (for example ngrok --basic-auth or a btop page). Point the tunnel at 127.0.0.1:19998 without a password of its own.`, status);
    throw new NetdataError(`HTTP ${status} from ${link.host}${HINTS[status] ? ` — ${HINTS[status]}` : ""}`, status);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (/^\s*</.test(text))
      throw new NetdataError(`${link.host} answered with a web page (for example the btop terminal), not the Server Pulse agent. Point the tunnel at 127.0.0.1:19998.`, status, true);
    throw new NetdataError(`${link.host} did not return JSON — is the link pointing at the agent or Netdata (…/history)?`, status, true);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new NetdataError(`Unexpected response from Netdata at ${path.split("?")[0]}`);
  return parsed.data;
}

// ---------- /api/v1/info ----------

const InfoSchema = z.looseObject({
  version: z.string().optional(),
  os_name: z.string().optional(),
  os_version: z.string().optional(),
  kernel_version: z.string().optional(),
  cores_total: z.coerce.number().optional(),
  ram_total: z.coerce.number().optional(),
  mirrored_hosts: z.array(z.string()).optional(),
});

export type ServerInfo = { hostname: string; os: string; kernel: string; cores: number | null; ramGiB: number | null; netdata: string };

export async function info(link: ServerLink): Promise<ServerInfo> {
  const i = await get(link, "/api/v1/info", InfoSchema);
  return {
    hostname: i.mirrored_hosts?.[0] ?? link.host,
    os: [i.os_name, i.os_version].filter(Boolean).join(" "),
    kernel: i.kernel_version ?? "",
    cores: i.cores_total ?? null,
    ramGiB: i.ram_total ? Math.round((i.ram_total / 1024 ** 3) * 10) / 10 : null,
    netdata: i.version ?? "",
  };
}

// ---------- /api/v1/allmetrics ----------

const AllMetricsSchema = z.record(
  z.string(),
  z.looseObject({
    context: z.string().optional(),
    last_updated: z.number().optional(),
    dimensions: z.record(z.string(), z.looseObject({ name: z.string().optional(), value: z.number().nullable() })),
  }),
);

const LIVE_FILTER = encodeURIComponent("system.cpu system.ram system.load system.io system.net system.uptime disk_space.* sensors.* *temp*");

export type Snapshot = { t: number; uptimeSec: number | null; values: Partial<Record<Metric, Dims>> };

const dimsOf = (dims: Record<string, { name?: string; value: number | null }>): Dims => {
  const out: Dims = {};
  for (const [id, d] of Object.entries(dims)) if (d.value !== null) out[d.name ?? id] = d.value;
  return out;
};

/** Every live value in one request. */
export async function snapshot(link: ServerLink): Promise<Snapshot> {
  // only the charts we show: on a busy server the full allmetrics payload is hundreds of KB per poll,
  // and every byte crosses the tunnel (unknown params are ignored by older Netdata, so this is safe)
  const all = await get(link, `/api/v1/allmetrics?format=json&filter=${LIVE_FILTER}`, AllMetricsSchema);
  const values: Snapshot["values"] = {};
  let t = 0;
  for (const m of METRICS) {
    const id = DEFS[m].ids.find((x) => all[x]);
    if (!id) continue;
    const c = all[id]!;
    values[m] = derive(m, dimsOf(c.dimensions));
    t = Math.max(t, c.last_updated ?? 0);
  }
  const temps: Dims = {};
  for (const [id, c] of Object.entries(all))
    if (isTempContext(c.context)) for (const [k, v] of Object.entries(dimsOf(c.dimensions))) temps[`${id}.${k}`] = v;
  if (Object.keys(temps).length) values.temp = derive("temp", temps);
  const up = all["system.uptime"]?.dimensions.uptime?.value ?? null;
  return { t: t || Math.floor(Date.now() / 1000), uptimeSec: up, values };
}

// ---------- /api/v1/data ----------

const DataSchema = z.object({
  labels: z.array(z.string()),
  data: z.array(z.array(z.number().nullable())),
});

export type RawPoint = { t: number; d: Dims };

async function chartData(link: ServerLink, chart: string, after: number, before: number, points: number): Promise<RawPoint[]> {
  const q = new URLSearchParams({
    chart,
    after: String(Math.floor(after)),
    before: String(Math.floor(before)),
    points: String(points),
    group: "average",
    format: "json",
    options: "seconds",
  });
  const r = await get(link, `/api/v1/data?${q}`, DataSchema);
  const names = r.labels.slice(1);
  const out: RawPoint[] = [];
  for (const row of r.data) {
    const t = row[0];
    if (t == null) continue;
    const d: Dims = {};
    names.forEach((n, i) => {
      const v = row[i + 1];
      if (v != null) d[n] = v;
    });
    if (Object.keys(d).length) out.push({ t, d });
  }
  return out.sort((a, b) => a.t - b.t); // Netdata returns newest first
}

const ChartsSchema = z.object({ charts: z.record(z.string(), z.looseObject({ context: z.string().optional() })) });

const tempIdsCache = new Map<string, { ids: string[]; at: number }>(); // keyed by Netdata base URL
/** Temperature chart ids, discovered via /api/v1/charts and cached for an hour per server. */
async function tempCharts(link: ServerLink): Promise<string[]> {
  const hit = tempIdsCache.get(link.base);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.ids;
  const r = await get(link, "/api/v1/charts", ChartsSchema);
  const ids = Object.entries(r.charts)
    .filter(([, c]) => isTempContext(c.context))
    .map(([id]) => id);
  tempIdsCache.set(link.base, { ids, at: Date.now() });
  return ids;
}

/** Raw (underived) series for one metric, ascending by time. Empty if the server doesn't have that chart. */
export async function series(link: ServerLink, metric: Metric, after: number, before: number, points: number): Promise<RawPoint[]> {
  if (metric === "temp") {
    const ids = await tempCharts(link);
    if (!ids.length) return [];
    const all = await Promise.all(ids.map((id) => chartData(link, id, after, before, points).catch(() => [])));
    // hottest sensor per timestamp across every temperature chart
    const merged = mergeMax(all.map((s) => s.map((p) => [p.t, Math.max(...Object.values(p.d))] as [number, number])));
    return merged.map(([t, v]) => ({ t, d: { max: v } }));
  }
  for (const id of DEFS[metric].ids) {
    try {
      return await chartData(link, id, after, before, points);
    } catch (e) {
      if (!(e instanceof NetdataError && e.status === 404)) throw e; // 404 = chart missing → try the fallback id
    }
  }
  return [];
}

// ---------- /api/v1/pulse (agent v2: btop-style frame) ----------

const PulseSchema = z.looseObject({ seq: z.number(), cpu: z.looseObject({ cores: z.array(z.number()) }) });

/** One full live frame from the agent (per-core CPU, temps, disks, network, processes). */
export async function pulseSnapshot(link: ServerLink): Promise<import("@/lib/pulse").PulseFrame> {
  return (await get(link, "/api/v1/pulse", PulseSchema)) as unknown as import("@/lib/pulse").PulseFrame;
}

// ---------- logs and failures (agent v2) ----------

export type LogLine = { c: string; t: number; p: number; u: string; m: string };
const LogsSchema = z.looseObject({
  entries: z.array(z.looseObject({ c: z.string(), t: z.number(), p: z.number(), u: z.string(), m: z.string() })),
  cursor: z.string().optional(),
  error: z.string().optional(),
  more: z.boolean().optional(),
  range: z.boolean().optional(),
});

// Agents before v1.2.0 answer unknown paths with a 200 text page instead of a 404: both mean "not supported".
async function getNewEndpoint<T>(link: ServerLink, path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    return await get(link, path, schema);
  } catch (e) {
    if (e instanceof NetdataError && e.notJson) throw new NetdataError("This agent is older than the logs feature.", 404);
    throw e;
  }
}

/**
 * Journal lines, already scrubbed of secrets by the agent: the most recent ones, those after a cursor,
 * or (with `since`) a time window oldest first, paged with the cursor.
 */
export async function agentLogs(link: ServerLink, q: { after?: string; prio?: number; unit?: string; n?: number; since?: number; until?: number }) {
  const p = new URLSearchParams({ n: String(q.n ?? 200), prio: String(q.prio ?? 6) });
  if (q.after) p.set("after", q.after);
  if (q.unit) p.set("unit", q.unit);
  if (q.since) p.set("since", String(q.since));
  if (q.until) p.set("until", String(q.until));
  const r = await getNewEndpoint(link, `/api/v1/logs?${p}`, LogsSchema);
  return { entries: r.entries as LogLine[], cursor: r.cursor ?? q.after ?? "", error: r.error, more: r.more ?? false, range: r.range ?? false };
}

export type AgentEvent = { id: number; t: number; last: number; n: number; sev: string; kind: string; src: string; msg: string; more?: string[] };
const EventsSchema = z.looseObject({
  epoch: z.string(),
  events: z.array(
    z.looseObject({ id: z.number(), t: z.number(), last: z.number(), n: z.number(), sev: z.string(), kind: z.string(), src: z.string(), msg: z.string(), more: z.array(z.string()).optional() }),
  ),
});

/** Failures recorded by the agent; null for older agents without failure tracking. */
export async function agentEvents(link: ServerLink, after: number, updated: number): Promise<{ epoch: string; events: AgentEvent[] } | null> {
  try {
    const r = await getNewEndpoint(link, `/api/v1/events?after=${after}&updated=${updated}`, EventsSchema);
    return { epoch: r.epoch, events: r.events as AgentEvent[] };
  } catch (e) {
    if (e instanceof NetdataError && e.status === 404) return null;
    throw e;
  }
}

// ---------- coverage (agent 1.3) ----------

export type AgentRun = { start: number; boot: string; btime: number };
const CoverageSchema = z.looseObject({
  now: z.number(),
  oldest: z.number(),
  segments: z.array(z.tuple([z.number(), z.number()])),
  runs: z.array(z.looseObject({ start: z.number(), boot: z.string(), btime: z.number() })),
});

/** What the agent holds and when it ran; null for older agents and Netdata. */
export async function agentCoverage(link: ServerLink): Promise<{ now: number; oldest: number; segments: [number, number][]; runs: AgentRun[] } | null> {
  try {
    const r = await getNewEndpoint(link, "/api/v1/coverage", CoverageSchema);
    return { now: r.now, oldest: r.oldest, segments: r.segments, runs: r.runs as AgentRun[] };
  } catch (e) {
    if (e instanceof NetdataError && e.status === 404) return null;
    throw e;
  }
}
