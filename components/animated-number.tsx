"use client";

import { useLayoutEffect, useRef } from "react";
import { reducedMotion } from "./chart-utils";

/**
 * Number that eases to each new value (250 ms) by writing textContent directly from requestAnimationFrame:
 * no React re-render per frame, no layout thrash (tabular figures keep the width steady).
 */
export function AnimatedNumber({ value, digits = 0, className }: { value: number | undefined; digits?: number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const fmt = (v: number) => v.toFixed(digits);
    if (value === undefined || !Number.isFinite(value)) {
      node.textContent = "—";
      shown.current = undefined;
      return;
    }
    const from = shown.current;
    if (from === undefined || reducedMotion()) {
      node.textContent = fmt(value);
      shown.current = value;
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 250);
      const v = from + (value - from) * (1 - (1 - k) ** 3); // ease-out cubic
      node.textContent = fmt(v);
      shown.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, digits]);

  return <span ref={el} className={className} />;
}
