"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { hardNavigate, toLogin } from "@/lib/navigate";
import { CodeBlock } from "./code-block";
import { LinkForm } from "./link-form";

type Pairing = { code: string; command: string; expiresAt: string };
type Step = "waiting" | "approve" | "paired" | "data";

/**
 * Add a server in one paste: a one-time install command (10 minutes, single use) and a checklist that
 * follows the agent as it installs, connects and starts sending data. No links or passwords to copy.
 */
export function AddServer({ database }: { database: boolean }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("waiting");
  const [host, setHost] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [request, setRequest] = useState<{
    hostname?: string;
    host?: string;
    version?: string;
  } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [left, setLeft] = useState(600);
  const started = useRef(false);
  // stable, so it runs once when the approve card appears (not on every countdown tick)
  const focusOnMount = useCallback(
    (el: HTMLButtonElement | null) => el?.focus(),
    [],
  );

  const newCode = useCallback(async () => {
    setError(null);
    setAgentError(null);
    setStep("waiting");
    setRequest(null);
    setRejected(false);
    const r = await fetch("/api/agent/pair-code", { method: "POST" }).catch(
      () => null,
    );
    const body = r ? await r.json().catch(() => ({})) : {};
    if (r?.status === 401) return toLogin();
    if (r?.status === 403) return setError("signup"); // demo login with a database: an account is needed first
    if (!r?.ok)
      return setError(
        body.error ??
          "Couldn't create an install command. Check your connection and try again.",
      );
    setPairing(body as Pairing);
  }, []);

  useEffect(() => {
    if (!database || started.current) return;
    started.current = true;
    void newCode();
  }, [database, newCode]);

  // follow the agent: paired → first live data → open the server view
  useEffect(() => {
    if (!pairing) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const secs = Math.max(
        0,
        Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000),
      );
      setLeft(secs);
      if (secs === 0 && step === "waiting") return; // the code expired: stop asking (each check is a database query)
      if (step === "waiting") {
        const s = await fetch(
          `/api/agent/pair-status?code=${encodeURIComponent(pairing.code)}`,
          { cache: "no-store" },
        )
          .then((r) => r.json())
          .catch(() => null);
        if (s?.status === "pending") {
          // a server redeemed the code: the owner confirms it's theirs before anything is saved
          setRequest({
            hostname: s.hostname,
            host: s.host,
            version: s.version,
          });
          setStep("approve");
          return;
        } else if (s?.status === "paired") {
          setHost(s.hostname ?? null);
          setStep("paired");
        } else if (s?.status === "error") {
          setAgentError(s.error);
        } else if (s?.status === "rejected" || s?.status === "expired") {
          return;
        }
      } else if (step === "approve") {
        return; // waiting for the owner's click
      } else if (step === "paired") {
        const live = await fetch("/api/live", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null);
        if (live?.mode === "live") {
          setStep("data");
          setTimeout(() => hardNavigate("/server"), 1200);
          return;
        }
        // connected but not answering: say so instead of spinning forever
        if (live?.mode === "offline" || live?.mode === "error")
          setAgentError(`Connected, but no live data yet: ${live.error ?? "the server isn't answering"}. Settings → Test connection shows the exact problem.`);
        else setAgentError(null);
      }
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [pairing, step]);

  if (!database)
    return (
      <section className="rounded-xl border border-warn-line bg-surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Finish setup first</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">
          This dashboard needs its database before it can add servers. It takes
          about a minute in Vercel:
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>
            Open your project on vercel.com → <b>Storage</b> →{" "}
            <b>Create Database</b> → <b>Neon</b> (free) → connect it to this
            project.
          </li>
          <li>
            <b>Deployments</b> → ⋯ on the latest one → <b>Redeploy</b>.
          </li>
          <li>Come back here. The install command will be waiting.</li>
        </ol>
      </section>
    );

  async function decide(approve: boolean) {
    if (!pairing) return;
    setDeciding(true);
    const r = await fetch("/api/agent/pair-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, approve }),
    }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    setDeciding(false);
    if (!r?.ok)
      return setAgentError(
        body.error ?? "Couldn't save your answer. Try again.",
      );
    if (approve) {
      setHost(request?.hostname ?? request?.host ?? null);
      setStep("paired");
    } else {
      // the used code can't connect anything any more: hand over a fresh one straight away
      await newCode();
      setRejected(true);
    }
  }

  const expired = left === 0 && step === "waiting";
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold">
            Paste this into your server&apos;s terminal
          </h2>
          <p className="mt-1 text-sm text-muted">
            Ubuntu 22.04 or 24.04. It installs the agent, connects it to this
            dashboard and keeps it running 24/7.
          </p>
        </div>
        {error === "signup" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm">
            <span>Create a free account first. Then this page gives you the install command.</span>
            <Link href="/signup" className="rounded-lg bg-signal px-3 py-1.5 font-medium text-on-signal">
              Create account
            </Link>
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-crit">
            {error}
          </p>
        ) : !pairing ? (
          <div className="h-14 animate-pulse rounded-lg bg-paper" />
        ) : expired ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm">
            <span className="text-muted">
              This command expired. If your server is still waiting, press
              Ctrl+C there, then run the new command.
            </span>
            <button
              onClick={newCode}
              className="rounded-lg bg-signal px-3 py-1.5 font-medium text-on-signal"
            >
              Get a new command
            </button>
          </div>
        ) : (
          <>
            <CodeBlock code={pairing.command} label="Install command" />
            <p className="text-xs text-muted">
              Expires in {mm}. Works once. The code in it is safe to show: it
              expires by itself and can&apos;t be reused.
            </p>
            {step === "waiting" && left <= 540 && !agentError && (
              <p className="text-xs text-muted">
                Nothing yet? Look at your server&apos;s terminal: it may be
                showing a Tailscale link to open.
              </p>
            )}
          </>
        )}

        {step === "approve" && request && (
          <div
            className="space-y-3 rounded-lg border-2 border-signal p-4"
            role="group"
            aria-labelledby="approve-title"
          >
            {/* the Approve button takes focus when this appears, so keyboard and screen-reader users land on it */}
            <p id="approve-title" className="font-medium">
              Is this your server?
            </p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Name</dt>
              <dd className="font-medium">{request.hostname ?? "unknown"}</dd>
              <dt className="text-muted">Address</dt>
              <dd className="break-all font-mono text-xs leading-5">
                {request.host ?? "unknown"}
              </dd>
              {request.version && (
                <>
                  <dt className="text-muted">Agent</dt>
                  <dd>{request.version}</dd>
                </>
              )}
            </dl>
            <p className="text-xs text-muted">
              Only approve if you just ran the command on this server. If you
              don&apos;t recognise it, reject it: someone else used your code.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                ref={focusOnMount}
                onClick={() => decide(true)}
                disabled={deciding}
                className="rounded-lg bg-signal px-4 py-2 text-sm font-medium text-on-signal disabled:opacity-50"
              >
                Approve and connect
              </button>
              <button
                onClick={() => decide(false)}
                disabled={deciding}
                className="rounded-lg border border-line px-4 py-2 text-sm hover:border-crit hover:text-crit"
              >
                Reject
              </button>
            </div>
          </div>
        )}
        {rejected && (
          <p className="text-sm text-muted">
            Rejected. Nothing was saved. Here is a new command if you want to
            try again.
          </p>
        )}

        <ol className="space-y-2 text-sm" aria-live="polite">
          <Check
            done={step === "paired" || step === "data"}
            active={(step === "waiting" || step === "approve") && !expired}
            label={
              step === "waiting"
                ? "Waiting for your server…"
                : step === "approve"
                  ? "Waiting for your approval"
                  : `Connected${host ? `: ${host}` : ""}`
            }
          />
          <Check
            done={step === "data"}
            active={step === "paired"}
            label={
              step === "data"
                ? "Receiving live data. Opening your server…"
                : "Receiving live data"
            }
          />
        </ol>
        {agentError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-crit-line p-3 text-sm text-crit"
          >
            <p className="min-w-0 flex-1">
              {agentError}{" "}
              <span className="text-muted">
                Your server keeps trying by itself. If this stays, get a new
                command and run it again.
              </span>
            </p>
            <button
              onClick={newCode}
              className="rounded-lg border border-line px-3 py-1.5 font-medium text-ink hover:border-signal"
            >
              Get a new command
            </button>
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">
            The first time: what you&apos;ll see
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>
              It shows a <b>Tailscale login link</b>. Open it, sign in with
              Google, Microsoft or GitHub (free) and approve the server. That
              gives it a private HTTPS address; no router ports are opened.
            </li>
            <li>
              If it says Tailscale needs <b>Funnel</b> allowed: open the link it
              shows, press <b>Allow</b>, then run the command again (get a new
              one here if the timer ran out).
            </li>
            <li>
              When it says &ldquo;Done&rdquo;, approve the server here; then
              this page moves on by itself.
            </li>
            <li>
              Already use <b>ngrok</b>? Point ngrok at{" "}
              <code className="font-mono">127.0.0.1:19998</code> (without{" "}
              <code className="font-mono">--basic-auth</code>) and add your
              ngrok address at the end of the command:{" "}
              <code className="font-mono break-all">
                … {pairing?.code ?? "CODE"} https://your-name.ngrok-free.dev
              </code>
            </li>
          </ul>
        </details>
      </section>

      <details className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <summary className="cursor-pointer font-medium">
          Connect manually (advanced)
        </summary>
        <p className="mb-4 mt-1 text-sm text-muted">
          If the agent is already installed, enter its address and password.
        </p>
        <LinkForm onSaved={() => hardNavigate("/server")} />
      </details>
    </div>
  );
}

function Check({
  done,
  active,
  label,
}: {
  done: boolean;
  active: boolean;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={`grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] ${done ? "bg-ok text-on-signal" : active ? "border-2 border-signal" : "border border-line"}`}
      >
        {done ? (
          "✓"
        ) : active ? (
          <span className="size-1.5 animate-ping rounded-full bg-signal [animation-iteration-count:3]" />
        ) : (
          ""
        )}
      </span>
      <span
        className={`min-w-0 break-all ${done ? "font-medium" : active ? "" : "text-muted"}`}
      >
        {label}
      </span>
      <span className="sr-only">
        {done ? "(done)" : active ? "(in progress)" : "(not started)"}
      </span>
    </li>
  );
}
