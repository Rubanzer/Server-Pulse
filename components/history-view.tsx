"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Lru, stats, type Gap } from "@/lib/algo";
import { DEFS, METRICS, type Metric, type Point } from "@/lib/charts";
import { toLogin } from "@/lib/navigate";
import { fmtNum, Legend, SeriesChart } from "./series-chart";
import { fmtWindow, TimeRange } from "./time-range";

const PRESETS = [
  { key: "1h", label: "1 hour", sec: 3600 },
  { key: "6h", label: "6 hours", sec: 6 * 3600 },
  { key: "24h", label: "24 hours", sec: 86400 },
  { key: "7d", label: "7 days", sec: 7 * 86400 },
  { key: "30d", label: "30 days", sec: 30 * 86400 },
  { key: "90d", label: "90 days", sec: 90 * 86400 },
  { key: "1y", label: "1 year", sec: 365 * 86400 },
];

type Result =
  | {
      source: string;
      step: number;
      points: Point[];
      note?: string;
      gaps: Gap[];
      firstSample: number | null;
      coverage: number;
    }
  | { error: string };
type All = Partial<Record<Metric, Result>>;

/** Ranges already fetched this session (all charts at once): revisiting a range or going back is instant. */
const cache = new Lru<string, All>(24);

const fmtDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const fmtSpan = (sec: number) =>
  sec >= 60 * 86400
    ? `${Math.round(sec / (30 * 86400))} months`
    : sec >= 2 * 86400
      ? `${Math.round(sec / 86400)} days`
      : `${Math.max(1, Math.round(sec / 3600))} hours`;
const minute = () => Math.floor(Date.now() / 60_000) * 60;

