"use client";

import { useEffect, useRef, useState } from "react";
import { mergeFrame, type PulseFrame } from "@/lib/pulse";

/**
 * Live frames straight from the agent (1 per second, one long gzip request) instead of a dashboard
 * request every 2 s: no Vercel invocation and no ngrok request per reading. `streaming` is false while
 * it can't connect (Netdata server, older agent, ngrok's browser warning); callers keep polling then.
 * Closes after 30 s in a background tab and reconnects when the tab is visible again.
 */
export function useAgentStream(enabled: boolean, onFrame: (f: PulseFrame) => void) {
  const [streaming, setStreaming] = useState(false);
  const cb = useRef(onFrame);
  useEffect(() => {
    cb.current = onFrame;
  });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let last: PulseFrame | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });

    async function once() {
      const tk = await fetch("/api/pulse/token", { cache: "no-store" }).then((r) => r.json());
      if (!tk.url) throw new Error("no stream");
      ctrl = new AbortController();
      const res = await fetch(tk.url, { headers: { authorization: `Bearer ${tk.token}`, "ngrok-skip-browser-warning": "1" }, cache: "no-store", signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setStreaming(true);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return; // sessions end after 15 min: reconnect with a fresh token
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          last = mergeFrame(last, JSON.parse(line) as PulseFrame);
          cb.current(last);
        }
      }
    }

    (async () => {
      let fails = 0;
      while (!stopped) {
        if (document.hidden) {
          await sleep(60_000);
          continue;
        }
        try {
          await once();
          fails = 0;
        } catch (e) {
          if (stopped) return;
          setStreaming(false);
          if ((e as Error).name !== "AbortError") fails++;
          // can't stream: polling carries on; try again now and then (the tunnel may come back)
          await sleep(fails >= 2 ? 5 * 60_000 : 2000);
        }
      }
    })();

    const onVisible = () => {
      clearTimeout(hiddenTimer);
      if (document.hidden) hiddenTimer = setTimeout(() => ctrl?.abort(), 30_000);
      else wake?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      ctrl?.abort();
      clearTimeout(hiddenTimer);
      wake?.();
      document.removeEventListener("visibilitychange", onVisible);
      setStreaming(false);
    };
  }, [enabled]);

  return streaming;
}
