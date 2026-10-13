"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { RingBuffer } from "@/lib/algo";
import { fmtWindow, TimeRange } from "./time-range";

type Line = { c: string; t: number; p: number; u: string; m: string };
type Failure = {
  id: number;
  ts: number;
  last: number;
  count: number;
  severity: "critical" | "error" | "warning" | "info";
  kind: string;
  source: string;
  message: string;
};
type Conn = "connecting" | "live" | "polling" | "paused" | "reconnecting" | "unsupported";

const MAX_LINES = 2000;
const MAX_RANGE_LINES = 20_000;
const LOG_PRESETS = [
  { key: "live", label: "Live", sec: 0 },
  { key: "15m", label: "15 min", sec: 900 },
  { key: "1h", label: "1 hour", sec: 3600 },
  { key: "6h", label: "6 hours", sec: 6 * 3600 },
  { key: "24h", label: "24 hours", sec: 86400 },
  { key: "7d", label: "7 days", sec: 7 * 86400 },
] as const;
const FAIL_PRESETS = [
  { key: "24h", label: "24 hours", sec: 86400 },
  { key: "7d", label: "7 days", sec: 7 * 86400 },
  { key: "30d", label: "30 days", sec: 30 * 86400 },
  { key: "all", label: "All (180 days)", sec: 0 },
] as const;
/** a time window: preset "live" (logs) / "all" (failures) means open-ended; null preset = custom */
type Win = { preset: string | null; from: number; to: number };
type Jump = { from: number; to: number; unit: string; n: number };
const nowSec = () => Math.floor(Date.now() / 1000);
const UNIT_RE = /^[A-Za-z0-9@:._-]{1,100}$/;
const LEVELS = [
  { key: "all", label: "All", prio: 6 },
  { key: "warn", label: "Warnings+", prio: 4 },
  { key: "err", label: "Errors+", prio: 3 },
] as const;
const PRIO_NAME = ["EMERG", "ALERT", "CRIT", "ERROR", "WARN", "NOTICE", "INFO", "DEBUG"];
const prioClass = (p: number) =>
  p <= 3 ? "bg-crit text-on-signal" : p === 4 ? "bg-warn text-on-signal" : p === 5 ? "bg-signal/20 text-ink" : "bg-paper text-muted";

const SEV_STYLE: Record<Failure["severity"], { cls: string; icon: string; label: string }> = {
  critical: { cls: "bg-crit text-on-signal", icon: "⛔", label: "Critical" },
  error: { cls: "border border-crit text-crit", icon: "✖", label: "Error" },
  warning: { cls: "border border-warn text-warn", icon: "⚠", label: "Warning" },
  info: { cls: "border border-ok text-ok", icon: "✓", label: "Resolved" },
};
const KIND_LABEL: Record<string, string> = {
  log: "Logs",
  service: "Service",
  memory: "Memory",
  disk: "Disk",
  crash: "Crash",
  cpu: "CPU",
  temp: "Temperature",
  offline: "Offline",
  online: "Back online",
  sync: "History sync",
};

