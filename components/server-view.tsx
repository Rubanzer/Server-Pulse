"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { RingBuffer } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import { mergeFrame, type PulseFrame } from "@/lib/pulse";
import { PULSE_IDLE_MS, readIdle } from "./stream-utils";
import { AnimatedNumber } from "./animated-number";
import { Legend } from "./chart-utils";
import { LiveChart } from "./live-chart";

type Conn = "connecting" | "live" | "polling" | "reconnecting" | "paused" | "unsupported" | "error";
const HISTORY = 300; // seconds of client-side history for the sparklines

// ---------- formatting ----------

function size(mib: number) {
  if (mib >= 1024 * 1024) return `${(mib / 1024 / 1024).toFixed(mib >= 10 * 1024 * 1024 ? 1 : 2)} TiB`;
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${Math.round(mib)} MiB`;
}
function rate(kib: number) {
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(1)} GiB/s`;
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MiB/s`;
  return `${Math.round(kib)} KiB/s`;
}
const mbit = (kbit: number) => `${(kbit / 1000).toFixed(kbit >= 100_000 ? 0 : 1)} Mbit/s`;
function uptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// ---------- color: sequential ramps, status color only past thresholds ----------

// A ramp is a solid color at an opacity over the card's surface, not color-mix(): that needs Chrome 111 /
// Safari 16.2, and older engines (TV and kiosk browsers on big displays) drew those tiles and bars blank.
type Tint = { c: string; a: number };
const utilColor = (p: number): Tint =>
  p >= 95 ? { c: "var(--color-crit)", a: 1 } : p >= 85 ? { c: "var(--color-warn)", a: 1 } : { c: "var(--color-signal)", a: (8 + p * 0.82) / 100 };
const tempColor = (t: number): Tint =>
  !t ? { c: "var(--color-paper)", a: 1 } : t >= 85 ? { c: "var(--color-crit)", a: 1 } : { c: "var(--color-warn)", a: (Math.max(0, Math.min(1, (t - 35) / 50)) * 85 + 5) / 100 };
const level = (p: number, warn = 85, crit = 95) => (p >= crit ? "crit" : p >= warn ? "warn" : "ok");
const LEVEL_TEXT = { ok: "", warn: "High", crit: "Critical" } as const;
const LEVEL_CLASS = { ok: "text-muted", warn: "text-warn", crit: "text-crit" } as const;

// ---------- connection: direct stream from the agent, fallback to polling through the dashboard ----------

function useServerFrames() {
  const [frame, setFrame] = useState<PulseFrame | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [note, setNote] = useState<string | null>(null);
  const [lastAt, setLastAt] = useState(0);
  const [hist, setHist] = useState<{ cpu: Point[]; mem: Point[]; net: Point[] }>({ cpu: [], mem: [], net: [] });
  const rings = useRef({ cpu: new RingBuffer<Point>(HISTORY), mem: new RingBuffer<Point>(HISTORY), net: new RingBuffer<Point>(HISTORY) });

  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => { clearTimeout(t); r(); };
    });

    const onFrame = (f: PulseFrame) => {
      setFrame((prev) => mergeFrame(prev, f));
      setLastAt(Date.now());
      const r = rings.current;
      const last = r.cpu.last();
      if (!last || f.t > last.t) {
        r.cpu.push({ t: f.t, v: { cpu: f.cpu.total } });
        r.mem.push({ t: f.t, v: { mem: f.mem.total ? (f.mem.used / f.mem.total) * 100 : 0 } });
        const inn = f.net.reduce((a, n) => a + n.in, 0) / 1000;
        const out = f.net.reduce((a, n) => a + n.out, 0) / 1000;
        r.net.push({ t: f.t, v: { in: inn, out } });
        setHist({ cpu: r.cpu.toArray(), mem: r.mem.toArray(), net: r.net.toArray() });
      }
    };

    async function stream(): Promise<"ended" | "fallback"> {
      const tk = await fetch("/api/pulse/token", { cache: "no-store" }).then((r) => r.json());
      if (stopped) return "ended";
      if (tk.demo || !tk.url) return "fallback";
      ctrl = new AbortController();
      const res = await fetch(tk.url, {
        headers: { authorization: `Bearer ${tk.token}`, "ngrok-skip-browser-warning": "1" },
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setConn("live");
      setNote(null);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await readIdle(reader, PULSE_IDLE_MS, () => ctrl?.abort());
        if (done) return "ended"; // the agent ends sessions after 15 min: reconnect with a fresh token
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) onFrame(JSON.parse(line) as PulseFrame);
        }
      }
    }

    async function poll() {
      ctrl = new AbortController();
      const res = await fetch("/api/pulse", { cache: "no-store", signal: ctrl.signal });
      const body = await res.json();
      if (res.status === 404) {
        setConn("unsupported");
        setNote(body.error);
        return false;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setConn("polling");
      onFrame(body as PulseFrame);
      return true;
    }

    (async () => {
      let streamFails = 0;
      let useStream = true;
      let backoff = 1000;
      while (!stopped) {
        if (document.hidden) {
          setConn("paused");
          await sleep(60_000);
          continue;
        }
        try {
          if (useStream) {
            const r = await stream();
            if (r === "fallback") useStream = false;
            else await sleep(1000); // a session that ended: reconnect, but never in a tight loop
            streamFails = 0;
            backoff = 1000;
            continue;
          }
          if (!(await poll())) return;
          backoff = 1000;
          await sleep(2000);
        } catch (e) {
          if (stopped || (e as Error).name === "AbortError") continue; // closed on purpose (tab hidden / unmount)
          if (useStream && ++streamFails >= 2) {
            // the browser can't reach the agent directly (e.g. ngrok's browser warning): go through the dashboard
            useStream = false;
            continue;
          }
          setConn("reconnecting");
          setNote((e as Error).message);
          await sleep(backoff + Math.random() * 500);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();

    const onVis = () => {
      clearTimeout(hiddenTimer);
      if (document.hidden) {
        // save battery and bandwidth: stop streaming 30 s after the tab is hidden
        hiddenTimer = setTimeout(() => ctrl?.abort(), 30_000);
      } else {
        wake?.();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      ctrl?.abort();
      wake?.();
      clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return { frame, conn, note, lastAt, hist };
}

// ---------- page ----------

export function ServerView() {
  // the server's name, same as on Live (status-only request: nothing is read from the server again)
  const [hostname, setHostname] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/live?lite=1", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => d?.info?.hostname && setHostname(d.info.hostname))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  const { frame, conn, note, lastAt, hist } = useServerFrames();
  // "stale" after 4 s without a frame: one timer reset per frame, instead of re-rendering the whole
  // page every second to compare clocks
  const [staleSince, setStaleSince] = useState(0);
  useEffect(() => {
    if (!lastAt) return;
    const t = setTimeout(() => setStaleSince(lastAt), 4000);
    return () => clearTimeout(t);
  }, [lastAt]);
  const stale = lastAt > 0 && staleSince === lastAt;

  if (conn === "unsupported")
    return (
      <section className="mx-auto mt-[6vh] max-w-xl rounded-xl border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold">The live server view needs the Server Pulse agent</h1>
        <p className="mt-2 text-sm text-muted">{note}</p>
        <p className="mt-4 text-sm">
          Open <a className="text-signal underline" href="/connect">Add server</a> and run its one command on your server. It installs the latest agent over the old
          one and keeps your history.
        </p>
      </section>
    );
  if (!frame)
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Connecting to your server">
        <div className="h-14 w-72 animate-pulse rounded-lg bg-surface" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-line bg-surface" />
          ))}
        </div>
        <div className="h-96 animate-pulse rounded-xl border border-line bg-surface" />
        {note && <p className="text-sm text-muted">{note}</p>}
      </div>
    );

  const f = frame;
  const memPct = f.mem.total ? (f.mem.used / f.mem.total) * 100 : 0;
  const worstDisk = (f.disks ?? []).reduce<{ path: string; pct: number } | null>((w, d) => {
    const pct = d.size ? (d.used / d.size) * 100 : 0;
    return !w || pct > w.pct ? { path: d.path, pct } : w;
  }, null);
  const netIn = f.net.reduce((a, n) => a + n.in, 0);
  const netOut = f.net.reduce((a, n) => a + n.out, 0);
  const threads = f.cpu.cores.length;

  return (
    <div className={`space-y-4 transition-opacity duration-300 ${stale ? "opacity-60" : ""}`}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{hostname ?? f.cpu.model ?? "Your server"}</h1>
          <p className="text-sm text-muted">
            {hostname && f.cpu.model ? `${f.cpu.model} · ` : ""}
            {f.cpu.physical ? `${f.cpu.physical} cores · ${threads} threads` : `${threads} CPUs`} · up {uptime(f.up)} · load {f.load[0].toFixed(2)}{" "}
            <span title="1-minute load divided by CPU count">({(f.load[0] / Math.max(1, threads)).toFixed(2)}× capacity)</span>
          </p>
        </div>
        <ConnPill conn={conn} stale={stale} note={note} />
      </header>

      <section aria-label="Summary" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <Kpi label="CPU" value={f.cpu.total} unit="%" lv={level(f.cpu.total)} spark={hist.cpu} series="cpu" yMax={100} />
        <Kpi
          label="Memory"
          value={memPct}
          unit="%"
          sub={`${size(f.mem.used)} of ${size(f.mem.total)}`}
          lv={level(memPct)}
          spark={hist.mem}
          series="mem"
          yMax={100}
        />
        <Kpi label="Fullest disk" value={worstDisk?.pct} unit="%" sub={worstDisk?.path} lv={level(worstDisk?.pct ?? 0, 80, 90)} />
        <article className="@container flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-muted">Network</h2>
          <p className="whitespace-nowrap font-cond text-[clamp(1rem,10cqi,1.5rem)] font-semibold leading-tight tabular-nums">
            <span className="text-[0.6em] font-medium text-muted">In </span>
            {mbit(netIn)}
          </p>
          <p className="whitespace-nowrap font-cond text-[clamp(1rem,10cqi,1.5rem)] font-semibold leading-tight tabular-nums">
            <span className="text-[0.6em] font-medium text-muted">Out </span>
            {mbit(netOut)}
          </p>
        </article>
      </section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CoreMap f={f} />
        <div className="grid min-w-0 grid-cols-1 gap-3">
          <MemoryCard f={f} />
          <NetCard f={f} hist={hist.net} />
        </div>
      </div>

      <DisksCard f={f} />
      <Processes procs={f.procs} cores={threads} now={f.t * 1000} />
    </div>
  );
}

function ConnPill({ conn, stale, note }: { conn: Conn; stale: boolean; note: string | null }) {
  const [label, cls] =
    stale && (conn === "live" || conn === "polling")
      ? ["Waiting for data…", "text-warn"]
      : conn === "live"
        ? ["Live · 1 s", "text-ok"]
        : conn === "polling"
          ? ["Live · via dashboard", "text-ok"]
          : conn === "paused"
            ? ["Paused (tab hidden)", "text-muted"]
            : conn === "reconnecting"
              ? ["Reconnecting…", "text-warn"]
              : ["Connecting…", "text-muted"];
  return (
    <span className={`flex items-center gap-1.5 text-sm font-medium ${cls}`} title={note ?? undefined}>
      <span className="relative flex size-2.5">
        {(conn === "live" || conn === "polling") && !stale && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50" />}
        <span className="relative size-2.5 rounded-full bg-current" />
      </span>
      <span role="status" aria-live="polite">
        {label}
      </span>
    </span>
  );
}

function Kpi({
  label,
  value,
  unit,
  sub,
  lv,
  spark,
  series,
  yMax,
}: {
  label: string;
  value: number | undefined;
  unit: string;
  sub?: string;
  lv: "ok" | "warn" | "crit";
  spark?: Point[];
  series?: string;
  yMax?: number;
}) {
  const chartSeries = useMemo(() => [{ key: series ?? "", label, unit }], [series, label, unit]);
  return (
    <article className="@container flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-line bg-surface p-4">
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="truncate text-sm font-medium text-muted">{label}</h2>
        {LEVEL_TEXT[lv] && <span className={`shrink-0 text-xs font-semibold ${LEVEL_CLASS[lv]}`}>⚠ {LEVEL_TEXT[lv]}</span>}
      </header>
      <p className="whitespace-nowrap font-cond text-[clamp(1.75rem,16cqi,2.5rem)] font-semibold leading-none tracking-tight tabular-nums">
        <AnimatedNumber value={value} />
        <span className="ml-1 text-[0.45em] font-medium text-muted">{unit}</span>
      </p>
      {sub && <p className="truncate text-xs text-muted">{sub}</p>}
      {spark && series && (
        <LiveChart points={spark} series={chartSeries} windowSec={HISTORY} height={36} compact yMax={yMax} className={lv === "ok" ? "text-signal" : LEVEL_CLASS[lv]} />
      )}
    </article>
  );
}

// ---------- 64 cores at a glance ----------

const CoreMap = memo(function CoreMap({ f }: { f: PulseFrame }) {
  const [mode, setMode] = useState<"util" | "temp">("util");
  const n = f.cpu.cores.length;
  const cols = Math.min(16, Math.ceil(Math.sqrt(n)));
  const hasTemps = !!f.cpu.temps?.some((t) => t > 0);
  const avgMHz = f.cpu.mhz?.length ? Math.round(f.cpu.mhz.reduce((a, b) => a + b, 0) / f.cpu.mhz.length) : 0;
  const hottest = Math.max(f.cpu.pkg ?? 0, ...(f.cpu.temps ?? [0]));
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="CPU cores">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">CPU cores</h2>
          <p className="text-xs text-muted">
            {n} threads
            {avgMHz ? ` · avg ${avgMHz} MHz` : ""}
            {hottest ? ` · hottest ${hottest}°C` : ""}
          </p>
        </div>
        {hasTemps && (
          <div role="tablist" aria-label="Show" className="flex rounded-lg border border-line p-0.5 text-xs">
            {(["util", "temp"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 ${mode === m ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
              >
                {m === "util" ? "Usage" : "Temperature"}
              </button>
            ))}
          </div>
        )}
      </header>
      {/* cells cap at ~64 px so a 4-core VM doesn't get giant tiles; 64 threads fill the card */}
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: cols * 64 }}>
        {f.cpu.cores.map((p, i) => {
          const t = f.cpu.temps?.[i] ?? 0;
          const v = mode === "util" ? p : t;
          const bg = mode === "util" ? utilColor(p) : tempColor(t);
          const strong = mode === "util" ? p >= 55 : t >= 70;
          return (
            <div
              key={i}
              title={`CPU ${i}: ${p}%${t ? ` · ${t}°C` : ""}${f.cpu.mhz?.[i] ? ` · ${f.cpu.mhz[i]} MHz` : ""}`}
              className={`relative grid aspect-square place-items-center overflow-hidden rounded-[4px] font-mono text-[10px] tabular-nums sm:text-[11px] ${strong ? "text-on-signal" : "text-ink"}`}
            >
              <span aria-hidden className="absolute inset-0" style={{ background: bg.c, opacity: bg.a }} />
              {/* opacity, not text-ink/80: older engines' fallback for /80 is the light-theme color */}
              <span className={`relative ${strong ? "" : "opacity-80"}`}>{mode === "util" ? v : v || "–"}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {mode === "util" ? (
          <>
            <span>Stronger color = busier.</span>
            <span className="text-warn">≥ 85% high</span>
            <span className="text-crit">≥ 95% critical</span>
          </>
        ) : (
          <>
            <span>Each pair of threads shares its physical core&apos;s sensor.</span>
            <span className="text-warn">≥ 70°C warm</span>
            <span className="text-crit">≥ 85°C hot</span>
          </>
        )}
      </p>
    </section>
  );
});

function Bar({ parts, label }: { parts: { pct: number; color: string; name: string; alpha?: number }[]; label: string }) {
  return (
    // contain: the width animation re-lays out only this 12 px track, not the whole page grid
    <div className="flex h-3 overflow-hidden rounded-full bg-paper [contain:layout_paint]" role="img" aria-label={label}>
      {parts.map((p) => (
        <span key={p.name} title={`${p.name}: ${p.pct.toFixed(0)}%`} style={{ width: `${Math.max(0, Math.min(100, p.pct))}%`, background: p.color, opacity: p.alpha ?? 1 }} className="transition-[width] duration-300" />
      ))}
    </div>
  );
}

const MemoryCard = memo(function MemoryCard({ f }: { f: PulseFrame }) {
  const m = f.mem;
  const used = m.total ? (m.used / m.total) * 100 : 0;
  const cached = m.total ? (Math.min(m.cached, m.total - m.used) / m.total) * 100 : 0;
  const swap = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0;
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Memory">
      <h2 className="mb-3 font-medium">Memory</h2>
      <Bar
        label={`Memory: ${used.toFixed(0)}% used`}
        parts={[
          { name: "Used", pct: used, color: used >= 85 ? "var(--color-warn)" : "var(--color-signal)" },
          { name: "Cache (freeable)", pct: cached, color: "var(--color-signal)", alpha: 0.35 },
        ]}
      />
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        {[
          ["Used", size(m.used)],
          ["Available", size(m.avail)],
          ["Cache", size(m.cached)],
          ["Total", size(m.total)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {m.swapTotal > 0 && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>Swap</span>
            <span className="tabular-nums">
              {size(m.swapUsed)} of {size(m.swapTotal)}
            </span>
          </div>
          <Bar label={`Swap: ${swap.toFixed(0)}% used`} parts={[{ name: "Swap used", pct: swap, color: swap >= 50 ? "var(--color-warn)" : "var(--color-signal-2)" }]} />
        </div>
      )}
    </section>
  );
});

// module-level: a new array every render would defeat LiveChart's memo and rebuild its paths
const NET_SERIES = [
  { key: "in", label: "In", unit: "Mbit/s" },
  { key: "out", label: "Out", unit: "Mbit/s" },
];

function NetCard({ f, hist }: { f: PulseFrame; hist: Point[] }) {
  const series = NET_SERIES;
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Network">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">Network</h2>
        <span className="text-xs text-muted">last 5 min</span>
      </header>
      <LiveChart points={hist} series={series} windowSec={HISTORY} height={140} />
      <Legend series={series} />
      <ul className="mt-3 space-y-1.5 text-sm">
        {f.net.map((n) => (
          <li key={n.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 tabular-nums">
            <span className="truncate font-medium" title={n.name}>
              {n.name}
            </span>
            <span className="whitespace-nowrap text-muted">↓ {mbit(n.in)}</span>
            <span className="whitespace-nowrap text-muted">↑ {mbit(n.out)}</span>
            <span className="col-span-3 text-xs text-muted">
              total {size(n.rxT)} received · {size(n.txT)} sent
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DisksCard = memo(function DisksCard({ f }: { f: PulseFrame }) {
  const disks = f.disks ?? [];
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Disks">
      <h2 className="mb-3 font-medium">Disks</h2>
      <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {disks.map((d) => {
          const pct = d.size ? (d.used / d.size) * 100 : 0;
          const lv = level(pct, 80, 90);
          return (
            <li key={d.dev + d.path} className="min-w-0">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="min-w-0 max-w-full truncate font-medium" title={`${d.path} (${d.dev}, ${d.fs})`}>
                  {d.path}
                </span>
                <span className={`ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums ${lv === "ok" ? "text-muted" : LEVEL_CLASS[lv]}`}>
                  {lv !== "ok" && "⚠ "}
                  {pct.toFixed(0)}% · {size(d.avail)} free of {size(d.size)}
                </span>
              </div>
              <Bar label={`${d.path}: ${pct.toFixed(0)}% used`} parts={[{ name: "Used", pct, color: lv === "crit" ? "var(--color-crit)" : lv === "warn" ? "var(--color-warn)" : "var(--color-signal)" }]} />
            </li>
          );
        })}
      </ul>
      {f.io.length > 0 && (
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted tabular-nums">
          {f.io.map((d) => (
            <span key={d.dev}>
              <span className="font-medium text-ink">{d.dev}</span> read {rate(d.r)} · write {rate(d.w)}
            </span>
          ))}
        </p>
      )}
    </section>
  );
});

// ---------- processes ----------

type ProcRow = NonNullable<PulseFrame["procs"]>["top"][number];
const procKey = (p: ProcRow) => `${p.pid}:${p.born ?? 0}`;

const STATE: Record<string, { label: string; cls: string }> = {
  D: { label: "waiting on disk", cls: "text-warn" },
  Z: { label: "defunct", cls: "text-crit" },
  T: { label: "stopped", cls: "text-warn" },
};

function age(born: number | undefined, now: number) {
  if (!born) return "";
  const s = Math.max(0, Math.round(now / 1000 - born));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function CpuCell({ cpu, scale }: { cpu: number; scale: number }) {
  return (
    <td className="whitespace-nowrap py-1.5 pr-3 text-right">
      <span className="inline-flex items-center justify-end gap-2">
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-paper sm:inline-block" aria-hidden>
          <span className="block h-full bg-signal" style={{ width: `${Math.min(100, cpu / scale)}%` }} />
        </span>
        {cpu >= 10 ? Math.round(cpu) : cpu.toFixed(1)}%
      </span>
    </td>
  );
}

/** One process: what it runs, who runs it, since when, and anything unusual about its state. */
function ProcCells({ p, now, indent }: { p: ProcRow; now: number; indent?: boolean }) {
  const st = p.st ? STATE[p.st] : undefined;
  return (
    <>
      <td className={`w-full max-w-0 py-1.5 pr-3 ${indent ? "pl-6" : ""}`}>
        <span className="block truncate" title={p.cmd ?? p.file ?? p.name}>
          {indent ? <span className="text-muted">{p.name}</span> : null}
          {p.file ? <span className={indent ? "ml-1.5 font-medium" : "ml-1.5 text-muted"}>{p.file}</span> : null}
          {st && <span className={`ml-1.5 text-xs ${st.cls}`}>{st.label}</span>}
        </span>
        {p.cmd && <span className="block truncate font-mono text-[11px] text-muted">{p.cmd}</span>}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-muted">{p.pid}</td>
      <td className="max-w-[8rem] truncate py-1.5 pr-3 text-muted">{p.user}</td>
      <CpuCell cpu={p.cpu} scale={1} />
      <td className="whitespace-nowrap py-1.5 pr-3 text-right">{size(p.mem)}</td>
      <td className="hidden py-1.5 pr-3 text-right text-muted sm:table-cell">{p.thr}</td>
      <td className="hidden py-1.5 text-right text-muted md:table-cell">{age(p.born, now)}</td>
    </>
  );
}

function Processes({ procs, cores, now }: { procs: PulseFrame["procs"]; cores: number; now: number }) {
  const [tab, setTab] = useState<"top" | "groups">("top");
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set()); // expanded groups / processes, kept across refreshes
  const [frozen, setFrozen] = useState<string[] | null>(null); // row order while the pointer or focus is inside
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const rows = useMemo(() => {
    if (!procs) return [];
    const needle = q.trim().toLowerCase();
    const hit = (p: ProcRow) =>
      p.name.toLowerCase().includes(needle) || p.user.toLowerCase().includes(needle) || (p.file ?? "").toLowerCase().includes(needle) || String(p.pid) === needle;
    const list =
      tab === "top"
        ? procs.top.filter((p) => !needle || hit(p)).map((p) => ({ key: procKey(p), cpu: p.cpu, mem: p.mem, proc: p, group: undefined }))
        : procs.groups
            .filter((g) => !needle || g.name.toLowerCase().includes(needle) || (g.ps ?? []).some(hit))
            .map((g) => ({ key: `g:${g.name}`, cpu: g.cpu, mem: g.mem, proc: undefined, group: g }));
    // the page re-sorts by memory too: the agent sends the biggest by memory as well as by CPU
    const seen = new Set<string>();
    const sorted = list.filter((r) => !seen.has(r.key) && seen.add(r.key)).sort((a, b) => b[sort] - a[sort]);
    if (!frozen) return sorted;
    const at = new Map(frozen.map((k, i) => [k, i]));
    return sorted.sort((a, b) => (at.get(a.key) ?? 1e9) - (at.get(b.key) ?? 1e9));
  }, [procs, tab, sort, q, frozen]);

  if (!procs) return null;
  const anyCmd = procs.top.some((p) => p.cmd);
  const groupScale = Math.max(1, cores); // a group can use every core: 157% of 8 cores is a short bar
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Processes">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Processes</h2>
          <p className="text-xs text-muted">
            {procs.count.toLocaleString()} running · the busiest by CPU and by memory · CPU% is of one core, like top
            {procs.hidden ? " · this server hides other users' processes" : ""}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div role="group" aria-label="View" className="flex rounded-lg border border-line p-0.5 text-xs">
            {(
              [
                ["top", "Top"],
                ["groups", "By program"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)} className={`rounded-md px-2.5 py-1 ${tab === k ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}>
                {l}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Sort by" className="flex rounded-lg border border-line p-0.5 text-xs">
            {(["cpu", "mem"] as const).map((k) => (
              <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)} className={`rounded-md px-2.5 py-1 ${sort === k ? "bg-paper font-medium text-ink" : "text-muted hover:text-ink"}`}>
                {k === "cpu" ? "CPU" : "Memory"}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, script, user, PID"
            aria-label="Search processes"
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-2.5 py-1 text-sm sm:w-52 sm:flex-none"
          />
        </div>
      </header>
      <div
        className="-mx-4 overflow-x-auto px-4"
        onPointerEnter={() => setFrozen(rows.map((r) => r.key))}
        onPointerLeave={() => setFrozen(null)}
        onFocus={() => setFrozen((f) => f ?? rows.map((r) => r.key))}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFrozen(null)}
      >
        <table className="w-full min-w-[600px] text-sm tabular-nums">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="w-full max-w-0 py-2 pr-3 font-medium">{tab === "top" ? "Program · script" : "Program (count)"}</th>
              <th className="py-2 pr-3 font-medium">PID</th>
              <th className="py-2 pr-3 font-medium">User</th>
              <th className="py-2 pr-3 text-right font-medium">CPU</th>
              <th className="py-2 pr-3 text-right font-medium">Memory</th>
              <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Threads</th>
              <th className="hidden py-2 text-right font-medium md:table-cell">Running for</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expanded = open.has(r.key);
              if (r.group) {
                const g = r.group;
                const members = g.ps ?? [];
                return (
                  <Fragment key={r.key}>
                    <tr className="border-b border-line">
                      <td className="py-1.5 pr-3 font-medium">
                        <button
                          onClick={() => toggle(r.key)}
                          aria-expanded={expanded}
                          className="inline-flex items-center gap-1.5 rounded text-left hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
                        >
                          <span aria-hidden className={`inline-block text-xs text-muted transition-transform ${expanded ? "rotate-90" : ""}`}>
                            ▶
                          </span>
                          {g.name}
                          <span className="text-xs font-normal text-muted">×{g.n}</span>
                          <span className="sr-only">{expanded ? ", hide its processes" : ", show its processes"}</span>
                        </button>
                      </td>
                      <td className="py-1.5 pr-3" />
                      <td className="py-1.5 pr-3" />
                      <CpuCell cpu={g.cpu} scale={groupScale} />
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right">{size(g.mem)}</td>
                      <td className="hidden sm:table-cell" />
                      <td className="hidden md:table-cell" />
                    </tr>
                    {expanded &&
                      members.map((p) => (
                        <tr key={procKey(p)} className="border-b border-line/60 bg-paper/50">
                          <ProcCells p={p} now={now} indent />
                        </tr>
                      ))}
                    {expanded && members.length === 0 && (
                      // agents before 1.3.1 send only each program's totals, not its processes
                      <tr className="border-b border-line/60 bg-paper/50">
                        <td colSpan={7} className="py-2 pl-6 pr-3 text-xs text-muted">
                          Your server&apos;s agent doesn&apos;t list a program&apos;s processes yet. Run the command from{" "}
                          <a className="text-signal underline" href="/connect">
                            Add server
                          </a>{" "}
                          on your server once: it installs the latest agent and keeps your history.
                        </td>
                      </tr>
                    )}
                    {expanded && members.length > 0 && g.n > members.length && (
                      <tr className="border-b border-line/60 bg-paper/50">
                        <td colSpan={7} className="py-1.5 pl-6 text-xs text-muted">
                          and {g.n - members.length} more using less CPU
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              }
              const p = r.proc!;
              return (
                <Fragment key={r.key}>
                  <tr className="border-b border-line">
                    <td className="w-full max-w-0 py-1.5 pr-3">
                      <button
                        onClick={() => toggle(r.key)}
                        aria-expanded={expanded}
                        className="flex max-w-full items-center gap-1.5 truncate rounded text-left hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
                      >
                        <span aria-hidden className={`inline-block text-xs text-muted transition-transform ${expanded ? "rotate-90" : ""}`}>
                          ▶
                        </span>
                        <span className="font-medium">{p.name}</span>
                        {p.file && <span className="truncate text-muted">{p.file}</span>}
                        {p.st && STATE[p.st] && <span className={`text-xs ${STATE[p.st]!.cls}`}>{STATE[p.st]!.label}</span>}
                      </button>
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-muted">{p.pid}</td>
                    <td className="max-w-[8rem] truncate py-1.5 pr-3 text-muted">{p.user}</td>
                    <CpuCell cpu={p.cpu} scale={1} />
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right">{size(p.mem)}</td>
                    <td className="hidden py-1.5 pr-3 text-right text-muted sm:table-cell">{p.thr}</td>
                    <td className="hidden py-1.5 text-right text-muted md:table-cell">{age(p.born, now)}</td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-line/60 bg-paper/50">
                      <td colSpan={7} className="px-6 py-2 text-xs">
                        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
                          <dt className="text-muted">Runs</dt>
                          <dd className="break-all">{p.file ? `${p.name} ${p.file}` : p.name}</dd>
                          {p.cmd && (
                            <>
                              <dt className="text-muted">Command</dt>
                              <dd className="break-all font-mono">{p.cmd}</dd>
                            </>
                          )}
                          <dt className="text-muted">Started</dt>
                          <dd>{p.born ? `${new Date(p.born * 1000).toLocaleString()} (${age(p.born, now)} ago)` : "unknown"}</dd>
                          <dt className="text-muted">State</dt>
                          <dd>{p.st ? (STATE[p.st]?.label ?? (p.st === "R" ? "running" : "sleeping")) : "unknown"}</dd>
                          <dt className="text-muted">Threads</dt>
                          <dd>{p.thr}</dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted">
                  {q ? `No process matches “${q}”.` : "No processes to show."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        {tab === "groups" ? "Open a program to see its processes. " : "Open a process for its details. "}
        The list holds still while your pointer or keyboard is in it.{" "}
        {anyCmd
          ? "Command lines are shown with passwords and tokens removed."
          : "For Python, Node and other interpreters the script name is shown; full command lines stay hidden to keep secrets out of view."}
      </p>
    </section>
  );
}
