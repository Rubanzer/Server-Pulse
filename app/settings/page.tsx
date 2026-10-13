"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { input } from "@/components/auth-forms";
import { requestBackfill } from "@/components/backfill-runner";
import { LinkForm } from "@/components/link-form";
import { METRICS } from "@/lib/charts";
import { hardNavigate } from "@/lib/navigate";
import type { ServerInfo } from "@/lib/netdata";
import type { Usage } from "@/lib/usage";

type Run = { id: number; kind: string; startedAt: string; finishedAt: string | null; rowsInserted: number | null; status: string | null; error: string | null };
type S = {
  account: string | null;
  demo: boolean;
  link: string | null;
  linkError: string | null;
  linkSource: "settings" | "env" | "account" | null;
  btopUrl: string | null;
  tunnel: string | null;
  canSaveLink: boolean;
  database: boolean;
  mail: boolean;
  cronSecret: boolean;
  viewer: boolean;
  runs: Run[];
  storage: { bytes: number; rows: number; oldest: number | null; limit: number } | null;
  pending: string[];
  usage: Usage | null;
};
type Test = { ok: boolean; ms?: number; error?: string; info?: ServerInfo };

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const TUNNEL: Record<string, string> = { funnel: "Tailscale Funnel", ngrok: "ngrok (budget mode)", other: "Direct / other" };
const btn = "rounded-lg border border-line px-3 py-2 text-sm hover:border-signal disabled:opacity-50";
const primary = "rounded-lg bg-signal px-3 py-2 text-sm font-medium text-on-signal disabled:opacity-50";

