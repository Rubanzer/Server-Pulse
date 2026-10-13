"use client";

import Link from "next/link";
import { memo, useEffect, useState } from "react";
import { RingBuffer } from "@/lib/algo";
import { DEFS, METRICS, type Dims, type Metric, type Point } from "@/lib/charts";
import type { ServerInfo, Snapshot } from "@/lib/netdata";
import type { Usage } from "@/lib/usage";
import { AnimatedNumber } from "./animated-number";
import { fmtNum, Legend } from "./chart-utils";
import { LiveChart } from "./live-chart";
import { usePoll } from "./use-poll";

type Live =
  | { mode: "live" | "demo"; intervalMs: number; tunnel: string | null; info: ServerInfo | null; snapshot: Snapshot; btopUrl?: string }
  | { mode: "offline"; intervalMs: number; tunnel: string; error: string; lastSeen: number | null }
  | { mode: "paused"; intervalMs: number; tunnel: string; usage: Usage }
  | { mode: "error"; intervalMs: number; error: string }
  | { mode: "connect"; intervalMs: number };

const CHARTED: Metric[] = ["cpu", "ram", "io", "net"];
const KPIS: Metric[] = ["cpu", "ram", "load", "disk", "net", "temp"];
const WINDOW = 300; // live charts show the last 5 minutes
const SPARK = 60;
const CAPACITY = 400; // ≥ 5 min at 1 s

/**
 * Lives outside React so it survives page changes: coming back to Live shows the latest readings and
 * charts instantly instead of a skeleton. A full page load (login / logout) resets it.
 */
const store = {
  buffers: new Map<Metric, RingBuffer<Point>>(),
  last: null as Live | null,
  seeded: false,
};

const buf = (m: Metric) => {
  let b = store.buffers.get(m);
  if (!b) store.buffers.set(m, (b = new RingBuffer<Point>(CAPACITY)));
  return b;
};

/** Last 5 minutes per metric. New arrays per publish, so memoized charts re-render only on new data. */
function windowed(): Map<Metric, Point[]> {
  const out = new Map<Metric, Point[]>();
  for (const [m, b] of store.buffers) {
    const all = b.toArray();
    const end = all[all.length - 1]?.t ?? 0;
    out.set(m, all.filter((p) => p.t > end - WINDOW));
  }
  return out;
}

type Level = "ok" | "warn" | "crit";
function level(m: Metric, v: Dims, cores: number | null): Level {
  const x = m === "cpu" ? v.cpu : m === "ram" || m === "disk" ? v.pct : m === "load" ? v.load1 : m === "temp" ? v.max : 0;
  const [warn, crit] = m === "temp" ? [70, 85] : m === "load" ? [cores ?? 1, (cores ?? 1) * 2] : m === "net" ? [Infinity, Infinity] : [75, 90];
  return (x ?? 0) >= crit ? "crit" : (x ?? 0) >= warn ? "warn" : "ok";
}
const LEVEL_TEXT: Record<Level, string> = { ok: "", warn: "High", crit: "Critical" };
const LEVEL_CLASS: Record<Level, string> = { ok: "text-signal", warn: "text-warn", crit: "text-crit" };

const SPARK_SERIES: Record<Metric, { key: string; label: string; unit: string }[]> = {
  cpu: [{ key: "cpu", label: "CPU", unit: "%" }],
  ram: [{ key: "pct", label: "RAM", unit: "%" }],
  load: [{ key: "load1", label: "Load", unit: "" }],
  disk: [{ key: "pct", label: "Disk", unit: "%" }],
  net: [{ key: "in", label: "In", unit: "kbit/s" }],
  temp: [{ key: "max", label: "Temp", unit: "°C" }],
  io: [],
};
const CHART_SERIES: Partial<Record<Metric, { key: string; label: string; unit: string }[]>> = {
  cpu: DEFS.cpu.series,
  ram: DEFS.ram.series.slice(0, 1),
  io: DEFS.io.series,
  net: DEFS.net.series,
};