export function LogsView() {
  const params = useSearchParams();
  const [tab, setTab] = useState<"live" | "failures">("live");
  useEffect(() => {
    if (location.hash === "#failures") queueMicrotask(() => setTab("failures"));
  }, []);
  // /logs?from=&to=&unit= (from History or a failure) opens that window instead of the live tail
  const [jump, setJump] = useState<Jump | null>(() => {
    const from = Number(params.get("from")) || 0;
    const to = Number(params.get("to")) || 0;
    const unit = params.get("unit") ?? "";
    return from > 0
      ? {
          from,
          to: to > from ? to : 0,
          unit: UNIT_RE.test(unit) ? unit : "",
          n: 0,
        }
      : null;
  });
  const choose = (t: "live" | "failures") => {
    setTab(t);
    history.replaceState(null, "", `${location.pathname}${location.search}${t === "failures" ? "#failures" : ""}`);
  };
  const showLogs = (j: Omit<Jump, "n">) => {
    setJump((p) => ({ ...j, n: (p?.n ?? 0) + 1 }));
    setTab("live");
    history.replaceState(
      null,
      "",
      `${location.pathname}?${new URLSearchParams({ from: String(j.from), to: String(j.to), ...(j.unit ? { unit: j.unit } : {}) })}`,
    );
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted">Your server&apos;s system log, live, and every failure Server Pulse has recorded.</p>
        </div>
        <div role="tablist" aria-label="View" className="flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {(
            [
              ["live", "Live logs"],
              ["failures", "Failures"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => choose(k)}
              className={`rounded-md px-3 py-1.5 ${tab === k ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </header>
      {tab === "live" ? <LiveLogs key={jump?.n ?? 0} start={jump} /> : <Failures jump={jump} onShowLogs={showLogs} />}
    </div>
  );
}

// ---------- live logs ----------

function useLogStream(prio: number, unit: string, paused: boolean, enabled: boolean) {
  const [lines, setLines] = useState<Line[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const [note, setNote] = useState<string | null>(null);
  const [held, setHeld] = useState(0);
  const ring = useRef(new RingBuffer<Line>(MAX_LINES));
  const hold = useRef<Line[]>([]);
  const pausedRef = useRef(paused);

  const publish = useCallback(() => setLines(ring.current.toArray()), []);
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && hold.current.length) {
      for (const l of hold.current) ring.current.push(l);
      hold.current = [];
      setHeld(0);
      publish();
    }
  }, [paused, publish]);

  const clear = useCallback(() => {
    ring.current = new RingBuffer<Line>(MAX_LINES);
    hold.current = [];
    setHeld(0);
    setLines([]);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let pending: Line[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    // new filter: start from an empty view (after this effect, so React batches it with the stream setup)
    queueMicrotask(() => {
      if (stopped) return;
      clear();
      setConn("connecting");
    });

    // batch DOM updates: many lines can arrive at once
    const add = (l: Line) => {
      pending.push(l);
      if (!flushTimer)
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          const batch = pending;
          pending = [];
          if (pausedRef.current) {
            hold.current.push(...batch);
            if (hold.current.length > MAX_LINES) hold.current = hold.current.slice(-MAX_LINES);
            setHeld(hold.current.length);
            return;
          }
          for (const x of batch) ring.current.push(x);
          publish();
        }, 100);
    };
    const qs = new URLSearchParams({ prio: String(prio) });
    if (unit) qs.set("unit", unit);

    async function stream(): Promise<"ended" | "fallback"> {
      const tk = await fetch("/api/logs/token", { cache: "no-store" }).then((r) => r.json());
      if (tk.demo || !tk.url) return "fallback";
      ctrl = new AbortController();
      const res = await fetch(`${tk.url}?${qs}`, {
        headers: {
          authorization: `Bearer ${tk.token}`,
          "ngrok-skip-browser-warning": "1",
        },
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      setConn("live");
      setNote(null);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return "ended";
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const s = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!s) continue;
          const o = JSON.parse(s);
          if (o.error) setNote(o.error);
          else add(o as Line);
        }
      }
    }

    async function poll(cursor: string): Promise<string | null> {
      ctrl = new AbortController();
      const p = new URLSearchParams(qs);
      if (cursor) p.set("after", cursor);
      const res = await fetch(`/api/logs?${p}`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const body = await res.json();
      if (res.status === 404) {
        setConn("unsupported");
        setNote(body.error);
        return null;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setConn("polling");
      if (body.error) setNote(body.error);
      for (const l of body.entries as Line[]) add(l);
      return body.cursor ?? cursor;
    }

    (async () => {
      let useStream = true;
      let fails = 0;
      let cursor = "";
      let backoff = 1000;
      while (!stopped) {
        try {
          if (useStream) {
            const r = await stream();
            if (r === "fallback") useStream = false;
            fails = 0;
            backoff = 1000;
            continue;
          }
          const next = await poll(cursor);
          if (next === null) return;
          cursor = next;
          backoff = 1000;
          await new Promise((r) => setTimeout(r, 3000));
        } catch (e) {
          if (stopped || (e as Error).name === "AbortError") continue;
          if (useStream && ++fails >= 2) {
            useStream = false;
            continue;
          }
          setConn("reconnecting");
          setNote((e as Error).message);
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 500));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
    return () => {
      stopped = true;
      ctrl?.abort();
      clearTimeout(flushTimer);
    };
  }, [prio, unit, clear, publish, enabled]);

  return { lines, conn, note, held, clear };
}

type RangeState = "loading" | "more" | "done" | "error" | "unsupported";

/** A past window of the log, oldest first, 500 lines a page. */
function useLogRange(prio: number, unit: string, from: number, to: number) {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<RangeState>("loading");
  const [note, setNote] = useState<string | null>(null);
  const cursor = useRef("");
  const ctrlRef = useRef<AbortController | null>(null);

  const page = useCallback(
    async (reset: boolean) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const p = new URLSearchParams({
        prio: String(prio),
        since: String(from),
      });
      if (to) p.set("until", String(to));
      if (unit) p.set("unit", unit);
      if (!reset && cursor.current) p.set("after", cursor.current);
      setState("loading");
      try {
        const res = await fetch(`/api/logs?${p}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const body = await res.json();
        if (!res.ok) {
          setState(res.status === 404 ? "unsupported" : "error");
          setNote(body.error ?? `HTTP ${res.status}`);
          return;
        }
        cursor.current = body.cursor ?? cursor.current;
        setLines((prev) => {
          const next = reset ? (body.entries as Line[]) : [...prev, ...(body.entries as Line[])];
          return next.length > MAX_RANGE_LINES ? next.slice(0, MAX_RANGE_LINES) : next;
        });
        setNote(body.error ?? null);
        setState(body.more ? "more" : "done");
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setState("error");
        setNote((e as Error).message);
      }
    },
    [prio, unit, from, to],
  );

  useEffect(() => {
    if (!from) return;
    cursor.current = "";
    queueMicrotask(() => {
      setLines([]);
      void page(true);
    });
    return () => ctrlRef.current?.abort();
  }, [page, from]);

  return { lines, state, note, loadMore: () => void page(false) };
}

