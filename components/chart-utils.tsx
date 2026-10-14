// Shared chart helpers without a chart library, so the Live page never loads Recharts.

export const COLORS = ["var(--color-signal)", "var(--color-signal-2)", "var(--color-signal-3)"];

export type SeriesDef = { key: string; label: string; unit: string };

export function fmtNum(v: number | null | undefined, unit = "") {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const s = abs >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: COLORS[i % COLORS.length] }} />
          {s.label}
          {s.unit && ` (${s.unit})`}
        </li>
      ))}
    </ul>
  );
}

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
