"use client";

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { monotonePath, nearestIndex, niceCeil } from "@/lib/algo";
import type { Point } from "@/lib/charts";
import {
  axisNum,
  COLORS,
  DASHES,
  fmtNum,
  reducedMotion,
  type SeriesDef,
} from "./chart-utils";

type Props = {
  points: Point[];
  series: SeriesDef[];
  /** Visible window in seconds. */
  windowSec: number;
  /** Height in CSS px at the normal root size (16 px); it grows with the root size on big screens. */
  height: number;
  /** Fixed y maximum (e.g. 100 for %); otherwise a "nice" maximum that eases between values. */
  yMax?: number;
  /** Sparkline mode: no axes, no tooltip. */
  compact?: boolean;
  className?: string;
};

const PAD = { l: 44, r: 8, t: 8, b: 20 }; // at 16 px root; scaled with it
const AHEAD = 30; // seconds the line is drawn past its newest point (it holds its last value)
const HM = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const HMS = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const FADE =
  "linear-gradient(to right, transparent, #000 2.25rem, #000 calc(100% - 2.25rem), transparent)";

/**
 * Continuously scrolling live chart.
 *  - The scroll is a CSS transform animated by the browser's compositor (Web Animations), so it keeps
 *    moving at the display's own rate (60, 120, 144 Hz…) even while the page is busy: no JavaScript runs
 *    per frame. React renders only when a new reading arrives (once a second).
 *  - Zero added latency: the newest reading is drawn the moment it arrives and the line holds its last
 *    value out to "now", so motion is continuous without buffering a sample.
 *  - Curves are monotone cubic (no overshoot); the y scale eases instead of jumping.
 *  - Sizes follow the root font size, so on a TV (bigger root) the chart and its labels grow too.
 */
