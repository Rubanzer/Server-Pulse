"use client";

import { useState } from "react";
import type { ServerInfo } from "@/lib/netdata";

type Test = { ok: boolean; ms?: number; error?: string; info?: ServerInfo };

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } }).catch(() => null);
  if (!r) return { ok: false, error: "Network error. Check your connection." } as T;
  return (await r.json().catch(() => ({ ok: false, error: `Request failed (${r.status})` }))) as T;
}

/**
 * Paste a server link (ngrok, Tailscale Funnel or any HTTPS host), test it, save it. Data starts flowing
 * right away. Used by /connect and Settings.
 */
export function LinkForm({ submitLabel = "Test and connect", onSaved, disabled }: { submitLabel?: string; onSaved: () => void; disabled?: boolean }) {
  const [url, setUrl] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    const r = await json<{ ok?: boolean; error?: string }>("/api/settings/link", { method: "POST", body: JSON.stringify({ url }) });
    setBusy(null);
    if (r.ok) {
      setUrl("");
      setTest(null);
      onSaved();
    } else setError(r.error ?? "Could not save the link");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTest(null);
    setBusy("test");
    const t = await json<Test>("/api/settings/test", { method: "POST", body: JSON.stringify({ url }) });
    setBusy(null);
    setTest(t);
    if (t.ok) await save();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block" htmlFor="server-link">
        <span className="text-sm font-medium">Server link</span>
        <span className="block break-all text-xs text-muted">
          Looks like https://dashboard:PASSWORD@your-name.ngrok-free.app or https://dashboard:PASSWORD@machine.tailnet.ts.net
        </span>
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <input
            id="server-link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type={show ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
            placeholder="https://dashboard:PASSWORD@host"
            className="w-full rounded-lg border border-line bg-surface py-2.5 pl-3 pr-16 font-mono text-base sm:text-sm"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-muted hover:text-ink"
            aria-label={show ? "Hide link" : "Show link"}
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <button disabled={!!busy || disabled || !url} className="shrink-0 rounded-lg bg-signal px-4 py-2.5 text-sm font-medium text-on-signal disabled:opacity-50">
          {busy === "test" ? "Testing…" : busy === "save" ? "Saving…" : submitLabel}
        </button>
      </div>
      <div aria-live="polite" className="text-sm">
        {test?.ok && (
          <p className="text-ok">
            Connected in {test.ms} ms to {test.info?.hostname}
            {test.info?.os ? ` (${test.info.os})` : ""}.
          </p>
        )}
        {test && !test.ok && (
          <div className="space-y-2 rounded-lg border border-crit/40 bg-surface p-3">
            <p className="text-crit">Connection failed: {test.error}</p>
            <p className="text-xs text-muted">
              Check that the tunnel is running and the user and password match the dashboard user from setup step 3. You can
              still save the link and fix the server afterwards.
            </p>
            <button type="button" onClick={save} disabled={!!busy} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-signal">
              Save anyway
            </button>
          </div>
        )}
        {error && <p className="text-crit">{error}</p>}
      </div>
    </form>
  );
}
