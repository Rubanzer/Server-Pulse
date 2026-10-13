"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Gap, GapReason } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import { COLORS, fmtNum, type SeriesDef } from "./chart-utils";

export { fmtNum, Legend } from "./chart-utils";

function fmtTime(t: number, span: number) {
  const d = new Date(t * 1000);
  if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (span <= 120 * 86400) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "numeric" }); // "Oct 2026", not "Oct 26" (a day?)
}

export const GAP_LABEL: Record<GapReason, string> = {
  off: "Server off",
  agent: "Agent stopped",
  pending: "Filling from server…",
  nodata: "No data",
};

/** Evenly spaced axis ticks over the requested window (Recharts picks too few on a fixed time domain). */
const evenTicks = ([a, b]: [number, number], n = 6) => Array.from({ length: n }, (_, i) => Math.round(a + ((b - a) * i) / (n - 1)));
/** Axis labels stay short: 13,249,355 → 13M, so they never get cut off. */
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const axisNum = (v: number) => (Math.abs(v) >= 10_000 ? compact.format(v) : fmtNum(v));

/** Shaded stretches: a gap (with its reason) or the time before monitoring started. */
type Band = { from: number; to: number; label: string; kind: "gap" | "before" };

// Recharts 3 mouse state: the hovered x value and its pixel position inside the chart
type Ev = { activeLabel?: number | string; activeCoordinate?: { x: number } } | null;
type Handlers = { down: (e: Ev) => void; move: (e: Ev) => void; up: () => void };

/** The expensive part. Memoized with stable handlers, so drag-selection updates never re-render it. */
const Chart = memo(function Chart({
  rows,
  series,
  span,
  yMax,
  handlers,
  domain,
  bands,
}: {
  rows: Record<string, number>[];
  series: SeriesDef[];
  span: number;
  yMax?: number;
  handlers?: Handlers;
  domain?: [number, number];
  bands: Band[];
}) {
  const unit = series[0]?.unit ?? "";
  const width = domain ? domain[1] - domain[0] : span;
  return (
    <ResponsiveContainer width="100%" height="100%" debounce={50}>
      <LineChart
        data={rows}
        margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
        onMouseDown={handlers ? (e) => handlers.down(e as Ev) : undefined}
        onMouseMove={handlers ? (e) => handlers.move(e as Ev) : undefined}
        onMouseUp={handlers?.up}
        onMouseLeave={handlers?.up}
      >
        <defs>
          <pattern id="sp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-muted)" strokeWidth="1" strokeOpacity="0.35" />
          </pattern>
        </defs>
        <CartesianGrid vertical={false} />
        {bands.map((b) => (
          <ReferenceArea
            key={`${b.kind}${b.from}`}
            x1={b.from}
            x2={b.to}
            ifOverflow="hidden"
            fill={b.kind === "gap" ? "url(#sp-hatch)" : "var(--color-paper)"}
            fillOpacity={b.kind === "gap" ? 1 : 0.8}
            stroke="none"
            // a label only where it fits; narrow bands still show the hatch and the reason on hover below
            label={(b.to - b.from) / width > 0.12 ? { value: b.label, position: "insideTop", fontSize: 11, fill: "var(--color-muted)" } : undefined}
          />
        ))}
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain ?? ["dataMin", "dataMax"]}
          ticks={domain ? evenTicks(domain) : undefined}
          allowDataOverflow
          tickFormatter={(t: number) => fmtTime(t, span)}
          minTickGap={48}
          tickLine={false}
          axisLine={false}
        />
        <YAxis width={52} domain={[0, yMax ?? "auto"]} tickFormatter={axisNum} tickLine={false} axisLine={false} allowDecimals />
        <Tooltip
          isAnimationActive={false}
          contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => {
            const at = Number(t);
            const band = bands.find((b) => at >= b.from && at <= b.to);
            const when = new Date(at * 1000).toLocaleString();
            return band ? `${band.label}: ${new Date(band.from * 1000).toLocaleString()} to ${new Date(band.to * 1000).toLocaleString()}` : when;
          }}
          formatter={(v, name) => {
            const s = series.find((x) => x.key === name);
            return [v == null ? "no data" : fmtNum(Number(v), s?.unit ?? unit), s?.label ?? String(name)];
          }}
        />
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="linear" // monotone curves overshoot next to gaps; straight segments never invent values
            dataKey={s.key}
            name={s.key}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={1.6}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
});

