"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * A live number written straight into the DOM once per update: no React re-render of the tile and no
 * per-frame tween. (The old 250 ms ease wrote ~15 frames per update, each forcing a full-page layout:
 * measured 50-70 ms frames on a 4x-slower CPU such as a TV.) Tabular figures keep the width steady.
 */
export function AnimatedNumber({
  value,
  digits = 0,
  className,
}: {
  value: number | undefined;
  digits?: number;
  className?: string;
}) {
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (el.current)
      el.current.textContent =
        value === undefined || !Number.isFinite(value)
          ? "—"
          : value.toFixed(digits);
  }, [value, digits]);
  return <span ref={el} className={className} />;
}
