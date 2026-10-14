"use client";

import { useState } from "react";

// One "From … to …" control for every page that looks back in time (History, Logs, Failures), so a
// window picked in one place reads the same everywhere and can be carried between pages in the URL.

export type Preset = { key: string; label: string; sec: number };

/** `datetime-local` value ⇄ unix seconds, in the viewer's time zone. */
export const toLocalInput = (t: number) => {
  const d = new Date(t * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);

export const fmtWindow = (from: number, to: number) => {
  const f = new Date(from * 1000);
  const t = new Date(to * 1000);
  const sameDay = f.toDateString() === t.toDateString();
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  return sameDay
    ? `${f.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${f.toLocaleTimeString([], time)} to ${t.toLocaleTimeString([], time)}`
    : `${f.toLocaleString([], { day: "numeric", month: "short", ...time })} to ${t.toLocaleString([], { day: "numeric", month: "short", ...time })}`;
};

export function TimeRange({
  presets,
  preset,
  from,
  to,
  onPreset,
  onRange,
}: {
  presets: readonly Preset[];
  /** the active preset, or null for a custom window */
  preset: string | null;
  /** the window shown in the From/To fields (defaults to the last hour) */
  from?: number;
  to?: number;
  onPreset: (key: string) => void;
  onRange: (from: number, to: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Math.floor(Date.now() / 60_000) * 60); // default window when none is picked
  const f = from ?? now - 3600;
  const t = to ?? now;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Time range" className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => {
              setError(null);
              onPreset(p.key);
            }}
            aria-pressed={preset === p.key}
            className={`rounded-md px-2.5 py-1 text-sm ${preset === p.key ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const a = fromLocalInput(String(fd.get("from")));
          const b = fromLocalInput(String(fd.get("to")));
          if (!(a > 0) || !(b > 0)) return setError("Pick both a start and an end.");
          if (a >= b) return setError("The end must be after the start.");
          setError(null);
          onRange(a, b);
        }}
        key={`${f}-${t}`}
      >
        <label className="flex items-center gap-1.5">
          <span className="text-muted">From</span>
          <input
            name="from"
            type="datetime-local"
            defaultValue={toLocalInput(f)}
            max={toLocalInput(now + 60)}
            className="rounded-md border border-line bg-surface px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted">to</span>
          <input name="to" type="datetime-local" defaultValue={toLocalInput(t)} className="rounded-md border border-line bg-surface px-2 py-1" />
        </label>
        <button className="rounded-md border border-line bg-surface px-3 py-1 hover:border-signal">Show</button>
        {error && (
          <span role="alert" className="text-crit">
            {error}
          </span>
        )}
      </form>
    </div>
  );
}