/** Line chart over unix-second points. Drag across it to zoom when `onZoom` is given (HIS-3). */
export function SeriesChart({
  points,
  series,
  height = 220,
  yMax,
  onZoom,
  domain,
  gaps,
  firstSample,
  empty = "No data for this range yet.",
}: {
  points: Point[];
  series: SeriesDef[];
  height?: number;
  yMax?: number;
  onZoom?: (from: number, to: number) => void;
  /** the window that was asked for: the axis covers it even where there's no data */
  domain?: [number, number];
  gaps?: Gap[];
  /** when this server's history starts; earlier time is shaded "Before monitoring started" */
  firstSample?: number | null;
  /** what to say when there are no points at all */
  empty?: string;
}) {
  const rows = useMemo(() => points.map((p) => ({ t: p.t, ...p.v })), [points]);
  const span = domain ? domain[1] - domain[0] : points.length > 1 ? points[points.length - 1]!.t - points[0]!.t : 3600;
  const bands = useMemo<Band[]>(() => {
    const out: Band[] = (gaps ?? []).map((g) => ({ from: g.from, to: g.to, label: GAP_LABEL[g.reason], kind: "gap" }));
    if (domain && firstSample && firstSample > domain[0])
      out.unshift({
        from: domain[0],
        to: Math.min(firstSample, domain[1]),
        label: `Before monitoring started (${new Date(firstSample * 1000).toLocaleDateString([], { day: "numeric", month: "short" })})`,
        kind: "before",
      });
    return out;
  }, [gaps, domain, firstSample]);

  // selection lives in a ref + a tiny overlay; the chart itself is not re-rendered while dragging
  const sel = useRef<{ a: number; ax: number; b?: number } | null>(null);
  const [box, setBox] = useState<{ x1: number; x2: number } | null>(null);
  const zoom = useRef(onZoom);
  useEffect(() => {
    zoom.current = onZoom;
  });
  const handlers = useMemo<Handlers>(
    () => ({
      down: (e) => {
        const x = e?.activeCoordinate?.x;
        if (e?.activeLabel === undefined || x === undefined) return;
        sel.current = { a: Number(e.activeLabel), ax: x };
      },
      move: (e) => {
        const s = sel.current;
        const x = e?.activeCoordinate?.x;
        if (!s || e?.activeLabel === undefined || x === undefined) return;
        s.b = Number(e.activeLabel);
        setBox({ x1: s.ax, x2: x });
      },
      up: () => {
        const s = sel.current;
        sel.current = null;
        setBox(null);
        if (s?.b !== undefined && s.a !== s.b) zoom.current?.(Math.min(s.a, s.b), Math.max(s.a, s.b));
      },
    }),
    [],
  );
  if (!points.length)
    return (
      <div style={{ height }} className="grid place-items-center px-6 text-center text-sm text-muted">
        {empty}
      </div>
    );

  return (
    <div style={{ height }} className={`relative ${onZoom ? "cursor-crosshair select-none" : ""}`}>
      <Chart rows={rows} series={series} span={span} yMax={yMax} handlers={onZoom ? handlers : undefined} domain={domain} bands={bands} />
      {box && (
        <div
          className="pointer-events-none absolute bottom-7 top-2 rounded-sm bg-signal/15 ring-1 ring-signal/40"
          style={{ left: Math.min(box.x1, box.x2), width: Math.abs(box.x2 - box.x1) }}
        />
      )}
    </div>
  );
}