function csv(metric: Metric, points: Point[]) {
  const keys = DEFS[metric].series.map((s) => s.key);
  const head = [
    "time_utc",
    ...DEFS[metric].series.map(
      (s) => `${s.key}${s.unit ? `_${s.unit.replace(/[^a-z%°]/gi, "")}` : ""}`,
    ),
  ];
  const lines = points.map((p) =>
    [new Date(p.t * 1000).toISOString(), ...keys.map((k) => p.v[k] ?? "")].join(
      ",",
    ),
  );
  const blob = new Blob([[head.join(","), ...lines].join("\n")], {
    type: "text/csv",
  });
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

  const setRange = (q: Record<string, string>) =>
    router.replace(`${path}?${new URLSearchParams(q)}`, { scroll: false });
  // push, not replace: the browser's Back button undoes a zoom
  const zoom = useCallback(
    (f: number, t: number) =>
      router.push(
        `${path}?${new URLSearchParams({ from: String(Math.floor(f)), to: String(Math.ceil(t)) })}`,
        { scroll: false },
      ),
    [router, path],
  );

  const key = `${from}-${to}`;
  // the charts on screen and the range they belong to: the previous range stays (dimmed) until the
  // new one lands, so nothing flashes to a skeleton. One request brings every chart.
  const [shown, setShown] = useState<{ key: string; all: All } | null>(() => {
    const hit = cache.peek(key);
    return hit ? { key, all: hit } : null;
  });
  useEffect(() => {
    const ctrl = new AbortController();
    // seven charts of ~500 points: a transition lets React build them without freezing input
    const show = (all: All) =>
      !ctrl.signal.aborted && startTransition(() => setShown({ key, all }));
    const hit = cache.get(key);
    if (hit) {
      queueMicrotask(() => show(hit));
      return () => ctrl.abort();
    }
    fetch(`/api/history?from=${from}&to=${to}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 401) return toLogin();
        // a gateway error page isn't JSON: show its status, not a parser message
        const body = (await res.json().catch(() => ({}))) as {
          charts?: All;
          error?: string;
        };
        if (!body.charts)
          return show(
            Object.fromEntries(
              METRICS.map((m) => [
                m,
                { error: body.error ?? `HTTP ${res.status}` },
              ]),
            ),
          );
        cache.set(key, body.charts);
        show(body.charts);
      })
      .catch(
        (e: Error) =>
          e.name !== "AbortError" &&
          show(
            Object.fromEntries(METRICS.map((m) => [m, { error: e.message }])),
          ),
      );
    return () => ctrl.abort();
  }, [key, from, to, router]);
  const loading = shown?.key !== key;
  // what this range actually holds: monitoring may have started inside it
  const ok = Object.values(shown?.all ?? {}).filter(
    (r): r is Exclude<Result, { error: string }> => !!r && !("error" in r),
  );
  const firstSample = ok.reduce<number | null>(
    (a, r) =>
      r.firstSample !== null && (a === null || r.firstSample < a)
        ? r.firstSample
        : a,
    null,
  );
  const nowS = now; // pinned when the range was picked
  const startsInside = firstSample !== null && firstSample > from;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted">
            {fmtWindow(from, to)}. Drag across a chart to zoom in (on a phone,
            set From and To).
          </p>
          {!loading && firstSample === null && ok.length > 0 && (
            <p className="mt-1 text-sm">
              No readings stored yet. They appear here as soon as your server
              sends data.
            </p>
          )}
          {!loading && startsInside && firstSample! < to && (
            <p className="mt-1 text-sm">
              Monitoring started {fmtDay(firstSample!)}, so this range holds{" "}
              {fmtSpan(Math.min(to, nowS) - firstSample!)} of data.{" "}
              <button
                className="text-signal underline"
                onClick={() => zoom(firstSample!, Math.min(to, nowS))}
              >
                Show only that
              </button>
            </p>
          )}
          {!loading && firstSample !== null && firstSample >= to && (
            <p className="mt-1 text-sm">
              This range is before monitoring started ({fmtDay(firstSample)}):
              there&apos;s nothing to show.
            </p>
          )}
        </div>
        {owner && (
          <nav
            aria-label="Same time elsewhere"
            className="flex flex-wrap gap-2 text-sm"
          >
            <Link
              href={`/logs?${new URLSearchParams({ from: String(from), to: String(to) })}`}
              className="whitespace-nowrap rounded-lg border border-line px-3 py-1.5 hover:border-signal"
            >
              Logs for this time
            </Link>
            <Link
              href={`/logs?${new URLSearchParams({ from: String(from), to: String(to) })}#failures`}
              className="whitespace-nowrap rounded-lg border border-line px-3 py-1.5 hover:border-signal"
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

      {/* the last chart spans the row instead of sitting alone in half of it */}
      <div
        className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3 lg:max-2xl:[&>:last-child:nth-child(odd)]:col-span-2 2xl:[&>:last-child:nth-child(3n+1)]:col-span-3"
        aria-busy={loading}
      >
        {METRICS.map((m) => (
          <HistoryCard
            key={m}
            m={m}
            r={shown?.all[m]}
            stale={loading && !!shown}
            onZoom={zoom}
            from={from}
            to={to}
          />
        ))}
      </div>
    </div>
  );
}

const HistoryCard = memo(function HistoryCard({
  m,
  r,
  stale,
  onZoom,
  from,
  to,
}: {
  m: Metric;
  r: Result | undefined;
  stale: boolean;
  onZoom: (f: number, t: number) => void;
  from: number;
  to: number;
}) {
  const domain = useMemo<[number, number]>(() => [from, to], [from, to]);
  const series = useMemo(
    () => DEFS[m].series.filter((s) => s.key !== "usedGiB"),
    [m],
  );
  const pts = r && "points" in r ? r.points : EMPTY;
  const first = series[0]!;
  const st = useMemo(() => {
    const s = stats(pts.map((p) => p.v[first.key] ?? NaN));
    // long ranges average many readings per point: the true peak is the highest kept peak reading
    const peak = pts.reduce(
      (m, p) => Math.max(m, p.pk?.[first.key] ?? p.v[first.key] ?? -Infinity),
      -Infinity,
    );
    return s && Number.isFinite(peak)
      ? { ...s, peak: Math.max(s.peak, peak) }
      : s;
  }, [pts, first.key]);
  return (
    <article
      id={m}
      className="min-w-0 scroll-mt-28 rounded-xl border border-line bg-surface p-4"
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{DEFS[m].label}</h2>
        <div className="flex items-center gap-3 text-xs text-muted">
          {r && "source" in r && (
            <span>
              {r.source === "netdata"
                ? "From server"
                : r.source === "database"
                  ? "From database"
                  : "Demo"}
            </span>
          )}
          <button
            disabled={!pts.length}
            onClick={() => csv(m, pts)}
            className="rounded border border-line px-2 py-0.5 hover:text-ink disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      </header>
      <div
        className={`transition-opacity duration-200 ${stale ? "opacity-70" : "opacity-100"}`}
        aria-busy={stale}
      >
        {!r ? (
          <div className="h-[13.75rem] animate-pulse rounded-lg bg-paper" />
        ) : "error" in r ? (
          <p className="grid h-[13.75rem] place-items-center px-6 text-center text-sm text-crit">
            {r.error}
          </p>
        ) : (
          <>
            <SeriesChart
              points={pts}
              series={series}
              onZoom={onZoom}
              yMax={first.unit === "%" ? 100 : undefined}
              domain={domain}
              gaps={r.gaps}
              firstSample={r.firstSample}
              empty={
                r.firstSample === null
                  ? m === "temp"
                    ? "Your server hasn't reported a temperature. That needs hardware sensors, which virtual machines and some cloud servers don't have."
                    : "No readings for this chart yet."
                  : r.firstSample >= to
                    ? "Before monitoring started."
                    : "No readings in this range."
              }
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Legend series={series} />
              {st && (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {(["avg", "p95", "peak"] as const).map((k) => (
                    <div key={k} className="flex gap-1">
                      <dt
                        className="text-muted"
                        title={
                          k === "p95"
                            ? "95th percentile: the value was below this 95% of the time"
                            : undefined
                        }
                      >
                        {k === "avg"
                          ? "Average"
                          : k === "p95"
                            ? "Usually below"
                            : "Peak"}
                      </dt>
                      <dd className="font-medium">
                        {fmtNum(st[k], first.unit)}
                      </dd>
                    </div>
                  ))}
                  {/* averages and peaks only count measured time; say how much of the range that is */}
                  <div
                    className="flex gap-1"
                    title="Share of the monitored part of this range that has readings"
                  >
                    <dt className="text-muted">Data recorded</dt>
                    <dd
                      className={`font-medium ${r.coverage < 0.9 ? "text-warn" : ""}`}
                    >
                      {Math.round(r.coverage * 100)}%
                      {r.coverage < 0.9 ? " (low)" : ""}
                    </dd>
                  </div>
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
