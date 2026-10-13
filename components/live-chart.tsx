"use client";

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { monotonePath, nearestIndex, niceCeil } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import { COLORS, fmtNum, reducedMotion, type SeriesDef } from "./chart-utils";

type Props = {
  points: Point[];
  series: SeriesDef[];
  /** Visible window in seconds. */
  windowSec: number;
  height: number;
  /** Fixed y maximum (e.g. 100 for %); otherwise a "nice" maximum that eases between values. */
  yMax?: number;
  /** Sparkline mode: no axes, no tooltip. */
  compact?: boolean;
  className?: string;
};

const PAD = { l: 44, r: 8, t: 8, b: 20 };

/**
 * Continuously scrolling live chart.
 *  - React renders only when data changes; every animation frame just updates one `transform`
 *    (compositor work, no layout), so it runs at the display's own rate (60, 120, 144 Hz…) without
 *    re-rendering anything; motion is time-based, so it moves at the same speed on every screen.
 *  - Zero added latency: the newest reading is drawn the moment it arrives and the line holds
 *    its last value out to "now", so motion is continuous without buffering a sample.
 *  - Curves are monotone cubic (no overshoot); the y scale eases instead of jumping.
 */
function LiveChartImpl({ points, series, windowSec, height, yMax, compact, className = "" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const plot = useRef<SVGGElement>(null);
  const ticks = useRef<SVGGElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);

  const pad = compact ? { l: 0, r: 0, t: 2, b: 2 } : PAD;
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clipId = useId();
  const last = points[points.length - 1];
  // time anchor: the client moment the newest point arrived ↔ its server timestamp
  const anchor = useRef({ t: 0, at: 0 });
  useLayoutEffect(() => {
    if (last && anchor.current.t !== last.t) anchor.current = { t: last.t, at: performance.now() };
  }, [last]);

  const dataMax = useMemo(() => {
    let m = 0;
    for (const p of points) for (const s of series) m = Math.max(m, p.v[s.key] ?? 0);
    return m;
  }, [points, series]);
  const target = yMax ?? niceCeil(dataMax * 1.1);

  // geometry is built in "data time" relative to the anchor; frames only translate/scale it
  const geo = useMemo(() => {
    if (!w || !last) return null;
    const pxPerSec = w / windowSec;
    const ts = points.map((p) => p.t);
    const xs = ts.map((t) => (t - last.t) * pxPerSec); // 0 = newest point, negative = older
    const paths = series.map((s) => {
      const ys = points.map((p) => h - ((p.v[s.key] ?? 0) / target) * h);
      return { d: monotonePath(xs, ys), lastY: ys[ys.length - 1] ?? h };
    });
    return { pxPerSec, ts, paths, builtMax: target };
  }, [points, series, w, h, windowSec, target, last]);

  // per-frame: slide left by the time elapsed since the newest point arrived; ease the y scale
  const yNow = useRef(target);
  useLayoutEffect(() => {
    if (!geo) return;
    let raf = 0;
    let lastPx = NaN;
    const still = reducedMotion();
    const dpr = window.devicePixelRatio || 1;
    const frame = () => {
      const elapsed = Math.min((performance.now() - anchor.current.at) / 1000, 30);
      const shift = still ? 0 : elapsed * geo.pxPerSec;
      const settled = Math.abs(target - yNow.current) < target * 1e-3;
      yNow.current = settled ? target : yNow.current + (target - yNow.current) * (still ? 1 : 0.15);
      // an SVG transform repaints the whole chart: write it only when the line has moved a whole device
      // pixel (a few times a second, not 120×), so big and high-refresh screens stay smooth
      const px = Math.round(shift * dpr);
      if (px !== lastPx || !settled) {
        lastPx = px;
        const sy = geo.builtMax / yNow.current;
        const x = pad.l + w - px / dpr;
        plot.current?.setAttribute("transform", `translate(${x},${pad.t + h * (1 - sy)}) scale(1,${sy})`);
        ticks.current?.setAttribute("transform", `translate(${x},0)`);
      }
      raf = still ? 0 : requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [geo, target, w, h, pad.l, pad.t]);

  // x-axis labels on whole minutes, positioned in the same data-time frame so they scroll with the line
  const minuteTicks = useMemo(() => {
    if (compact || !geo || !last) return [];
    const out: { x: number; label: string }[] = [];
    // whole minutes, spaced so labels never crowd on narrow screens (≥ 72 px apart)
    const step = 60 * Math.max(1, Math.ceil(72 / (geo.pxPerSec * 60)));
    const first = Math.ceil((last.t - windowSec) / step) * step;
    for (let t = first; t <= last.t + step; t += step)
      out.push({ x: (t - last.t) * geo.pxPerSec, label: new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    return out;
  }, [compact, geo, last, windowSec]);

  const onMove = (e: React.PointerEvent) => {
    if (compact || !geo || !last) return;
    const r = wrap.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const elapsed = (performance.now() - anchor.current.at) / 1000;
    const t = last.t + elapsed - (pad.l + w - x) / geo.pxPerSec;
    setHover({ x, i: nearestIndex(geo.ts, t) });
  };
  const hp = hover && hover.i >= 0 ? points[hover.i] : null;

  return (
    <div
      ref={wrap}
      className={`relative min-w-0 select-none ${className}`}
      style={{ height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="absolute inset-0 block overflow-hidden" aria-hidden>
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.l} y={0} width={w} height={height} />
            </clipPath>
            {/* time labels fade out at the plot edges instead of being sliced mid-word as they scroll */}
            <linearGradient id={`${clipId}g`} x1={pad.l} x2={pad.l + w} y1={0} y2={0} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff" stopOpacity={0} />
              <stop offset={Math.min(0.49, 36 / Math.max(w, 1))} stopColor="#fff" stopOpacity={1} />
              <stop offset={Math.max(0.51, 1 - 36 / Math.max(w, 1))} stopColor="#fff" stopOpacity={1} />
              <stop offset="1" stopColor="#fff" stopOpacity={0} />
            </linearGradient>
            <mask id={`${clipId}m`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <rect x={pad.l} y={0} width={w} height={height} fill={`url(#${clipId}g)`} />
            </mask>
          </defs>
          {!compact &&
            [0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={pad.l} x2={pad.l + w} y1={pad.t + h * (1 - f)} y2={pad.t + h * (1 - f)} stroke="var(--color-line)" />
                <text x={pad.l - 6} y={pad.t + h * (1 - f) + 3.5} textAnchor="end" fontSize="11" fill="var(--color-muted)">
                  {fmtNum(target * f)}
                </text>
              </g>
            ))}
          <g clipPath={`url(#${clipId})`}>
            <g ref={plot}>
              {geo?.paths.map((p, i) => (
                <g key={series[i]!.key} style={{ color: compact ? undefined : COLORS[i % COLORS.length] }}>
                  {/* hold the latest value out to "now" so the tip never lags or leaves a gap */}
                  <path
                    d={`${p.d}L${(geo.pxPerSec * 30).toFixed(1)},${p.lastY.toFixed(2)}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={compact ? 1.5 : 1.75}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {(compact || series.length === 1) && (
                    <path d={`${p.d}L${(geo.pxPerSec * 30).toFixed(1)},${p.lastY.toFixed(2)}L${(geo.pxPerSec * 30).toFixed(1)},${h}L${(-windowSec * 2 * geo.pxPerSec).toFixed(1)},${h}Z`} fill="currentColor" opacity={0.1} />
                  )}
                </g>
              ))}
            </g>
            {!compact && (
              <g mask={`url(#${clipId}m)`}>
              <g ref={ticks}>
                {minuteTicks.map((k) => (
                  <text key={k.x} x={k.x} y={height - 4} textAnchor="middle" fontSize="11" fill="var(--color-muted)">
                    {k.label}
                  </text>
                ))}
              </g>
              </g>
            )}
          </g>
        </svg>
      )}
      {hp && hover && (
        <>
          <div className="pointer-events-none absolute bottom-5 top-2 w-px bg-line" style={{ left: hover.x }} />
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm"
            style={{ left: Math.min(hover.x + 8, width - 150) }}
          >
            <p className="text-muted">{new Date(hp.t * 1000).toLocaleTimeString()}</p>
            {series.map((s, i) => (
              <p key={s.key} style={{ color: COLORS[i % COLORS.length] }}>
                {s.label}: <span className="font-medium text-ink">{fmtNum(hp.v[s.key], s.unit)}</span>
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export const LiveChart = memo(LiveChartImpl);
