// Shared chart helpers without a chart library, so the Live page never loads Recharts.

export const COLORS = [
  "var(--color-signal)",
  "var(--color-signal-2)",
  "var(--color-signal-3)",
];

export type SeriesDef = { key: string; label: string; unit: string };

// created once: building a formatter per call cost ~24 µs, many times per live update
const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function fmtNum(v: number | null | undefined, unit = "") {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const s =
    abs >= 1000 ? WHOLE.format(v) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

/** Axis labels: short ("100K", "2.5M"), whole numbers once the scale reaches 4. */
export function axisNum(v: number, max: number) {
  if (Math.abs(v) >= 1000) return COMPACT.format(v);
  return max >= 4 ? String(Math.round(v)) : v.toFixed(max >= 1 ? 1 : 2);
}

/** Line styles per series, so lines differ by more than colour (colour-blind users). */
export const DASHES = [undefined, "5 3", "1 3"];

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <svg aria-hidden viewBox="0 0 16 4" className="h-1 w-4">
            <line
              x1="0"
              y1="2"
              x2="16"
              y2="2"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth="2"
              strokeDasharray={DASHES[i % DASHES.length]}
            />
          </svg>
          {s.label}
          {s.unit && ` (${s.unit})`}
        </li>
      ))}
    </ul>
  );
}

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
