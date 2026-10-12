"use client";

import { useSyncExternalStore } from "react";

type Mode = "system" | "light" | "dark";
const KEY = "sp-theme";
const ORDER: Mode[] = ["system", "light", "dark"];
const LABEL: Record<Mode, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

/** Runs in <head> before paint so the page never flashes the wrong theme. Keep in sync with apply(). */
export const THEME_SCRIPT = `(()=>{try{var m=localStorage.getItem("${KEY}")||"system";var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";document.documentElement.dataset.mode=m}catch(e){}})()`;

const listeners = new Set<() => void>();

function read(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(m: Mode) {
  const dark = m === "dark" || (m === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.mode = m;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => read() === "system" && apply("system");
  mq.addEventListener("change", onSystem);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", onSystem);
  };
}

export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, read, () => "system" as Mode);
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!;
  return (
    <button
      type="button"
      onClick={() => {
        try {
          localStorage.setItem(KEY, next);
        } catch {}
        apply(next);
        listeners.forEach((l) => l());
      }}
      className="grid size-9 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
      aria-label={`${LABEL[mode]}. Switch to ${LABEL[next].toLowerCase()}`}
      title={LABEL[mode]}
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        {mode === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : mode === "dark" ? (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        ) : (
          <>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </>
        )}
      </svg>
    </button>
  );
}