function since(t: number | null, now: number) {
  if (!t) return "never";
  const s = Math.max(0, Math.round(now / 1000 - t));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return new Date(t * 1000).toLocaleString();
}

function uptime(sec: number | null) {
  if (sec == null) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
}

/** Ticks once a second by itself, so the rest of the page doesn't re-render every second. */
function Ago({ t }: { t: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{since(t, now)}</>;
}

function Big({ n, unit, digits = 0 }: { n: number | undefined; unit: string; digits?: number }) {
  return (
    <p className="font-cond text-4xl font-semibold leading-none tracking-tight">
      <AnimatedNumber value={n} digits={digits} />
      <span className="ml-1 text-lg font-medium text-muted">{unit}</span>
    </p>
  );
}

function KpiValue({ m, v, info }: { m: Metric; v: Dims | undefined; info: ServerInfo | null }) {
  if (!v) return <p className="font-cond text-4xl font-semibold text-muted">—</p>;
  switch (m) {
    case "cpu":
      return <Big n={v.cpu} unit="%" />;
    case "ram":
      return (
        <>
          <Big n={v.pct} unit="%" />
          <p className="mt-1 text-xs text-muted">
            {fmtNum(v.usedGiB, "GiB")} of {info?.ramGiB ? `${info.ramGiB} GiB` : "total"}
          </p>
        </>
      );
    case "load":
      return (
        <>
          <Big n={v.load1} unit="" digits={2} />
          <p className="mt-1 text-xs text-muted">
            5 min {fmtNum(v.load5)} · 15 min {fmtNum(v.load15)}
            {info?.cores ? ` · ${info.cores} cores` : ""}
          </p>
        </>
      );
    case "disk":
      return (
        <>
          <Big n={v.pct} unit="%" />
          <p className="mt-1 text-xs text-muted">{fmtNum(v.usedGiB, "GiB")} used on /</p>
        </>
      );
    case "net":
      return (
        <div className="space-y-1">
          <p className="font-cond text-xl font-semibold leading-none sm:text-2xl">
            <span className="text-sm font-medium text-muted">In </span>
            <AnimatedNumber value={(v.in ?? 0) / 1000} digits={2} /> <span className="text-base text-muted">Mbit/s</span>
          </p>
          <p className="font-cond text-xl font-semibold leading-none sm:text-2xl">
            <span className="text-sm font-medium text-muted">Out </span>
            <AnimatedNumber value={(v.out ?? 0) / 1000} digits={2} /> <span className="text-base text-muted">Mbit/s</span>
          </p>
        </div>
      );
    case "temp":
      return <Big n={v.max} unit="°C" />;
    default:
      return null;
  }
}

const KpiTile = memo(function KpiTile({ m, v, pts, info }: { m: Metric; v: Dims | undefined; pts: Point[]; info: ServerInfo | null }) {
  const lv = v ? level(m, v, info?.cores ?? null) : "ok";
  const end = pts[pts.length - 1]?.t ?? 0;
  const spark = pts.filter((p) => p.t > end - SPARK - 4);
  return (
    <Link
      href={`/history?range=24h#${m}`}
      prefetch
      className="group flex flex-col justify-between gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-signal"
    >
      <span className="sr-only">Open 24-hour history.</span>
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-muted group-hover:text-ink">{m === "disk" ? "Disk" : DEFS[m].label}</h2>
        {LEVEL_TEXT[lv] && <span className={`text-xs font-semibold ${LEVEL_CLASS[lv]}`}>{LEVEL_TEXT[lv]}</span>}
      </header>
      <KpiValue m={m} v={v} info={info} />
      <LiveChart
        points={spark}
        series={SPARK_SERIES[m]}
        windowSec={SPARK}
        height={40}
        compact
        yMax={m === "cpu" || m === "ram" || m === "disk" ? 100 : undefined}
        className={LEVEL_CLASS[lv]}
      />
    </Link>
  );
});

export function LiveView() {
  const [view, setView] = useState(windowed);

  // each new snapshot → O(1) push per metric into its ring buffer, then one render
  const { data, error } = usePoll<Live>("/api/live", 2000, {
    initial: store.last,
    nextInterval: (d) => d.intervalMs,
    onData: (d) => {
      store.last = d;
      if (!("snapshot" in d)) return;
      const s = d.snapshot;
      for (const [m, v] of Object.entries(s.values) as [Metric, Dims][]) {
        const b = buf(m);
        if ((b.last()?.t ?? 0) < s.t) b.push({ t: s.t, v });
      }
      setView(windowed());
    },
  });
  const snap = data && "snapshot" in data ? data.snapshot : null;

  // LIV-2: seed the last 5 minutes once per page load, so charts and sparklines start full
  const canSeed = data?.mode === "live" || data?.mode === "demo";
  const tunnel = data && "tunnel" in data ? data.tunnel : null;
  useEffect(() => {
    if (!canSeed || store.seeded) return;
    store.seeded = true;
    const to = Math.floor(Date.now() / 1000);
    // ngrok budget mode: seed only the four charts to save requests
    const metrics = tunnel === "ngrok" ? CHARTED : METRICS.filter((m) => CHARTED.includes(m) || KPIS.includes(m));
    Promise.all(
      metrics.map(async (m) => {
        const r = await fetch(`/api/history?chart=${m}&from=${to - WINDOW}&to=${to}&points=150`).catch(() => null);
        if (!r?.ok) return;
        const { points } = (await r.json()) as { points: Point[] };
        const fresh = buf(m).toArray();
        const b = new RingBuffer<Point>(CAPACITY);
        const firstLive = fresh[0]?.t ?? Infinity;
        for (const p of points) if (p.t < firstLive) b.push(p);
        for (const p of fresh) b.push(p);
        store.buffers.set(m, b);
      }),
    ).then(() => setView(windowed()));
  }, [canSeed, tunnel]);

  const info = data && "info" in data ? data.info : null;
  const latestT = snap?.t ?? (data?.mode === "offline" ? data.lastSeen : null);
  if (!data && !error)
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Connecting to your server">
        <div className="h-12 w-56 animate-pulse rounded-lg bg-surface" />
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {KPIS.map((m) => (
            <div key={m} className="h-40 animate-pulse rounded-xl border border-line bg-surface" />
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
          {CHARTED.map((m) => (
            <div key={m} className="h-64 animate-pulse rounded-xl border border-line bg-surface" />
          ))}
        </div>
      </div>
    );
  if (data?.mode === "connect")
    return (
      <section className="mx-auto mt-[8vh] max-w-xl rounded-xl border border-line bg-surface p-6 text-center sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Add your server to start</h1>
        <p className="mt-2 text-muted">Copy one command to your Ubuntu server and live vitals appear here within seconds.</p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Link href="/connect" prefetch className="rounded-lg bg-signal px-4 py-2.5 font-medium text-on-signal">
            Add server
          </Link>
          <Link href="/setup" prefetch className="rounded-lg border border-line px-4 py-2.5 hover:border-signal">
            Set up a server first
          </Link>
        </div>
      </section>
    );

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{info?.hostname ?? "Your server"}</h1>
          <p className="text-sm text-muted">
            {[info?.os, snap ? uptime(snap.uptimeSec) && `up ${uptime(snap.uptimeSec)}` : null].filter(Boolean).join(" · ") ||
              "Ubuntu server"}
          </p>
        </div>
        <Status data={data} error={error} latestT={latestT} />
      </section>

      {data?.mode === "demo" && (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <strong className="font-medium">Demo data.</strong> These numbers are generated. Connect your server with the{" "}
          <Link className="text-signal underline" href="/setup" prefetch>
            server setup guide
          </Link>
          , then add the link as <code className="font-mono text-xs">SERVER_URL</code> in Vercel.
        </p>
      )}
      {data?.mode === "offline" && (
        <Notice tone="crit" title="Server offline">
          Last reading <Ago t={data.lastSeen} />. {data.error}. History stays safe: Netdata keeps 30 days on the server and the
          next sync fills the gap.
        </Notice>
      )}
      {data?.mode === "paused" && (
        <Notice tone="warn" title="Live view paused to protect your ngrok quota">
          {data.usage.used.toLocaleString()} of {data.usage.limit.toLocaleString()} requests used this month. Live view resumes
          on {new Date(data.usage.resetsAt).toLocaleDateString()}; the nightly sync keeps running. Switch to Tailscale Funnel to
          remove the limit.
        </Notice>
      )}
      {data?.mode === "error" && (
        <Notice tone="crit" title="The server link is not valid">
          {data.error}. Fix <code className="font-mono text-xs">SERVER_URL</code> in Vercel or in Settings.
        </Notice>
      )}

      <section aria-label="Current readings" className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {KPIS.map((m) => {
          const pts = view.get(m) ?? [];
          return <KpiTile key={m} m={m} v={snap?.values[m] ?? pts[pts.length - 1]?.v} pts={pts} info={info} />;
        })}
      </section>

      <section aria-label="Last 5 minutes" className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        {CHARTED.map((m) => {
          const series = CHART_SERIES[m]!;
          return (
            <article key={m} className="rounded-xl border border-line bg-surface p-4">
              <header className="mb-2 flex items-baseline justify-between gap-2">
                <h2 className="font-medium">{DEFS[m].label}</h2>
                <span className="text-xs text-muted">last 5 min · {series[0]?.unit}</span>
              </header>
              <LiveChart
                points={view.get(m) ?? []}
                series={series}
                windowSec={WINDOW}
                height={190}
                yMax={m === "cpu" || m === "ram" ? 100 : undefined}
              />
              <Legend series={series} />
            </article>
          );
        })}
      </section>
    </div>
  );
}

function Status({ data, error, latestT }: { data: Live | null; error: string | null; latestT: number | null }) {
  const [label, cls] = error
    ? ["Dashboard unreachable", "text-crit"]
    : data?.mode === "live"
      ? ["Live", "text-ok"]
      : data?.mode === "demo"
        ? ["Demo", "text-signal"]
        : data?.mode === "paused"
          ? ["Paused", "text-warn"]
          : ["Offline", "text-crit"];
  const btop = data && "btopUrl" in data ? data.btopUrl : undefined;
  return (
    <div className="flex items-center gap-3 text-sm">
      {btop && (
        <a href={btop} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2.5 py-1 hover:bg-surface">
          Open btop
        </a>
      )}
      <span className={`flex items-center gap-1.5 font-medium ${cls}`}>
        <span className="relative flex size-2.5">
          {data?.mode === "live" && !error && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50" />}
          <span className="relative size-2.5 rounded-full bg-current" />
        </span>
        {/* only the state is announced; the ticking "updated" text is not, so screen readers aren't spammed */}
        <span role="status" aria-live="polite">
          {label}
        </span>
        {data?.mode === "live" && !error && (
          <span className="font-normal">
            · updated <Ago t={latestT} />
          </span>
        )}
      </span>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "warn" | "crit"; title: string; children: React.ReactNode }) {
  return (
    <div role="alert" className={`rounded-lg border bg-surface px-4 py-3 text-sm ${tone === "crit" ? "border-crit/50" : "border-warn/50"}`}>
      <p className={`font-medium ${tone === "crit" ? "text-crit" : "text-warn"}`}>{title}</p>
      <p className="mt-1 text-ink/90">{children}</p>
    </div>
  );
}
