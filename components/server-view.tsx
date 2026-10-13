"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { RingBuffer } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import { mergeFrame, type PulseFrame } from "@/lib/pulse";
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

const utilColor = (p: number) =>
  p >= 95 ? "var(--color-crit)" : p >= 85 ? "var(--color-warn)" : `color-mix(in oklab, var(--color-signal) ${Math.round(8 + p * 0.82)}%, var(--color-surface))`;
const tempColor = (t: number) =>
  !t ? "var(--color-paper)" : t >= 85 ? "var(--color-crit)" : `color-mix(in oklab, var(--color-warn) ${Math.round(Math.max(0, Math.min(1, (t - 35) / 50)) * 85 + 5)}%, var(--color-surface))`;
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
        const { value, done } = await reader.read();
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
  const { frame, conn, note, lastAt, hist } = useServerFrames();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const stale = lastAt > 0 && now - lastAt > 4000;

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
          <h1 className="truncate text-2xl font-semibold tracking-tight">{f.cpu.model ?? "Your server"}</h1>
          <p className="text-sm text-muted">
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
        <article className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-muted">Network</h2>
          <p className="font-cond text-xl font-semibold leading-tight">
            <span className="text-sm font-medium text-muted">In </span>
            {mbit(netIn)}
          </p>
          <p className="font-cond text-xl font-semibold leading-tight">
            <span className="text-sm font-medium text-muted">Out </span>
            {mbit(netOut)}
          </p>
        </article>
      </section>

      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <CoreMap f={f} />
        <div className="grid gap-3">
          <MemoryCard f={f} />
          <NetCard f={f} hist={hist.net} />
        </div>
      </div>

      <DisksCard f={f} />
      <Processes procs={f.procs} />
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
  return (
    <article className="flex flex-col justify-between gap-2 rounded-xl border border-line bg-surface p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-muted">{label}</h2>
        {LEVEL_TEXT[lv] && <span className={`text-xs font-semibold ${LEVEL_CLASS[lv]}`}>⚠ {LEVEL_TEXT[lv]}</span>}
      </header>
      <p className="font-cond text-4xl font-semibold leading-none tracking-tight">
        <AnimatedNumber value={value} />
        <span className="ml-1 text-lg font-medium text-muted">{unit}</span>
      </p>
      {sub && <p className="truncate text-xs text-muted">{sub}</p>}
      {spark && series && (
        <LiveChart points={spark} series={[{ key: series, label, unit }]} windowSec={HISTORY} height={36} compact yMax={yMax} className={lv === "ok" ? "text-signal" : LEVEL_CLASS[lv]} />
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
              className={`grid aspect-square place-items-center rounded-[4px] font-mono text-[10px] tabular-nums transition-colors duration-300 sm:text-[11px] ${strong ? "text-on-signal" : "text-ink/80"}`}
              style={{ background: bg }}
            >
              {mode === "util" ? v : v || "–"}
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

function Bar({ parts, label }: { parts: { pct: number; color: string; name: string }[]; label: string }) {
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-paper" role="img" aria-label={label}>
      {parts.map((p) => (
        <span key={p.name} title={`${p.name}: ${p.pct.toFixed(0)}%`} style={{ width: `${Math.max(0, Math.min(100, p.pct))}%`, background: p.color }} className="transition-[width] duration-300" />
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
          { name: "Cache (freeable)", pct: cached, color: "color-mix(in oklab, var(--color-signal) 35%, var(--color-surface))" },
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

function NetCard({ f, hist }: { f: PulseFrame; hist: Point[] }) {
  const series = [
    { key: "in", label: "In", unit: "Mbit/s" },
    { key: "out", label: "Out", unit: "Mbit/s" },
  ];
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Network">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">Network</h2>
        <span className="text-xs text-muted">last 5 min</span>
      </header>
      <LiveChart points={hist} series={series} windowSec={HISTORY} height={140} />
      <Legend series={series} />
      <ul className="mt-3 space-y-1 text-sm">
        {f.net.map((n) => (
          <li key={n.name} className="flex flex-wrap justify-between gap-x-4 tabular-nums">
            <span className="font-medium">{n.name}</span>
            <span className="text-muted">
              ↓ {mbit(n.in)} · ↑ {mbit(n.out)} · total {size(n.rxT)} / {size(n.txT)}
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
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate font-medium" title={`${d.path} (${d.dev}, ${d.fs})`}>
                  {d.path}
                </span>
                <span className={`shrink-0 text-xs tabular-nums ${lv === "ok" ? "text-muted" : LEVEL_CLASS[lv]}`}>
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

function Processes({ procs }: { procs: PulseFrame["procs"] }) {
  const [tab, setTab] = useState<"top" | "groups">("top");
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const [q, setQ] = useState("");
  const [frozen, setFrozen] = useState<string[] | null>(null); // row order while the pointer is inside

  const rows = useMemo(() => {
    if (!procs) return [];
    const list =
      tab === "top"
        ? procs.top.map((p) => ({ key: String(p.pid), name: p.name, pid: p.pid, user: p.user, cpu: p.cpu, mem: p.mem, thr: p.thr, n: 1, cmd: p.cmd }))
        : procs.groups.map((g) => ({ key: g.name, name: g.name, pid: 0, user: "", cpu: g.cpu, mem: g.mem, thr: 0, n: g.n, cmd: undefined }));
    const needle = q.trim().toLowerCase();
    const filtered = needle ? list.filter((r) => r.name.toLowerCase().includes(needle) || r.user.toLowerCase().includes(needle) || String(r.pid).includes(needle)) : list;
    const sorted = [...filtered].sort((a, b) => b[sort] - a[sort]);
    if (!frozen) return sorted;
    const at = new Map(frozen.map((k, i) => [k, i]));
    return sorted.sort((a, b) => (at.get(a.key) ?? 1e9) - (at.get(b.key) ?? 1e9));
  }, [procs, tab, sort, q, frozen]);

  if (!procs) return null;
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Processes">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Processes</h2>
          <p className="text-xs text-muted">
            {procs.count.toLocaleString()} running · top {procs.top.length} by CPU · CPU% is of one core, like top
            {procs.hidden ? " · this server hides other users' processes" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="View" className="flex rounded-lg border border-line p-0.5 text-xs">
            {(
              [
                ["top", "Top"],
                ["groups", "By program"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-2.5 py-1 ${tab === k ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}>
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
            placeholder="Search"
            aria-label="Search processes"
            className="w-36 rounded-lg border border-line bg-paper px-2.5 py-1 text-sm"
          />
        </div>
      </header>
      <div
        className="-mx-4 overflow-x-auto px-4"
        onPointerEnter={() => setFrozen(rows.map((r) => r.key))}
        onPointerLeave={() => setFrozen(null)}
      >
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium">{tab === "top" ? "Program" : "Program (count)"}</th>
              {tab === "top" && <th className="py-2 pr-3 font-medium">PID</th>}
              {tab === "top" && <th className="py-2 pr-3 font-medium">User</th>}
              <th className="py-2 pr-3 text-right font-medium">CPU</th>
              <th className="py-2 pr-3 text-right font-medium">Memory</th>
              {tab === "top" && <th className="hidden py-2 text-right font-medium sm:table-cell">Threads</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0">
                <td className="max-w-[18rem] truncate py-1.5 pr-3 font-medium" title={r.cmd ?? r.name}>
                  {r.name}
                  {tab === "groups" && <span className="ml-1 text-xs font-normal text-muted">×{r.n}</span>}
                </td>
                {tab === "top" && <td className="py-1.5 pr-3 text-muted">{r.pid}</td>}
                {tab === "top" && <td className="py-1.5 pr-3 text-muted">{r.user}</td>}
                <td className="py-1.5 pr-3 text-right">
                  <span className="inline-flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-paper sm:inline-block" aria-hidden>
                      <span className="block h-full bg-signal" style={{ width: `${Math.min(100, r.cpu)}%` }} />
                    </span>
                    {r.cpu >= 10 ? Math.round(r.cpu) : r.cpu.toFixed(1)}%
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right">{size(r.mem)}</td>
                {tab === "top" && <td className="hidden py-1.5 text-right text-muted sm:table-cell">{r.thr}</td>}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  No process matches “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">The list holds still while your pointer is over it. Command lines are hidden to keep secrets out of view.</p>
    </section>
  );
}
