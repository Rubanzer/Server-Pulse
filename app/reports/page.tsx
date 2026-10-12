"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtNum } from "@/components/chart-utils";
import type { MonthRow } from "@/lib/reports";

type Res = { source: string; months: MonthRow[] } | { error: string };

export default function ReportsPage() {
  const [res, setRes] = useState<Res | null>(null);
  useEffect(() => {
    fetch("/api/reports")
      .then((r) => r.json() as Promise<Res>)
      .then(setRes)
      .catch((e: Error) => setRes({ error: e.message }));
  }, []);

  const monthEnd = (m: number) => {
    const d = new Date(m * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  };
  const cols: [string, (r: MonthRow) => string][] = [
    ["CPU avg", (r) => fmtNum(r.cpuAvg, "%")],
    ["CPU peak", (r) => fmtNum(r.cpuPeak, "%")],
    ["RAM avg", (r) => fmtNum(r.ramAvg, "%")],
    ["RAM peak", (r) => fmtNum(r.ramPeak, "%")],
    ["Load avg", (r) => fmtNum(r.loadAvg)],
    ["Load peak", (r) => fmtNum(r.loadPeak)],
    ["Net in", (r) => fmtNum(r.netInGB, "GB")],
    ["Net out", (r) => fmtNum(r.netOutGB, "GB")],
    ["Disk peak", (r) => fmtNum(r.diskPeak, "%")],
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Monthly report</h1>
        <p className="text-sm text-muted">Averages and peaks for the last 12 months. Open a month to see it in History.</p>
      </header>
      {!res ? (
        <div className="h-64 animate-pulse rounded-xl bg-surface" />
      ) : "error" in res ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm">{res.error}</p>
      ) : !res.months.length ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm">
          No history yet. The first nightly sync, or <Link className="text-signal underline" href="/settings">Backfill in Settings</Link>, fills this in.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2.5 font-medium">Month</th>
                {cols.map(([h]) => (
                  <th key={h} scope="col" className="px-3 py-2.5 text-right font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {res.months.map((r) => (
                <tr key={r.month} className="border-b border-line last:border-0 hover:bg-paper">
                  <th scope="row" className="px-4 py-2.5 text-left font-medium">
                    <Link className="text-signal hover:underline" href={`/history?from=${r.month}&to=${monthEnd(r.month)}`}>
                      {new Date(r.month * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}
                    </Link>
                  </th>
                  {cols.map(([h, f]) => (
                    <td key={h} className="px-3 py-2.5 text-right">{f(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res && "source" in res && res.source === "demo" && <p className="text-xs text-muted">Generated demo data.</p>}
    </div>
  );
}
