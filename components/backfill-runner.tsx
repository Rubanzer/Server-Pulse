"use client";

import { useEffect, useRef, useState } from "react";
import { DEFS, type Metric } from "@/lib/charts";

export const BACKFILL_EVENT = "sp:backfill";

/** Start a backfill for these metrics from anywhere (Settings button). */
export const requestBackfill = (metrics: Metric[]) => window.dispatchEvent(new CustomEvent(BACKFILL_EVENT, { detail: metrics }));

/**
 * HIS-2: runs the 30-day import one metric per request, in sequence, with progress.
 * Starts on its own for the owner when metrics are still pending.
 */
export function BackfillRunner() {
  const [state, setState] = useState<{ done: number; total: number; current?: Metric; errors: string[] } | null>(null);
  const running = useRef(false);

  useEffect(() => {
    async function run(metrics: Metric[]) {
      if (running.current || !metrics.length) return;
      running.current = true;
      const errors: string[] = [];
      for (let i = 0; i < metrics.length; i++) {
        const m = metrics[i]!;
        setState({ done: i, total: metrics.length, current: m, errors: [...errors] });
        const r = await fetch(`/api/backfill?chart=${m}`, { method: "POST" }).catch(() => null);
        if (!r?.ok) errors.push(`${DEFS[m].label}: ${r ? (((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status) : "network error"}`);
      }
      setState({ done: metrics.length, total: metrics.length, errors });
      running.current = false;
      if (!errors.length) setTimeout(() => setState(null), 4000);
    }

    const onEvent = (e: Event) => run((e as CustomEvent<Metric[]>).detail);
    window.addEventListener(BACKFILL_EVENT, onEvent);
    fetch("/api/backfill")
      .then((r) => (r.ok ? (r.json() as Promise<{ pending: Metric[] }>) : { pending: [] }))
      .then((d) => run(d.pending))
      .catch(() => {});
    return () => window.removeEventListener(BACKFILL_EVENT, onEvent);
  }, []);

  if (!state) return null;
  const finished = state.done === state.total;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm rounded-xl border border-line bg-surface p-4 text-sm shadow-lg sm:left-auto sm:right-6">
      <p className="font-medium">
        {finished ? (state.errors.length ? "History import finished with errors" : "30 days of history imported") : `Importing 30 days of history: ${DEFS[state.current!].label}`}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper">
        <div className="h-full bg-signal transition-[width]" style={{ width: `${(100 * state.done) / state.total}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {state.done} of {state.total} charts
      </p>
      {state.errors.map((e) => (
        <p key={e} className="mt-1 text-xs text-crit">
          {e}
        </p>
      ))}
      {finished && state.errors.length > 0 && (
        <button className="mt-2 text-xs text-muted underline" onClick={() => setState(null)}>
          Dismiss
        </button>
      )}
    </div>
  );
}