function Section({ title, children, desc }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 text-sm text-muted">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, value * 100);
  const cls = value >= 0.8 ? "bg-crit" : value >= 0.6 ? "bg-warn" : "bg-signal";
  return (
    <div>
      <div className="flex justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="font-medium">{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

async function call(url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
    return { ok: r.ok, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, body: { error: (e as Error).message } as Record<string, unknown> };
  }
}

function AccountSection({ email }: { email: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Account" desc={`Signed in as ${email}.`}>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          setBusy(true);
          const r = await call("/api/account", { method: "POST", body: JSON.stringify({ current: fd.get("current"), next: fd.get("next") }) });
          setBusy(false);
          setMsg(r.ok ? { ok: true, text: "Password changed. Other devices are signed out." } : { ok: false, text: String(r.body.error) });
          if (r.ok) form.reset();
        }}
      >
        <label className="block">
          <span className="text-sm font-medium">Current password</span>
          <input name="current" type="password" autoComplete="current-password" required className={input} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">New password</span>
          <input name="next" type="password" autoComplete="new-password" required minLength={10} className={input} />
        </label>
        <button disabled={busy} className={primary}>
          Change password
        </button>
      </form>
      {msg && (
        <p role="status" className={`mt-3 text-sm ${msg.ok ? "text-ok" : "text-crit"}`}>
          {msg.text}
        </p>
      )}
      <details className="mt-5 border-t border-line pt-4">
        <summary className="cursor-pointer text-sm font-medium text-crit">Delete account</summary>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            const password = new FormData(e.currentTarget).get("password");
            if (!confirm("Delete your account and all stored history? This cannot be undone.")) return;
            const r = await call("/api/account", { method: "DELETE", body: JSON.stringify({ password }) });
            if (r.ok) hardNavigate("/signup");
            else setMsg({ ok: false, text: String(r.body.error) });
          }}
        >
          <label className="block flex-1">
            <span className="text-sm text-muted">This removes your server link and all of its history. Enter your password to confirm.</span>
            <input name="password" type="password" autoComplete="current-password" required className={input} />
          </label>
          <button className="rounded-lg border border-crit px-3 py-2 text-sm text-crit hover:bg-crit hover:text-on-signal">Delete account</button>
        </form>
      </details>
    </Section>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then(async (r) => (r.ok ? setS(await r.json()) : setErr(((await r.json()) as { error: string }).error)))
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  if (err) return <p className="text-crit">{err}</p>;
  if (!s) return <div className="h-96 animate-pulse rounded-xl bg-surface" />;

  const connected = !!s.link;
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        {msg && (
          <p role="status" className="mt-2 text-sm">
            {msg}
          </p>
        )}
      </header>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Server link" desc="The dashboard reads your server through this link. The password is stored encrypted and never shown.">
          {s.demo ? (
            <p className="mb-4 text-sm">
              No server connected, so the dashboard shows demo data. Follow the{" "}
              <Link href="/setup" className="text-signal underline">
                server setup guide
              </Link>{" "}
              to get your link.
            </p>
          ) : (
            <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted">Link</dt>
              <dd className="break-all font-mono text-xs leading-5">
                {s.link ?? (s.linkError ? <span className="text-crit">{s.linkError}</span> : <span className="text-muted">Not connected yet</span>)}
              </dd>
              {s.linkSource && (
                <>
                  <dt className="text-muted">Set in</dt>
                  <dd>{s.linkSource === "settings" ? "Settings (overrides SERVER_URL)" : s.linkSource === "env" ? "Vercel env var SERVER_URL" : "Your account"}</dd>
                </>
              )}
              {s.tunnel && (
                <>
                  <dt className="text-muted">Tunnel</dt>
                  <dd>{TUNNEL[s.tunnel]}</dd>
                </>
              )}
            </dl>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={btn}
              disabled={!!busy || !connected}
              onClick={async () => {
                setBusy("test");
                setTest((await call("/api/settings/test", { method: "POST", body: "{}" })).body as Test);
                setBusy(null);
              }}
            >
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            {s.btopUrl && (
              <a className={btn} href={s.btopUrl} target="_blank" rel="noreferrer">
                Open btop
              </a>
            )}
            {s.linkSource === "settings" && (
              <button
                className={btn}
                disabled={!!busy}
                onClick={async () => {
                  await call("/api/settings/link", { method: "DELETE" });
                  setMsg("Now using SERVER_URL from Vercel.");
                  load();
                }}
              >
                Use SERVER_URL instead
              </button>
            )}
          </div>
          {test && (
            <p role="status" className={`mt-3 text-sm ${test.ok ? "text-ok" : "text-crit"}`}>
              {test.ok ? `Connected in ${test.ms} ms: ${test.info?.hostname}, ${test.info?.os}, ${test.info?.netdata ? `version ${test.info.netdata}` : ""}.` : `Connection failed: ${test.error}`}
            </p>
          )}
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-2 text-sm font-medium">{connected ? "Change link" : "Connect a server"}</p>
            {s.canSaveLink ? (
              <LinkForm
                submitLabel={connected ? "Test and save" : "Test and connect"}
                onSaved={() => {
                  setMsg("Link saved. It is used from now on, no redeploy needed.");
                  load();
                }}
              />
            ) : (
              <p className="text-xs text-muted">
                {s.database
                  ? "Set SERVER_URL or DASHBOARD_PASSWORD in Vercel first, so the demo password stops working. Or create an account."
                  : "Connect a Neon database to save the link here."}
              </p>
            )}
          </div>
        </Section>

        <Section title="History sync" desc="Every night at 00:15 UTC the last 26 hours are copied into the database. Rows older than 30 days become hourly averages.">
          <div className="flex flex-wrap gap-2">
            <button
              className={primary}
              disabled={!!busy || !s.database || !connected}
              onClick={async () => {
                setBusy("sync");
                const r = await call("/api/cron/sync", { method: "POST" });
                setBusy(null);
                setMsg(r.body.error ? `Sync ${r.body.status ?? "failed"}: ${r.body.error}` : `Sync finished: ${r.body.rows} new rows.`);
                load();
              }}
            >
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
            <button className={btn} disabled={!s.database || !connected} onClick={() => requestBackfill([...METRICS])}>
              Backfill 30 days
            </button>
          </div>
          {!s.database && <p className="mt-3 text-sm text-warn">No database connected. In Vercel: Storage → Create Database → Neon, then redeploy.</p>}
          {s.pending.length > 0 && s.database && <p className="mt-3 text-sm text-muted">Waiting for first import: {s.pending.join(", ")}.</p>}
          {s.runs.length > 0 && (
            <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-muted">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3 font-medium">Started</th>
                    <th className="py-2 pr-3 font-medium">Job</th>
                    <th className="py-2 pr-3 font-medium">Result</th>
                    <th className="py-2 pr-3 text-right font-medium">New rows</th>
                    <th className="py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {s.runs.map((r) => (
                    <tr key={r.id} className="border-b border-line align-top last:border-0">
                      <td className="whitespace-nowrap py-2 pr-3">{new Date(r.startedAt).toLocaleString()}</td>
                      <td className="py-2 pr-3">{r.kind === "backfill" ? "Backfill" : "Sync"}</td>
                      <td className={`py-2 pr-3 font-medium ${r.status === "ok" ? "text-ok" : r.status ? "text-crit" : "text-muted"}`}>{r.status ?? "running"}</td>
                      <td className="py-2 pr-3 text-right">{r.rowsInserted ?? "—"}</td>
                      <td className="py-2 text-xs text-muted">{r.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Free-tier usage" desc="Everything stays at $0 while these stay under 80%.">
          <div className="space-y-4">
            {s.storage ? (
              <div>
                <Meter value={s.storage.bytes / s.storage.limit} label={`Database storage: ${mb(s.storage.bytes)} of ${mb(s.storage.limit)}`} />
                <p className="mt-1 text-xs text-muted">
                  {s.storage.rows.toLocaleString()} stored readings for this server
                  {s.storage.oldest ? `, oldest from ${new Date(s.storage.oldest * 1000).toLocaleDateString()}` : ""}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">Database not connected.</p>
            )}
            {s.usage ? (
              <div>
                <Meter value={s.usage.pct} label={`ngrok requests: ${s.usage.used.toLocaleString()} of ${s.usage.limit.toLocaleString()}`} />
                <p className="mt-1 text-xs text-muted">
                  Live view pauses at 80% and resumes on {new Date(s.usage.resetsAt).toLocaleDateString()}. Tailscale Funnel has no request limit.
                </p>
              </div>
            ) : (
              s.tunnel && <p className="text-sm text-muted">{TUNNEL[s.tunnel]} has no request quota to track.</p>
            )}
          </div>
        </Section>

        <Section title="Optional features" desc="Turned on by environment variables in Vercel → Settings → Environment Variables.">
          <ul className="space-y-2 text-sm">
            {[
              [s.database, "History database and accounts", "Connect Neon from Vercel Storage."],
              ...(s.account
                ? []
                : [[s.mail, "Email when the server is offline for a day", "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and ALERT_EMAIL_TO."]]),
              ...(s.account ? [] : [[s.viewer, "Read-only viewer password", "Set VIEWER_PASSWORD."]]),
              [s.cronSecret, "Protected nightly job", "Set CRON_SECRET. Without it the job is limited to once per 10 minutes."],
            ].map(([on, label, how]) => (
              <li key={String(label)} className="flex gap-2">
                <span className={on ? "text-ok" : "text-muted"} aria-hidden>
                  {on ? "✓" : "○"}
                </span>
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="sr-only">{on ? " (on)" : " (off)"}</span>
                  {!on && <span className="block text-xs text-muted">{how}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {s.account && <AccountSection email={s.account} />}
    </div>
  );
}
