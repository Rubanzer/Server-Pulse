"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** One line on the Live page when something failed in the last 24 hours; nothing otherwise. */
export function RecentFailures() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 86_400;
    fetch(`/api/events?since=${since}&limit=1`, { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => r?.counts && setCounts(r.counts))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  const crit = counts?.critical ?? 0;
  const err = counts?.error ?? 0;
  if (!crit && !err) return null;
  const parts = [crit && `${crit} critical`, err && `${err} error${err === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  return (
    <p className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-surface px-4 py-2.5 text-sm ${crit ? "border-crit/50" : "border-warn/50"}`}>
      <span>
        <strong className={`font-medium ${crit ? "text-crit" : "text-warn"}`}>{parts}</strong> on your server in the last 24 hours.
      </span>
      <Link href="/logs#failures" className="rounded-lg border border-line px-3 py-1 hover:border-signal">
        View failures
      </Link>
    </p>
  );
}