function LiveChartImpl({
  points,
  series,
  windowSec,
  height,
  yMax,
  compact,
  className = "",
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const slides = useRef<(HTMLDivElement | null)[]>([]);
  const lines = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, k: 1 });
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const k =
        parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 ||
        1;
      setBox({
        w: Math.round(e!.contentRect.width),
        h: Math.round(e!.contentRect.height),
        k,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { k } = box;
  const pad = compact
    ? { l: 0, r: 0, t: 2, b: 2 }
    : { l: PAD.l * k, r: PAD.r * k, t: PAD.t * k, b: PAD.b * k };
  const w = Math.max(0, box.w - pad.l - pad.r);
  const h = Math.max(0, box.h - pad.t - pad.b);

  const last = points[points.length - 1];
  // time anchor: the client moment the newest point arrived ↔ its server timestamp
  const anchor = useRef({ t: 0, at: 0 });
  useLayoutEffect(() => {
    if (last && anchor.current.t !== last.t)
      anchor.current = { t: last.t, at: performance.now() };
  }, [last]);

  const dataMax = useMemo(() => {
    let m = 0;
    for (const p of points)
      for (const s of series) m = Math.max(m, p.v[s.key] ?? 0);
    return m;
  }, [points, series]);
  const target = yMax ?? niceCeil(dataMax * 1.1);

  // geometry in "data time": x = 0 is the newest point, negative is older; the slide moves it left
  const geo = useMemo(() => {
    if (!w || !h || !last) return null;
    const pxPerSec = w / windowSec;
    const ts = points.map((p) => p.t);
    const xs = ts.map((t) => (t - last.t) * pxPerSec);
    const ahead = (AHEAD * pxPerSec).toFixed(1);
    const paths = series.map((s) => {
      const ys = points.map((p) => h - ((p.v[s.key] ?? 0) / target) * h);
      const lastY = (ys[ys.length - 1] ?? h).toFixed(2);
      const d = `${monotonePath(xs, ys)}L${ahead},${lastY}`;
      return {
        d,
        area: `${d}L${ahead},${h}L${(-windowSec * 2 * pxPerSec).toFixed(1)},${h}Z`,
      };
    });
    return { pxPerSec, ts, paths };
  }, [points, series, w, h, windowSec, target, last]);

  // the scroll: one compositor animation per reading, from "just arrived" to 30 s later
  useLayoutEffect(() => {
    if (!geo || reducedMotion()) return;
    const run = slides.current.filter((el): el is HTMLDivElement => !!el);
    const shift = -AHEAD * geo.pxPerSec;
    const anims = run.map((el) =>
      el.animate(
        [
          { transform: "translateX(0)" },
          { transform: `translateX(${shift}px)` },
        ],
        { duration: AHEAD * 1000, easing: "linear", fill: "forwards" },
      ),
    );
    return () => anims.forEach((a) => a.cancel());
  }, [geo]);

  // a new y maximum: start from how the old scale looked and ease to the new one (compositor too)
  const prevTarget = useRef(target);
  useLayoutEffect(() => {
    const from = prevTarget.current;
    prevTarget.current = target;
    if (!lines.current || from === target || !from || reducedMotion()) return;
    lines.current.animate(
      [{ transform: `scaleY(${target / from})` }, { transform: "scaleY(1)" }],
      { duration: 350, easing: "ease-out" },
    );
  }, [target]);

  // x-axis labels on whole minutes, in the same data-time frame so they scroll with the line; keyed by
  // time, so a label's text node is only created once
  const minuteTicks = useMemo(() => {
    if (compact || !geo || !last) return [];
    const out: { t: number; x: number; label: string }[] = [];
    // whole minutes, spaced so labels never crowd on narrow screens (≥ 72 px apart at the root size)
    const step = 60 * Math.max(1, Math.ceil((72 * k) / (geo.pxPerSec * 60)));
    const first = Math.ceil((last.t - windowSec) / step) * step;
    for (let t = first; t <= last.t + step; t += step)
      out.push({
        t,
        x: (t - last.t) * geo.pxPerSec,
        label: HM.format(t * 1000),
      });
    return out;
  }, [compact, geo, last, windowSec, k]);

  const onMove = (e: React.PointerEvent) => {
    if (compact || !geo || !last) return;
    const r = wrap.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const elapsed = (performance.now() - anchor.current.at) / 1000;
    const t = last.t + elapsed - (pad.l + w - x) / geo.pxPerSec;
    setHover({ x, i: nearestIndex(geo.ts, t) });
  };
  const hp = hover && hover.i >= 0 ? points[hover.i] : null;
  const font = { fontSize: "0.6875rem" };
  const aheadPx = geo ? AHEAD * geo.pxPerSec : 0;

  return (
    <div
      ref={wrap}
      className={`relative min-w-0 select-none ${className}`}
      style={{ height: `${height / 16}rem` }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      {box.w > 0 && (
        <>
          {!compact && (
            <svg
              width={box.w}
              height={box.h}
              className="absolute inset-0 block"
              aria-hidden
            >
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line
                    x1={pad.l}
                    x2={pad.l + w}
                    y1={pad.t + h * (1 - f)}
                    y2={pad.t + h * (1 - f)}
                    stroke="var(--color-line)"
                  />
                  <text
                    x={pad.l - 6 * k}
                    y={pad.t + h * (1 - f) + 3.5 * k}
                    textAnchor="end"
                    style={font}
                    fill="var(--color-muted)"
                  >
                    {axisNum(target * f, target)}
                  </text>
                </g>
              ))}
            </svg>
          )}
          {/* the moving layer: clipped to the plot, slid by the compositor */}
          <div
            className="absolute overflow-hidden"
            style={{ left: pad.l, top: 0, width: w, height: box.h }}
            aria-hidden
          >
            <div
              ref={(el) => void (slides.current[0] = el)}
              className="absolute inset-y-0 left-0 will-change-transform"
              style={{ width: w + aheadPx }}
            >
              <svg
                ref={lines}
                width={w + aheadPx}
                height={box.h}
                className="block overflow-visible"
                style={{ transformOrigin: `0 ${pad.t + h}px` }}
              >
                <g transform={`translate(${w},${pad.t})`}>
                  {geo?.paths.map((p, i) => (
                    <g
                      key={series[i]!.key}
                      style={{
                        color: compact ? undefined : COLORS[i % COLORS.length],
                      }}
                    >
                      <path
                        d={p.d}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={compact ? 1.5 : 1.75}
                        strokeDasharray={
                          compact ? undefined : DASHES[i % DASHES.length]
                        }
                        strokeLinejoin="round"
                      />
                      {(compact || series.length === 1) && (
                        <path d={p.area} fill="currentColor" opacity={0.1} />
                      )}
                    </g>
                  ))}
                </g>
              </svg>
            </div>
          </div>
          {!compact && (
            // time labels fade out at the plot edges instead of being sliced mid-word as they scroll
            <div
              className="pointer-events-none absolute overflow-hidden"
              style={{
                left: pad.l,
                top: 0,
                width: w,
                height: box.h,
                maskImage: FADE,
                WebkitMaskImage: FADE,
              }}
              aria-hidden
            >
              <div
                ref={(el) => void (slides.current[1] = el)}
                className="absolute inset-y-0 left-0 will-change-transform"
                style={{ width: w + aheadPx }}
              >
                <svg
                  width={w + aheadPx}
                  height={box.h}
                  className="block overflow-visible"
                >
                  {minuteTicks.map((m) => (
                    <text
                      key={m.t}
                      x={w + m.x}
                      y={box.h - 4 * k}
                      textAnchor="middle"
                      style={font}
                      fill="var(--color-muted)"
                    >
                      {m.label}
                    </text>
                  ))}
                </svg>
              </div>
            </div>
          )}
        </>
      )}
      {hp && hover && (
        <>
          <div
            className="pointer-events-none absolute bottom-5 top-2 w-px bg-line"
            style={{ left: hover.x }}
          />
          <div
            className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm"
            style={{ left: Math.min(hover.x + 8, box.w - 150 * k) }}
          >
            <p className="text-muted">{HMS.format(hp.t * 1000)}</p>
            {series.map((s, i) => (
              <p key={s.key} style={{ color: COLORS[i % COLORS.length] }}>
                {s.label}:{" "}
                <span className="font-medium text-ink">
                  {fmtNum(hp.v[s.key], s.unit)}
                </span>
              </p>
            ))}
          </div>
        </>
      )}
      {/* screen readers: the latest reading and the 5-minute peak, as text (not a live region) */}
      {!compact && last && (
        <p className="sr-only">
          {series
            .map((s) => {
              let peak = 0;
              for (const p of points) peak = Math.max(peak, p.v[s.key] ?? 0);
              return `${s.label} now ${fmtNum(last.v[s.key], s.unit)}, peak ${fmtNum(peak, s.unit)}`;
            })
            .join("; ")}
        </p>
      )}
    </div>
  );
}

export const LiveChart = memo(LiveChartImpl);
