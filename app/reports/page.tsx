"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtNum } from "@/components/chart-utils";
import type { MonthRow } from "@/lib/reports";

type Res = { source: string; months: MonthRow[] } | { error: string };

export default function ReportsPage() {
  const [res, setRes] = useState<Res | null>(null);
  const [now] = useState(() => Date.now() / 1000);
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
  const monitored =
    "months" in (res ?? {})
      ? (res as { months: MonthRow[] }).months.some(
          (r) => r.state === "monitored",
        )
      : false;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Monthly report
        </h1>
        <p className="text-sm text-muted">
          Averages and peaks for the last 12 months, counted only over the time
          your server was measured (see Coverage). Open a month to see it in
          History.
        </p>
      </header>
      {!res ? (
        <div className="h-64 animate-pulse rounded-xl bg-surface" />
      ) : "error" in res ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm">
          {res.error}
        </p>
      ) : !monitored ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm">
          No history yet. It fills in by itself while the dashboard is open, or
          press{" "}
          <Link className="text-signal underline" href="/settings">
            Fill missing history in Settings
          </Link>
          .
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          {/* numbers never wrap away from their units; the month column stays put while the table scrolls */}
          <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th
                  scope="col"
                  className="sticky left-0 z-10 bg-surface px-4 py-2.5 font-medium"
                >
                  Month
                </th>
                {cols.map(([h]) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2.5 text-right font-medium"
                  >
                    {h}
                  </th>
                ))}
                <th
                  scope="col"
                  className="px-3 py-2.5 text-right font-medium"
                  title="Share of the month (so far) your server was measured"
                >
                  Coverage
                </th>
              </tr>
            </thead>
            <tbody>
              {res.months.map((r) => {
                const name = new Date(r.month * 1000).toLocaleDateString(
                  undefined,
                  { month: "long", year: "numeric", timeZone: "UTC" },
                );
                const current = monthEnd(r.month) > now;
                return r.state !== "monitored" ? (
                  <tr
                    key={r.month}
                    className="border-b border-line text-muted last:border-0"
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-left font-normal"
                    >
                      {name}
                    </th>
                    <td
                      colSpan={cols.length + 1}
                      className="px-3 py-2.5 text-right"
                    >
                      {r.state === "before"
                        ? "Before monitoring started"
                        : "Not monitored (server off or not reachable)"}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={r.month}
                    className="border-b border-line last:border-0 hover:bg-paper"
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-left font-medium"
                    >
                      <Link
                        className="text-signal hover:underline"
                        href={`/history?from=${r.startedAt ?? r.month}&to=${Math.min(monthEnd(r.month), Math.floor(now))}`}
                      >
                        {name}
                      </Link>
                      {(current || r.startedAt) && (
                        <span className="block text-xs font-normal text-muted">
                          {current ? "so far" : ""}
                          {current && r.startedAt ? ", " : ""}
                          {r.startedAt
                            ? `from ${new Date(r.startedAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                            : ""}
                        </span>
                      )}
                    </th>
                    {cols.map(([h, f]) => (
                      <td key={h} className="px-3 py-2.5 text-right">
                        {f(r)}
                      </td>
                    ))}
                    <td
                      className={`px-3 py-2.5 text-right ${r.coverage !== null && r.coverage < 0.9 ? "text-warn" : "text-muted"}`}
                    >
                      {r.coverage === null
                        ? "–"
                        : `${Math.round(r.coverage * 100)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {res && "source" in res && res.source === "demo" && (
        <p className="text-xs text-muted">Generated demo data.</p>
      )}
    </div>
  );
}
