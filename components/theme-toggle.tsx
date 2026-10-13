"use client";

import { useSyncExternalStore } from "react";

type Mode = "system" | "light" | "dark" | "black";
const KEY = "sp-theme";
const ORDER: Mode[] = ["light", "dark", "black", "system"];
const LABEL: Record<Mode, string> = { system: "Auto (follow this device)", light: "Light", dark: "Dark", black: "Black (true black for OLED and TV screens)" };

/** Runs in <head> before paint so the page never flashes the wrong theme. Keep in sync with apply(). */
export const THEME_SCRIPT = `(()=>{try{var m=localStorage.getItem("${KEY}")||"system";var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=m==="black"?"black":d?"dark":"light";document.documentElement.dataset.mode=m}catch(e){}})()`;

const listeners = new Set<() => void>();

function read(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "black" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(m: Mode) {
  const dark = m === "dark" || (m === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = m === "black" ? "black" : dark ? "dark" : "light";
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

/** Switch with a short cross-fade (one GPU-composited snapshot), or instantly when motion is reduced. */
function choose(m: Mode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {}
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    apply(m);
    listeners.forEach((l) => l());
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    doc.startViewTransition(go);
    // the transition runs its update on the next rendered frame; if none comes (background tab, busy
    // device), switch anyway so the theme never lags a click behind
    setTimeout(go, 150);
  } else go();
}

const ICON: Record<Mode, React.ReactNode> = {
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  // a filled moon: the darkest option
  black: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />,
  system: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
};

/** Light / Dark / Black / Auto, all visible: the current choice is always clear and one tap away. */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, read, () => "system" as Mode);
  return (
    <div role="radiogroup" aria-label="Theme" className="flex items-center rounded-lg border border-line p-0.5">
      {ORDER.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          aria-label={LABEL[m]}
          title={LABEL[m]}
          onClick={() => choose(m)}
          className={`grid size-7 place-items-center rounded-md transition-colors ${mode === m ? "bg-signal text-on-signal" : "text-muted hover:bg-paper hover:text-ink"}`}
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            {ICON[m]}
          </svg>
        </button>
      ))}
    </div>
  );
}