function LiveLogs({ start }: { start: Jump | null }) {
  const [level, setLevel] = useState<(typeof LEVELS)[number]["key"]>("all");
  const [unitInput, setUnitInput] = useState(start?.unit ?? "");
  const [unit, setUnit] = useState(start?.unit ?? "");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const [win, setWin] = useState<Win>(() => (start ? { preset: null, from: start.from, to: start.to || nowSec() } : { preset: "live", from: 0, to: 0 }));
  const live = win.preset === "live";
  const prio = LEVELS.find((l) => l.key === level)!.prio;
  const stream = useLogStream(prio, unit, paused, live);
  const range = useLogRange(prio, unit, live ? 0 : win.from, win.to);
  const { held, clear } = stream;
  const lines = live ? stream.lines : range.lines;
  const conn = stream.conn;
  const note = live ? stream.note : range.note;

  // apply the service filter after typing stops (it restarts the stream)
  useEffect(() => {
    const t = setTimeout(() => setUnit(UNIT_RE.test(unitInput.trim()) ? unitInput.trim() : ""), 500);
    return () => clearTimeout(t);
  }, [unitInput]);

  const units = useMemo(() => [...new Set(lines.map((l) => l.u).filter(Boolean))].sort().slice(0, 50), [lines]);
  // typing stays responsive: the filter over up to 20,000 lines runs on the deferred value, after the keystroke paints
  const needle = useDeferredValue(q).trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? lines.filter((l) => l.m.toLowerCase().includes(needle) || l.u.toLowerCase().includes(needle)) : lines),
    [lines, needle],
  );

  // stick to the bottom unless the reader scrolled up
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const prevLen = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const added = Math.max(0, shown.length - prevLen.current);
    prevLen.current = shown.length;
    if (!live) return; // a past window reads top to bottom
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (added) setUnseen((n) => n + added);
  }, [shown, atBottom, live]);
  const onScroll = () => {
    const el = box.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  };
  const jump = () => {
    const el = box.current!;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnseen(0);
  };

  return (
    <section className="space-y-3">
      <TimeRange
        presets={LOG_PRESETS}
        preset={win.preset}
        from={live ? undefined : win.from}
        to={live ? undefined : win.to}
        onPreset={(k) => {
          const p = LOG_PRESETS.find((x) => x.key === k)!;
          const now = nowSec();
          setWin(p.sec ? { preset: k, from: now - p.sec, to: now } : { preset: "live", from: 0, to: 0 });
          setAtBottom(true);
          setUnseen(0);
        }}
        onRange={(from, to) => setWin({ preset: null, from, to })}
      />
      <div className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div role="group" aria-label="Level" className="flex rounded-lg border border-line p-0.5 text-xs">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                aria-pressed={level === l.key}
                onClick={() => setLevel(l.key)}
                className={`rounded-md px-2.5 py-1 ${level === l.key ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <input
            value={unitInput}
            onChange={(e) => setUnitInput(e.target.value)}
            list="log-units"
            placeholder="Service (e.g. nginx.service)"
            aria-label="Filter by service"
            className="w-52 rounded-lg border border-line bg-paper px-2.5 py-1 text-sm"
          />
          <datalist id="log-units">
            {units.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label="Search log lines"
            className="w-40 rounded-lg border border-line bg-paper px-2.5 py-1 text-sm"
          />
          {live ? (
            <div className="ml-auto flex items-center gap-2">
              <ConnBadge conn={conn} paused={paused} />
              <button onClick={() => setPaused((p) => !p)} className="rounded-lg border border-line px-3 py-1 text-sm hover:border-signal">
                {paused ? `Resume${held ? ` (${held})` : ""}` : "Pause"}
              </button>
              <button onClick={clear} className="rounded-lg border border-line px-3 py-1 text-sm hover:border-signal">
                Clear
              </button>
            </div>
          ) : (
            <span className="ml-auto text-xs text-muted" role="status">
              {range.state === "loading"
                ? "Loading…"
                : `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}${range.state === "more" ? " so far" : ""}`}
            </span>
          )}
        </div>
        {note && <p className="border-b border-line bg-paper px-3 py-2 text-sm text-warn">{note}</p>}
        <div className="relative">
          <div
            ref={box}
            onScroll={onScroll}
            className="h-[65vh] overflow-y-auto font-mono text-[12.5px] leading-relaxed"
            role="log"
            aria-live="off"
            aria-label="Server log"
          >
            {shown.length === 0 ? (
              <p className="p-6 text-center font-sans text-sm text-muted">
                {!live
                  ? range.state === "loading"
                    ? "Loading this part of the log…"
                    : range.state === "unsupported" || range.state === "error"
                      ? "Couldn't load this window."
                      : needle
                        ? `No lines match “${q}” here${range.state === "more" ? " yet. Load more to keep looking." : "."}`
                        : `Nothing was logged${unit ? ` by ${unit}` : ""} at this level between ${fmtWindow(win.from, win.to)}.`
                  : conn === "connecting"
                    ? "Connecting to your server's log…"
                    : needle
                      ? `No lines match “${q}”.`
                      : "Waiting for new log lines…"}
              </p>
            ) : (
              shown.map((l) => <LogRow key={l.c} l={l} />)
            )}
            {!live && range.state === "more" && lines.length < MAX_RANGE_LINES && (
              <div className="border-t border-line p-3 text-center font-sans">
                <button onClick={range.loadMore} className="rounded-lg border border-line px-4 py-1.5 text-sm hover:border-signal">
                  Load the next 500 lines
                </button>
              </div>
            )}
          </div>
          {!atBottom && unseen > 0 && (
            <button
              onClick={jump}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-signal px-4 py-1.5 text-sm font-medium text-on-signal shadow-lg"
            >
              {unseen} new line{unseen === 1 ? "" : "s"} · Jump to latest
            </button>
          )}
        </div>
        <p className="border-t border-line px-3 py-2 text-xs text-muted">
          {live
            ? `Showing the last ${MAX_LINES.toLocaleString()} lines.`
            : `${fmtWindow(win.from, win.to)}, oldest first${lines.length >= MAX_RANGE_LINES ? `. Stopped at ${MAX_RANGE_LINES.toLocaleString()} lines: pick a shorter window or a stricter level to see the rest` : ""}.`}{" "}
          Passwords, tokens and keys are removed on the server before lines are sent.
        </p>
      </div>
    </section>
  );
}

// formatters built once: toLocaleTimeString(…, options) builds a new one per call, per row
const TIME_FMT = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat([], { day: "numeric", month: "short" });
const FULL_FMT = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "medium" });
let todayCache = { at: 0, start: 0 };
/** Midnight today, recomputed at most once a minute. */
const todayStart = () => {
  const now = Date.now();
  if (now - todayCache.at > 60_000) todayCache = { at: now, start: new Date(now).setHours(0, 0, 0, 0) };
  return todayCache.start;
};

const LogRow = memo(function LogRow({ l }: { l: Line }) {
  const d = new Date(l.t);
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-2 border-b border-line/50 px-3 py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_22px] hover:bg-paper sm:grid-cols-[auto_auto_12rem_minmax(0,1fr)]">
      <time className="text-muted tabular-nums" dateTime={d.toISOString()} title={FULL_FMT.format(d)}>
        {l.t >= todayStart() ? "" : `${DAY_FMT.format(d)} `}
        {TIME_FMT.format(d)}
      </time>
      <span className={`self-start rounded px-1 text-[10px] font-semibold leading-5 ${prioClass(l.p)}`}>{PRIO_NAME[l.p] ?? l.p}</span>
      <span className="hidden truncate text-signal sm:block" title={l.u}>
        {l.u}
      </span>
      <span className="whitespace-pre-wrap break-words">
        <span className="text-signal sm:hidden">{l.u} </span>
        {l.m}
      </span>
    </div>
  );
});

function ConnBadge({ conn, paused }: { conn: Conn; paused: boolean }) {
  const [label, cls] = paused
    ? ["Paused", "text-muted"]
    : conn === "live"
      ? ["Live", "text-ok"]
      : conn === "polling"
        ? ["Live · via dashboard", "text-ok"]
        : conn === "reconnecting"
          ? ["Reconnecting…", "text-warn"]
          : conn === "unsupported"
            ? ["Agent update needed", "text-warn"]
            : ["Connecting…", "text-muted"];
  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${cls}`} role="status">
      <span className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}

