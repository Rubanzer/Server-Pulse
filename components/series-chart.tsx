"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { nearestIndex, type Gap, type GapReason } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import { axisNum, COLORS, DASHES, fmtNum, type SeriesDef } from "./chart-utils";

export { fmtNum, Legend } from "./chart-utils";

// Hand-drawn SVG (no chart library): the whole History page used to freeze for a quarter second
// (seconds on a TV) inside Recharts. Formatters are created once, never per tick or per hover.
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const MONTH = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
}); // "Oct 2026", not "Oct 26" (a day?)
const FULL = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const fmtTime = (t: number, span: number) =>
  (span <= 2 * 86400 ? TIME : span <= 120 * 86400 ? DAY : MONTH).format(
    t * 1000,
  );
const fmtFull = (t: number) => FULL.format(t * 1000);

export const GAP_LABEL: Record<GapReason, string> = {
  off: "Server off",
  agent: "Agent stopped",
  pending: "Filling from server…",
  nodata: "No data",
};

/** Shaded stretches: a gap (with its reason) or the time before monitoring started. */
type Band = {
  from: number;
  to: number;
  label: string;
  kind: "gap" | "off" | "before";
};

/** Layout in rem, so axes and text grow with the TV root font size. */
const PAD = { l: 2.75, r: 0.5, t: 0.5, b: 1.75 };
const FONT = 0.6875;

type Size = { w: number; h: number; rem: number };
type Geo = {
  rem: number;
  width: number;
  height: number;
  pl: number;
  pt: number;
  pw: number;
  ph: number;
  x0: number;
  x1: number;
  span: number;
  top: number;
  yTicks: number[];
  xTicks: number[];
  ts: number[];
  paths: string[];
};

const xOf = (g: Geo, t: number) => g.pl + ((t - g.x0) / (g.x1 - g.x0)) * g.pw;
const yOf = (g: Geo, v: number) => g.pt + g.ph - (v / g.top) * g.ph;
const ok = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);

/** y axis 0…top: the fixed maximum when the data fits under it, else a nice 1/2/5 step (whole-number labels stay true). */
function yScale(dataMax: number, yMax?: number) {
  if (yMax !== undefined && dataMax <= yMax)
    return { top: yMax, step: yMax / 4 };
  if (!(dataMax > 0)) return { top: 1, step: 0.25 };
  const raw = dataMax / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10]
    .map((k) => k * p)
    .find((s) => s >= raw * (1 - 1e-9))!;
  return { top: Math.ceil(dataMax / step - 1e-9) * step, step };
}

function geometry(
  points: Point[],
  series: SeriesDef[],
  size: Size,
  domain: [number, number] | undefined,
  yMax: number | undefined,
): Geo {
  const { w: width, h: height, rem } = size;
  const pl = PAD.l * rem;
  const pt = PAD.t * rem;
  const pw = Math.max(1, width - pl - PAD.r * rem);
  const ph = Math.max(1, height - pt - PAD.b * rem);
  const ts = points.map((p) => p.t);
  let [x0, x1] = domain ?? [ts[0]!, ts[ts.length - 1]!];
  if (x1 <= x0) [x0, x1] = [x0 - 1800, x1 + 1800]; // a single point: an hour around it
  const span = domain
    ? x1 - x0
    : points.length > 1
      ? ts[ts.length - 1]! - ts[0]!
      : 3600;

  let dataMax = 0;
  for (const p of points)
    for (const s of series) {
      const v = p.v[s.key];
      if (ok(v) && v > dataMax) dataMax = v;
    }
  const { top, step } = yScale(dataMax, yMax);
  const yTicks: number[] = [];
  for (let i = 0, n = Math.round(top / step); i <= n; i++)
    yTicks.push(i * step);

  // evenly spaced time labels, as many as fit (~7 rem each)
  const nx = Math.max(2, Math.min(6, Math.floor(pw / (7 * rem)) + 1));
  const xTicks = Array.from({ length: nx }, (_, i) =>
    Math.round(x0 + ((x1 - x0) * i) / (nx - 1)),
  );

  const g: Geo = {
    rem,
    width,
    height,
    pl,
    pt,
    pw,
    ph,
    x0,
    x1,
    span,
    top,
    yTicks,
    xTicks,
    ts,
    paths: [],
  };
  const kx = pw / (x1 - x0);
  const ky = ph / top;
  const r = (v: number) => Math.round(v * 10) / 10;
  // straight segments (curves overshoot next to gaps), pen lifted at every missing value: a line never crosses a gap
  g.paths = series.map((s) => {
    let d = "";
    let run = 0;
    for (let i = 0; i < points.length; i++) {
      const v = points[i]!.v[s.key];
      if (!ok(v)) {
        if (run === 1) d += "h1.5"; // a lone reading between gaps still shows as a short tick
        run = 0;
        continue;
      }
      d +=
        (run++ ? "L" : "M") +
        r(pl + (ts[i]! - x0) * kx) +
        "," +
        r(pt + ph - v * ky);
    }
    if (run === 1) d += "h1.5";
    return d;
  });
  return g;
}

