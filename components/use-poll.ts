"use client";

import { useEffect, useRef, useState } from "react";
import { hardNavigate } from "@/lib/navigate";

/**
 * LIV-3: polls `url` every `intervalMs`, only while the tab is visible; refetches immediately on focus.
 * Fixed-rate: the next request is due `interval` after the previous one *started* (minus its duration),
 * so slow responses don't add up into stale data, and requests never overlap. `initial` renders
 * cached data instantly (e.g. when navigating back to the page).
 */
export function usePoll<T>(
  url: string,
  intervalMs: number,
  opts: { nextInterval?: (data: T) => number; onData?: (data: T) => void; initial?: T | null } = {},
) {
  const [data, setData] = useState<T | null>(opts.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const cbs = useRef(opts);
  useEffect(() => {
    cbs.current = opts;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;
    let stopped = false;
    let wait = intervalMs;

    async function tick() {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      ctrl?.abort();
      ctrl = new AbortController();
      const started = performance.now();
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 401) {
          hardNavigate("/login"); // session expired
          return;
        }
        const body = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        cbs.current.onData?.(body);
        setData(body);
        setError(null);
        wait = cbs.current.nextInterval?.(body) ?? intervalMs;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError((e as Error).message);
        wait = Math.min(wait * 2, 30_000); // back off while the app itself is unreachable
      }
      if (!stopped && !document.hidden) timer = setTimeout(tick, Math.max(0, wait - (performance.now() - started)));
    }

    const onVisible = () => {
      if (document.hidden) {
        clearTimeout(timer);
        ctrl?.abort();
      } else tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs]);

  return { data, error };
}
