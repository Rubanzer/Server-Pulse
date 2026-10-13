"use client";

import { useEffect, useRef, useState } from "react";

export const CATCH_UP_EVENT = "sp:catch-up";

/** Start copying missing history now, from anywhere (Settings button). */
export const requestCatchUp = () => window.dispatchEvent(new Event(CATCH_UP_EVENT));

const CHECKED_KEY = "sp-catch-up-checked";
const CHECK_EVERY_MS = 10 * 60_000;

/**
 * HIS-2: when the dashboard is behind the server (first connection, or after the internet, tunnel or
 * dashboard was down), copy the missing history in budgeted steps while the owner has a page open,
 * instead of waiting for the nightly sync. Checks at most every 10 minutes per tab.
 */
export function BackfillRunner() {
  const [state, setState] = useState<{ syncedTo: number | null; done: boolean; error?: string } | null>(null);
  const running = useRef(false);

  useEffect(() => {
    async function run() {
      if (running.current) return;
      running.current = true;
      setState({ syncedTo: null, done: false });
      for (let step = 0; step < 30; step++) {
        const r = await fetch("/api/backfill", { method: "POST" }).catch(() => null);
        const body = r
          ? ((await r.json().catch(() => ({}))) as { pending?: boolean; syncedTo?: number | null; errors?: string[]; error?: string })
          : { error: "network error" };
        if (!r?.ok || body.error) {
          setState({ syncedTo: null, done: true, error: body.error ?? `HTTP ${r?.status}` });
          break;
        }
        setState({ syncedTo: body.syncedTo ?? null, done: !body.pending, error: body.errors?.[0] });
        if (!body.pending) break;
      }
      running.current = false;
      setTimeout(() => setState((s) => (s?.error ? s : null)), 5000);
    }

    window.addEventListener(CATCH_UP_EVENT, run);
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(CHECKED_KEY)) < CHECK_EVERY_MS;
      sessionStorage.setItem(CHECKED_KEY, String(Date.now()));
    } catch {}
    if (!recent)
      fetch("/api/backfill")
        .then((r) => (r.ok ? (r.json() as Promise<{ pending: boolean }>) : { pending: false }))
        .then((d) => {
          if (d.pending) void run();
        })
        .catch(() => {});
    return () => window.removeEventListener(CATCH_UP_EVENT, run);
  }, []);

  if (!state) return null;
  const upTo = state.syncedTo
    ? new Date(state.syncedTo * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm rounded-xl border border-line bg-surface p-4 text-sm shadow-lg sm:left-auto sm:right-6"
    >
      <p className="font-medium">
        {state.error ? "Couldn't copy all missing history" : state.done ? "History is up to date" : "Copying missing history from your server"}
      </p>
      <p className="mt-1 text-xs text-muted">
        {state.error ?? (upTo ? `Copied up to ${upTo}.` : "Finding what's missing…")} {state.error ? "The nightly sync tries again." : ""}
      </p>
      {state.error && (
        <button className="mt-2 text-xs text-muted underline" onClick={() => setState(null)}>
          Dismiss
        </button>
      )}
    </div>
  );
}