/** The expensive part: memoized on geometry, so hover and drag never re-render it. */
const Plot = memo(function Plot({
  g,
  bands,
  series,
  id,
}: {
  g: Geo;
  bands: Band[];
  series: SeriesDef[];
  id: string;
}) {
  const font = FONT * g.rem;
  return (
    <svg
      width={g.width}
      height={g.height}
      className="absolute inset-0 block"
      style={{ fontSize: `${FONT}rem` }}
      aria-hidden
    >
      <defs>
        <clipPath id={`${id}c`}>
          <rect x={g.pl} y={0} width={g.pw} height={g.height} />
        </clipPath>
        {[45, -45].map((a) => (
          <pattern
            key={a}
            id={`${id}h${a}`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform={`rotate(${a})`}
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              stroke="var(--color-muted)"
              strokeWidth="1.5"
              strokeOpacity="0.6"
            />
          </pattern>
        ))}
      </defs>
      {g.yTicks.map((v, i) => {
        const y = yOf(g, v);
        return (
          <g key={i}>
            <line
              x1={g.pl}
              x2={g.pl + g.pw}
              y1={y}
              y2={y}
              stroke="var(--color-line)"
            />
            <text
              x={g.pl - 0.375 * g.rem}
              y={y}
              dy="0.32em"
              textAnchor="end"
              fill="var(--color-muted)"
            >
              {axisNum(v, g.top)}
            </text>
          </g>
        );
      })}
      {g.xTicks.map((t, i) => (
        // edge labels anchor inward: the first never runs into the y axis' "0", the last is never cut off
        <text
          key={i}
          x={xOf(g, t)}
          y={g.pt + g.ph + 1.25 * g.rem}
          textAnchor={
            i === 0 ? "start" : i === g.xTicks.length - 1 ? "end" : "middle"
          }
          fill="var(--color-muted)"
        >
          {fmtTime(t, g.span)}
        </text>
      ))}
      <g clipPath={`url(#${id}c)`}>
        {bands.map((b) => {
          const a = Math.max(g.pl, xOf(g, b.from));
          const z = Math.min(g.pl + g.pw, xOf(g, b.to));
          if (z <= g.pl || a >= g.pl + g.pw) return null;
          const w = Math.max(3, z - a); // a short gap still shows
          const x = Math.min(a, g.pl + g.pw - w);
          const fits = z - a >= b.label.length * font * 0.55 + 8; // a label only where it fits; the tooltip names narrow ones
          return (
            <g key={`${b.kind}${b.from}`}>
              {b.kind === "before" ? (
                <rect
                  x={x}
                  y={g.pt}
                  width={w}
                  height={g.ph}
                  fill="var(--color-paper)"
                  fillOpacity={0.8}
                />
              ) : (
                <>
                  {b.kind === "off" && (
                    <rect
                      x={x}
                      y={g.pt}
                      width={w}
                      height={g.ph}
                      fill="var(--color-muted)"
                      fillOpacity={0.12}
                    />
                  )}
                  <rect
                    x={x}
                    y={g.pt}
                    width={w}
                    height={g.ph}
                    fill={`url(#${id}h${b.kind === "off" ? -45 : 45})`}
                  />
                </>
              )}
              {fits && (
                <text
                  x={(a + z) / 2}
                  y={g.pt + font + 4}
                  textAnchor="middle"
                  fill="var(--color-muted)"
                >
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
        {g.paths.map((d, i) => (
          <path
            key={series[i]!.key}
            d={d}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={1.6}
            strokeDasharray={DASHES[i % DASHES.length]}
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );
});

/** The hovered point: a cursor line, a dot per series and the tooltip. Cheap to re-render. */
const Hover = memo(function Hover({
  g,
  p,
  series,
  band,
}: {
  g: Geo;
  p: Point;
  series: SeriesDef[];
  band: Band | undefined;
}) {
  const x = xOf(g, p.t);
  return (
    <>
      <svg
        width={g.width}
        height={g.height}
        className="pointer-events-none absolute inset-0 block"
        aria-hidden
      >
        <line
          x1={x}
          x2={x}
          y1={g.pt}
          y2={g.pt + g.ph}
          stroke="var(--color-muted)"
          strokeOpacity={0.6}
        />
        {series.map((s, i) => {
          const v = p.v[s.key];
          return ok(v) ? (
            <circle
              key={s.key}
              cx={x}
              cy={yOf(g, v)}
              r={3}
              fill={COLORS[i % COLORS.length]}
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          ) : null;
        })}
      </svg>
      <div
        className="pointer-events-none absolute top-1 z-10 max-w-[80%] rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-sm"
        // opens away from the nearer edge, so it never needs measuring
        style={x < g.width / 2 ? { left: x + 12 } : { right: g.width - x + 12 }}
      >
        <p className="text-muted">
          {band
            ? `${band.label}: ${fmtFull(band.from)} to ${fmtFull(band.to)}`
            : fmtFull(p.t)}
        </p>
        {series.map((s, i) => (
          <p
            key={s.key}
            className="whitespace-nowrap"
            style={{ color: COLORS[i % COLORS.length] }}
          >
            {s.label}:{" "}
            <span className="font-medium text-ink">
              {ok(p.v[s.key]) ? fmtNum(p.v[s.key], s.unit) : "no data"}
            </span>
          </p>
        ))}
      </div>
    </>
  );
});

/** Line chart over unix-second points. Drag across it to zoom when `onZoom` is given (HIS-3); arrow keys step the tooltip. */
export function SeriesChart({
  points,
  series,
  height,
  yMax,
  onZoom,
  domain,
  gaps,
  firstSample,
  empty = "No data for this range yet.",
  label,
}: {
  points: Point[];
  series: SeriesDef[];
  /** px or any CSS length; default 13.75rem (grows with the TV root size) */
  height?: number | string;
  yMax?: number;
  onZoom?: (from: number, to: number) => void;
  /** the window that was asked for: the axis covers it even where there's no data */
  domain?: [number, number];
  gaps?: Gap[];
  /** when this server's history starts; earlier time is shaded "Before monitoring started" */
  firstSample?: number | null;
  /** what to say when there are no points at all */
  empty?: string;
  /** accessible name; defaults to the series labels */
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();
  const [size, setSize] = useState<Size | null>(null);
  const has = points.length > 0;
  useEffect(() => {
    const el = wrap.current;
    if (!el || !has) return;
    const ro = new ResizeObserver(() => {
      const rem =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) =>
        s && s.w === w && s.h === h && s.rem === rem ? s : { w, h, rem },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [has]);

  const g = useMemo(
    () =>
      size && size.w > 0 && has
        ? geometry(points, series, size, domain, yMax)
        : null,
    [points, series, size, domain, yMax, has],
  );

  const bands = useMemo<Band[]>(() => {
    const out: Band[] = (gaps ?? []).map((x) => ({
      from: x.from,
      to: x.to,
      label: GAP_LABEL[x.reason],
      kind: x.reason === "off" ? "off" : "gap",
    }));
    if (domain && firstSample && firstSample > domain[0])
      out.unshift({
        from: domain[0],
        to: Math.min(firstSample, domain[1]),
        label: `Before monitoring started (${DAY.format(firstSample * 1000)})`,
        kind: "before",
      });
    return out;
  }, [gaps, domain, firstSample]);

  const [hover, setHover] = useState<{ i: number; kbd: boolean } | null>(null);
  // selection lives in a ref + a tiny overlay; the plot itself is not re-rendered while dragging
  const sel = useRef<{ a: number; ax: number; b?: number } | null>(null);
  const [box, setBox] = useState<{ x1: number; x2: number } | null>(null);
  const zoom = useRef(onZoom);
  useEffect(() => {
    zoom.current = onZoom;
  });

  // pointer → x inside the plot (clamped) and its time
  const at = (e: React.PointerEvent) => {
    if (!g) return null;
    const x = Math.min(
      g.pl + g.pw,
      Math.max(g.pl, e.clientX - wrap.current!.getBoundingClientRect().left),
    );
    return { x, t: g.x0 + ((x - g.pl) / g.pw) * (g.x1 - g.x0) };
  };
  const point = (e: React.PointerEvent) => {
    const p = at(e);
    if (p && g) setHover({ i: nearestIndex(g.ts, p.t), kbd: false });
    return p;
  };
  const end = (commit: boolean) => {
    const s = sel.current;
    sel.current = null;
    setBox(null);
    if (commit && s?.b !== undefined && s.a !== s.b)
      zoom.current?.(Math.min(s.a, s.b), Math.max(s.a, s.b));
  };

  const p = hover && g ? points[hover.i] : undefined;
  const band = p && bands.find((b) => p.t >= b.from && p.t <= b.to);
  const name = label ?? `${series.map((s) => s.label).join(", ")} chart`;

  return (
    <div className="relative" style={{ height: height ?? "13.75rem" }}>
      {!has ? (
        <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
          {empty}
        </div>
      ) : (
        <div
          ref={wrap}
          role="img"
          aria-label={name}
          tabIndex={0}
          className={`absolute inset-0 rounded-sm ${onZoom ? "cursor-crosshair select-none" : ""}`}
          onPointerDown={(e) => {
            const q = point(e);
            // touch keeps scrolling the page; a mouse or pen drag selects a range to zoom into
            if (!q || !onZoom || e.pointerType === "touch" || e.button !== 0)
              return;
            e.currentTarget.setPointerCapture(e.pointerId);
            sel.current = { a: q.t, ax: q.x };
          }}
          onPointerMove={(e) => {
            const q = point(e);
            const s = sel.current;
            if (!q || !s) return;
            if (Math.abs(q.x - s.ax) < 4) return; // a click with a shaky hand is not a zoom
            s.b = q.t;
            setBox({ x1: s.ax, x2: q.x });
          }}
          onPointerUp={() => end(true)}
          onPointerCancel={() => end(false)}
          onPointerLeave={() => {
            if (!sel.current) setHover(null);
          }}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            const n = points.length;
            const i = hover?.i;
            const next =
              e.key === "ArrowRight"
                ? i === undefined
                  ? 0
                  : Math.min(n - 1, i + 1)
                : e.key === "ArrowLeft"
                  ? i === undefined
                    ? n - 1
                    : Math.max(0, i - 1)
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? n - 1
                      : null;
            if (e.key === "Escape") setHover(null);
            if (next === null) return;
            e.preventDefault();
            setHover({ i: next, kbd: true });
          }}
        >
          {g && <Plot g={g} bands={bands} series={series} id={id} />}
          {g && p && <Hover g={g} p={p} series={series} band={band} />}
          {box && (
            <div
              className="pointer-events-none absolute rounded-sm bg-select ring-1 ring-signal"
              style={{
                top: `${PAD.t}rem`,
                bottom: `${PAD.b}rem`,
                left: Math.min(box.x1, box.x2),
                width: Math.abs(box.x2 - box.x1),
              }}
            />
          )}
        </div>
      )}
      {/* keyboard stepping is read out; role="img" hides its children, so this sits beside it */}
      <p className="sr-only" aria-live="polite">
        {hover?.kbd && p
          ? `${band ? band.label + ", " : ""}${fmtFull(p.t)}: ${series.map((s) => `${s.label} ${ok(p.v[s.key]) ? fmtNum(p.v[s.key], s.unit) : "no data"}`).join(", ")}`
          : ""}
      </p>
    </div>
  );
}