// ---------- failures ----------

const SEV_FILTERS = [
  { key: "", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "critical,error", label: "Errors+" },
  { key: "warning", label: "Warnings" },
] as const;

function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function Failures({ jump, onShowLogs }: { jump: Jump | null; onShowLogs: (j: Omit<Jump, "n">) => void }) {
  const [filter, setFilter] = useState<string>("");
  const [win, setWin] = useState<Win>(() => (jump ? { preset: null, from: jump.from, to: jump.to || nowSec() } : { preset: "all", from: 0, to: 0 }));
  const [events, setEvents] = useState<Failure[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stored, setStored] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [summary, setSummary] = useState<Record<string, number>>({});

  const load = useCallback(
    async (before?: number) => {
      const p = new URLSearchParams({ limit: "50" });
      if (filter) p.set("severity", filter);
      if (before) p.set("before", String(before));
      if (win.from) p.set("since", String(win.from));
      if (win.to) p.set("until", String(win.to));
      const r = await fetch(`/api/events?${p}`, { cache: "no-store" })
        .then((x) => x.json())
        .catch(() => null);
      if (!r?.events) return setNote(r?.error ?? "Couldn't load failures. Check your connection.");
      setNote(r.note ?? null);
      setStored(r.stored !== false);
      setMore(r.events.length === 50);
      if (r.counts) setSummary(r.counts);
      setEvents((prev) => (before ? [...(prev ?? []), ...r.events] : r.events));
    },
    [filter, win],
  );

  useEffect(() => {
    queueMicrotask(() => void load()); // load sets state only after its fetch resolves
    const id = setInterval(() => !document.hidden && void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const winLabel = win.preset ? FAIL_PRESETS.find((p) => p.key === win.preset)!.label.replace("All (180 days)", "180 days") : fmtWindow(win.from, win.to);

  const groups = useMemo(() => {
    const out: { day: string; items: Failure[] }[] = [];
    for (const e of events ?? []) {
      const day = dayLabel(e.ts);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1]!.items.push(e);
    }
    return out;
  }, [events]);

  return (
    <section className="space-y-3">
      <TimeRange
        presets={FAIL_PRESETS}
        preset={win.preset}
        from={win.from || undefined}
        to={win.to || undefined}
        onPreset={(k) => {
          const p = FAIL_PRESETS.find((x) => x.key === k)!;
          const now = nowSec();
          setEvents(null);
          setWin(p.sec ? { preset: k, from: now - p.sec, to: 0 } : { preset: "all", from: 0, to: 0 });
        }}
        onRange={(from, to) => {
          setEvents(null);
          setWin({ preset: null, from, to });
        }}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["critical", "error", "warning", "info"] as const).map((s) => (
          <div key={s} className="rounded-xl border border-line bg-surface p-3">
            <p className="text-xs text-muted">
              {SEV_STYLE[s].label} · {winLabel}
            </p>
            <p
              className={`font-cond text-3xl font-semibold ${summary[s] ? (s === "critical" || s === "error" ? "text-crit" : s === "warning" ? "text-warn" : "text-ok") : ""}`}
            >
              {summary[s] ?? 0}
            </p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-3">
          <div role="group" aria-label="Severity" className="flex rounded-lg border border-line p-0.5 text-xs">
            {SEV_FILTERS.map((f) => (
              <button
                key={f.key}
                aria-pressed={filter === f.key}
                onClick={() => {
                  if (f.key === filter) return;
                  setEvents(null);
                  setFilter(f.key);
                }}
                className={`rounded-md px-2.5 py-1 ${filter === f.key ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{stored ? "Saved for 180 days" : "No database: showing the agent's last 2,000 failures"}</p>
        </div>
        {note && <p className="border-b border-line bg-paper px-3 py-2 text-sm text-warn">{note}</p>}
        {!events ? (
          <div className="m-3 h-40 animate-pulse rounded-lg bg-paper" />
        ) : events.length === 0 ? (
          <div className="p-8 text-center">
            <p className="font-medium">
              No failures recorded{filter ? " for this filter" : ""}
              {win.preset === "all" ? "" : ` in ${win.preset ? `the last ${winLabel}` : winLabel}`}.
            </p>
            <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted">
              Server Pulse watches your server&apos;s logs and vitals around the clock. Crashes, failed services, out-of-memory kills, disk errors and long CPU,
              memory, disk or temperature spikes will show up here.
            </p>
          </div>
        ) : (
          <ol>
            {groups.map((g) => (
              <li key={g.day}>
                <h3 className="border-b border-line bg-paper px-3 py-1.5 text-xs font-semibold text-muted">{g.day}</h3>
                <ol>
                  {g.items.map((e) => (
                    <FailureRow key={e.id} e={e} onShowLogs={onShowLogs} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
        {more && (
          <div className="border-t border-line p-3 text-center">
            <button
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await load(events?.[events.length - 1]?.id);
                setLoadingMore(false);
              }}
              className="rounded-lg border border-line px-4 py-1.5 text-sm hover:border-signal disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const FailureRow = memo(function FailureRow({ e, onShowLogs }: { e: Failure; onShowLogs: (j: Omit<Jump, "n">) => void }) {
  const [open, setOpen] = useState(false);
  const s = SEV_STYLE[e.severity] ?? SEV_STYLE.error;
  const t = new Date(e.ts * 1000);
  return (
    <li className="border-b border-line last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 px-3 py-2.5 text-left hover:bg-paper"
      >
        <span className={`mt-0.5 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold ${s.cls}`}>
          <span aria-hidden>{s.icon}</span>
          {s.label}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}</span>
            {e.source && e.source !== "dashboard" && e.source !== "server-pulse" && <span className="truncate font-mono text-xs text-signal">{e.source}</span>}
            <span className="text-xs text-muted tabular-nums">{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            {e.count > 1 && (
              <span className="rounded bg-paper px-1.5 text-xs text-muted" title={`Last at ${new Date(e.last * 1000).toLocaleString()}`}>
                ×{e.count}
              </span>
            )}
          </span>
          {/* one failure can carry several lines (the program's errors, then systemd's verdict): headline first */}
          <span className={`mt-0.5 block font-mono text-xs text-ink/80 ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}>
            {open ? e.message : e.message.split("\n")[0]}
          </span>
          {!open && e.message.includes("\n") && (
            <span className="mt-0.5 block text-xs text-muted">
              +{e.message.split("\n").length - 1} more line{e.message.split("\n").length > 2 ? "s" : ""}
            </span>
          )}
          {open && e.count > 1 && (
            <span className="mt-1 block text-xs text-muted">
              Repeated {e.count} times, last at {new Date(e.last * 1000).toLocaleString()}.
            </span>
          )}
        </span>
      </button>
      {open && (
        // what was happening around it: the log lines and the vitals, same window
        <div className="flex flex-wrap gap-2 px-3 pb-3 pl-[5.5rem] text-sm max-sm:pl-3">
          <button
            onClick={() =>
              onShowLogs({
                from: e.ts - 300,
                to: Math.min(nowSec(), e.last + 300),
                unit: logUnit(e.source),
              })
            }
            className="rounded-lg border border-line px-3 py-1 hover:border-signal"
          >
            Logs around this time
            {logUnit(e.source) ? ` (${logUnit(e.source)})` : ""}
          </button>
          <Link
            href={`/history?from=${e.ts - 1800}&to=${Math.min(nowSec(), e.last + 1800)}`}
            className="rounded-lg border border-line px-3 py-1 hover:border-signal"
          >
            CPU, memory and disk at the time
          </Link>
        </div>
      )}
    </li>
  );
});

/** The journal filter for a failure's source; empty for things the dashboard or the sampler noticed. */
function logUnit(source: string) {
  return source && source !== "dashboard" && source !== "server-pulse" && UNIT_RE.test(source) ? source : "";
}
