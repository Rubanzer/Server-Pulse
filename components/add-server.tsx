"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hardNavigate } from "@/lib/navigate";
import { CodeBlock } from "./code-block";
import { LinkForm } from "./link-form";

type Pairing = { code: string; command: string; expiresAt: string };
type Step = "waiting" | "paired" | "data";

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
  const [left, setLeft] = useState(600);
  const started = useRef(false);

  const newCode = useCallback(async () => {
    setError(null);
    setAgentError(null);
    setStep("waiting");
    const r = await fetch("/api/agent/pair-code", { method: "POST" }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return setError(body.error ?? "Couldn't create an install command. Check your connection and try again.");
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
      const secs = Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000));
      setLeft(secs);
      if (step === "waiting") {
        const s = await fetch(`/api/agent/pair-status?code=${encodeURIComponent(pairing.code)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
        if (s?.status === "paired") {
          setHost(s.hostname ?? null);
          setStep("paired");
        } else if (s?.status === "error") {
          setAgentError(s.error);
        }
      } else if (step === "paired") {
        const live = await fetch("/api/live", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
        if (live?.mode === "live") {
          setStep("data");
          setTimeout(() => hardNavigate("/server"), 1200);
          return;
        }
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
      <section className="rounded-xl border border-warn/50 bg-surface p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Finish setup first</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">This dashboard needs its database before it can add servers. It takes about a minute in Vercel:</p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Open your project on vercel.com → <b>Storage</b> → <b>Create Database</b> → <b>Neon</b> (free) → connect it to this project.</li>
          <li>
            <b>Deployments</b> → ⋯ on the latest one → <b>Redeploy</b>.
          </li>
          <li>Come back here. The install command will be waiting.</li>
        </ol>
      </section>
    );

  const expired = left === 0 && step === "waiting";
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold">Paste this into your server&apos;s terminal</h2>
          <p className="mt-1 text-sm text-muted">Ubuntu 22.04 or 24.04. It installs the agent, connects it to this dashboard and keeps it running 24/7.</p>
        </div>
        {error ? (
          <p className="text-sm text-crit">{error}</p>
        ) : !pairing ? (
          <div className="h-14 animate-pulse rounded-lg bg-paper" />
        ) : expired ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm">
            <span className="text-muted">This command expired.</span>
            <button onClick={newCode} className="rounded-lg bg-signal px-3 py-1.5 font-medium text-on-signal">
              Get a new command
            </button>
          </div>
        ) : (
          <>
            <CodeBlock code={pairing.command} label="Install command" />
            <p className="text-xs text-muted">
              Works once, for {mm} more. The code in it is safe to show: it expires by itself and can&apos;t be reused.
            </p>
          </>
        )}

        <ol className="space-y-2 text-sm" aria-live="polite">
          <Check done={step !== "waiting"} active={step === "waiting" && !expired} label={step === "waiting" ? "Waiting for your server…" : `Connected${host ? `: ${host}` : ""}`} />
          <Check done={step === "data"} active={step === "paired"} label={step === "data" ? "Receiving live data. Opening your server…" : "Live data"} />
        </ol>
        {agentError && (
          <p className="rounded-lg border border-crit/40 p-3 text-sm text-crit">
            {agentError} <span className="text-muted">The installer keeps trying; you can also run the command again.</span>
          </p>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">The first time: what you&apos;ll see</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            <li>
              It shows a <b>Tailscale login link</b>. Open it, sign in with Google, Microsoft or GitHub (free) and approve the server. That gives it a private HTTPS address; no
              router ports are opened.
            </li>
            <li>When it says &ldquo;Done&rdquo;, this page moves on by itself.</li>
            <li>
              Already use <b>ngrok</b>? Point ngrok at <code className="font-mono">127.0.0.1:19998</code> (without <code className="font-mono">--basic-auth</code>) and add your
              ngrok address at the end of the command: <code className="font-mono break-all">… {pairing?.code ?? "CODE"} https://your-name.ngrok-free.dev</code>
            </li>
          </ul>
        </details>
      </section>

      <details className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <summary className="cursor-pointer font-medium">Connect manually (advanced)</summary>
        <p className="mb-4 mt-1 text-sm text-muted">If the agent is already installed, enter its address and password.</p>
        <LinkForm onSaved={() => hardNavigate("/server")} />
      </details>
    </div>
  );
}

function Check({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={`grid size-5 place-items-center rounded-full text-[11px] ${done ? "bg-ok text-on-signal" : active ? "border-2 border-signal" : "border border-line"}`}
      >
        {done ? "✓" : active ? <span className="size-1.5 animate-ping rounded-full bg-signal" /> : ""}
      </span>
      <span className={done ? "font-medium" : active ? "" : "text-muted"}>{label}</span>
      <span className="sr-only">{done ? "(done)" : active ? "(in progress)" : "(not started)"}</span>
    </li>
  );
}
