"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Lru, stats } from "@/lib/algo";
import { DEFS, METRICS, type Metric, type Point } from "@/lib/charts";
import { fmtNum, Legend, SeriesChart } from "./series-chart";
import { TimeRange } from "./time-range";

const PRESETS = [
  { key: "1h", label: "1 hour", sec: 3600 },
  { key: "6h", label: "6 hours", sec: 6 * 3600 },
  { key: "24h", label: "24 hours", sec: 86400 },
  { key: "7d", label: "7 days", sec: 7 * 86400 },
  { key: "30d", label: "30 days", sec: 30 * 86400 },
  { key: "90d", label: "90 days", sec: 90 * 86400 },
  { key: "1y", label: "1 year", sec: 365 * 86400 },
];

type Result = { source: string; step: number; points: Point[]; note?: string } | { error: string };

/** Ranges already fetched this session, per metric: revisiting a range (or going back) is instant. */
const cache = new Lru<string, Result>(7 * 24);
const minute = () => Math.floor(Date.now() / 60_000) * 60;

function csv(metric: Metric, points: Point[]) {
  const keys = DEFS[metric].series.map((s) => s.key);
  const head = ["time_utc", ...DEFS[metric].series.map((s) => `${s.key}${s.unit ? `_${s.unit.replace(/[^a-z%°]/gi, "")}` : ""}`)];
  const lines = points.map((p) => [new Date(p.t * 1000).toISOString(), ...keys.map((k) => p.v[k] ?? "")].join(","));
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `server-pulse-${metric}-${new Date((points[0]?.t ?? 0) * 1000).toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function HistoryView({ owner = false }: { owner?: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();

  // "now" is pinned (to the minute) when a range is picked, so re-renders don't shift the window
  // and repeat views of a preset within the same minute come straight from the cache
  const [now, setNow] = useState(minute);
  const { from, to, preset } = useMemo(() => {
    const f = Number(params.get("from"));
    const t = Number(params.get("to"));
    if (f > 0 && t > f) return { from: f, to: t, preset: null };
    const p = PRESETS.find((x) => x.key === params.get("range")) ?? PRESETS[2]!;
    return { from: now - p.sec, to: now, preset: p.key };
  }, [params, now]);

  const setRange = (q: Record<string, string>) => router.replace(`${path}?${new URLSearchParams(q)}`, { scroll: false });
  const zoom = useCallback(
    (f: number, t: number) => router.replace(`${path}?${new URLSearchParams({ from: String(Math.floor(f)), to: String(Math.ceil(t)) })}`, { scroll: false }),
    [router, path],
  );

  const key = `${from}-${to}`;
  // per metric: the result on screen and which range it belongs to. A chart keeps showing its previous
  // range (dimmed) until its new data lands, so nothing flashes to a skeleton; each chart updates as
  // soon as its own request finishes instead of waiting for all seven.
  const [shown, setShown] = useState<Partial<Record<Metric, { key: string; r: Result }>>>(() => {
    const init: Partial<Record<Metric, { key: string; r: Result }>> = {};
    for (const m of METRICS) {
      const r = cache.peek(`${m}|${key}`);
      if (r) init[m] = { key, r };
    }
    return init;
  });
  useEffect(() => {
    const ctrl = new AbortController();
    for (const m of METRICS) {
      const ck = `${m}|${key}`;
      const hit = cache.get(ck);
      const show = (r: Result) => !ctrl.signal.aborted && setShown((s) => ({ ...s, [m]: { key, r } }));
      if (hit) {
        queueMicrotask(() => show(hit));
        continue;
      }
      fetch(`/api/history?chart=${m}&from=${from}&to=${to}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (res.status === 401) return router.replace("/login");
          const r = (await res.json()) as Result;
          if (res.ok) cache.set(ck, r);
          show(r);
        })
        .catch((e: Error) => e.name !== "AbortError" && show({ error: e.message }));
    }
    return () => ctrl.abort();
  }, [key, from, to, router]);
  const loading = METRICS.some((m) => shown[m]?.key !== key);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted">
            {new Date(from * 1000).toLocaleString()} to {new Date(to * 1000).toLocaleString()}. Drag across a chart to zoom in.
          </p>
        </div>
        {owner && (
          <nav aria-label="Same time elsewhere" className="flex gap-2 text-sm">
            <Link
              href={`/logs?${new URLSearchParams({ from: String(from), to: String(to) })}`}
              className="rounded-lg border border-line px-3 py-1.5 hover:border-signal"
            >
              Logs for this time
            </Link>
            <Link
              href={`/logs?${new URLSearchParams({ from: String(from), to: String(to) })}#failures`}
              className="rounded-lg border border-line px-3 py-1.5 hover:border-signal"
            >
              Failures for this time
            </Link>
          </nav>
        )}
      </header>

      <TimeRange
        presets={PRESETS}
        preset={preset}
        from={from}
        to={to}
        onPreset={(k) => {
          setNow(minute());
          setRange({ range: k });
        }}
        onRange={zoom}
      />

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3" aria-busy={loading}>
        {METRICS.map((m) => {
          const e = shown[m];
          return <HistoryCard key={m} m={m} r={e?.r} stale={!!e && e.key !== key} onZoom={zoom} />;
        })}
      </div>
    </div>
  );
}

const HistoryCard = memo(function HistoryCard({
  m,
  r,
  stale,
  onZoom,
}: {
  m: Metric;
  r: Result | undefined;
  stale: boolean;
  onZoom: (f: number, t: number) => void;
}) {
  const series = useMemo(() => DEFS[m].series.filter((s) => s.key !== "usedGiB"), [m]);
  const pts = r && "points" in r ? r.points : EMPTY;
  const first = series[0]!;
  const st = useMemo(() => stats(pts.map((p) => p.v[first.key] ?? NaN)), [pts, first.key]);
  return (
    <article id={m} className="scroll-mt-28 rounded-xl border border-line bg-surface p-4">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{DEFS[m].label}</h2>
        <div className="flex items-center gap-3 text-xs text-muted">
          {r && "source" in r && <span>{r.source === "netdata" ? "From server" : r.source === "database" ? "From database" : "Demo"}</span>}
          <button disabled={!pts.length} onClick={() => csv(m, pts)} className="rounded border border-line px-2 py-0.5 hover:text-ink disabled:opacity-40">
            Export CSV
          </button>
        </div>
      </header>
      <div className={`transition-opacity duration-200 ${stale ? "opacity-50" : "opacity-100"}`} aria-busy={stale}>
        {!r ? (
          <div className="h-[220px] animate-pulse rounded-lg bg-paper" />
        ) : "error" in r ? (
          <p className="grid h-[220px] place-items-center px-6 text-center text-sm text-crit">{r.error}</p>
        ) : (
          <>
            <SeriesChart points={pts} series={series} onZoom={onZoom} yMax={first.unit === "%" ? 100 : undefined} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Legend series={series} />
              {st && (
                <dl className="flex gap-4 text-xs">
                  {(["avg", "p95", "peak"] as const).map((k) => (
                    <div key={k} className="flex gap-1">
                      <dt className="text-muted">{k === "avg" ? "Average" : k === "p95" ? "95th pct" : "Peak"}</dt>
                      <dd className="font-medium">{fmtNum(st[k], first.unit)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {r.note && <p className="mt-1 text-xs text-warn">{r.note}</p>}
          </>
        )}
      </div>
    </article>
  );
});

const EMPTY: Point[] = [];
