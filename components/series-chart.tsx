"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Point } from "@/lib/charts";
import { COLORS, fmtNum, type SeriesDef } from "./chart-utils";

export { fmtNum, Legend } from "./chart-utils";

function fmtTime(t: number, span: number) {
  const d = new Date(t * 1000);
  if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (span <= 120 * 86400) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

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
}: {
  rows: Record<string, number>[];
  series: SeriesDef[];
  span: number;
  yMax?: number;
  handlers?: Handlers;
}) {
  const unit = series[0]?.unit ?? "";
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
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t: number) => fmtTime(t, span)}
          minTickGap={48}
          tickLine={false}
          axisLine={false}
        />
        <YAxis width={52} domain={[0, yMax ?? "auto"]} tickFormatter={(v: number) => fmtNum(v)} tickLine={false} axisLine={false} allowDecimals />
        <Tooltip
          isAnimationActive={false}
          contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()}
          formatter={(v, name) => {
            const s = series.find((x) => x.key === name);
            return [fmtNum(Number(v), s?.unit ?? unit), s?.label ?? String(name)];
          }}
        />
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
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
}: {
  points: Point[];
  series: SeriesDef[];
  height?: number;
  yMax?: number;
  onZoom?: (from: number, to: number) => void;
}) {
  const rows = useMemo(() => points.map((p) => ({ t: p.t, ...p.v })), [points]);
  const span = points.length > 1 ? points[points.length - 1]!.t - points[0]!.t : 3600;

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
      <div style={{ height }} className="grid place-items-center text-sm text-muted">
        No data for this range yet.
      </div>
    );

  return (
    <div style={{ height }} className={`relative ${onZoom ? "cursor-crosshair select-none" : ""}`}>
      <Chart rows={rows} series={series} span={span} yMax={yMax} handlers={onZoom ? handlers : undefined} />
      {box && (
        <div
          className="pointer-events-none absolute bottom-7 top-2 rounded-sm bg-signal/15 ring-1 ring-signal/40"
          style={{ left: Math.min(box.x1, box.x2), width: Math.abs(box.x2 - box.x1) }}
        />
      )}
    </div>
  );
}
