"use client";

import { useState } from "react";
import type { ServerInfo } from "@/lib/netdata";
import { composeLink, explainPaste } from "@/lib/paste-guard";

type Test = { ok: boolean; ms?: number; error?: string; info?: ServerInfo };

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json" },
  }).catch(() => null);
  if (!r)
    return { ok: false, error: "Network error. Check your connection." } as T;
  return (await r
    .json()
    .catch(() => ({ ok: false, error: `Request failed (${r.status})` }))) as T;
}

const field =
  "w-full rounded-lg border border-field bg-surface px-3 py-2.5 font-mono text-base sm:text-sm";

/**
 * Connect a server by hand: address + username + password (or one full link). Tests, then saves; data
 * flows right away. Used by Add server ("connect manually") and Settings.
 */
export function LinkForm({
  submitLabel = "Test and connect",
  onSaved,
  disabled,
}: {
  submitLabel?: string;
  onSaved: () => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<"fields" | "link">("fields");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("dashboard");
  const [pass, setPass] = useState("");
  const [link, setLink] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url =
    mode === "fields"
      ? address && pass
        ? composeLink(address, user, pass)
        : ""
      : link.trim();
  const hint = explainPaste(mode === "fields" ? `${address} ${pass}` : link);

  async function save() {
    setBusy("save");
    const r = await json<{ ok?: boolean; error?: string }>(
      "/api/settings/link",
      { method: "POST", body: JSON.stringify({ url }) },
    );
    setBusy(null);
    if (r.ok) {
      setLink("");
      setPass("");
      setTest(null);
      onSaved();
    } else setError(r.error ?? "Could not save the link");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTest(null);
    if (hint) return setError(hint);
    setBusy("test");
    const t = await json<Test>("/api/settings/test", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    setBusy(null);
    setTest(t);
    if (t.ok) await save();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div
        role="group"
        aria-label="How to enter it"
        className="inline-flex rounded-lg border border-line p-0.5 text-xs"
      >
        {(
          [
            ["fields", "Address and password"],
            ["link", "One full link"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={mode === k}
            onClick={() => setMode(k)}
            className={`rounded-md px-2.5 py-1 ${mode === k ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {mode === "fields" ? (
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1.5fr]">
          <label className="block min-w-0">
            <span className="text-sm font-medium">Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="your-name.ngrok-free.dev"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={disabled}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block min-w-0">
            <span className="text-sm font-medium">Username</span>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="block min-w-0">
            <span className="text-sm font-medium">Agent password</span>
            <div className="relative mt-1">
              <input
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                type={show ? "text" : "password"}
                aria-label="Agent password" // the Show button sits inside the label: name the field explicitly
                autoComplete="off"
                required
                disabled={disabled}
                className={`${field} pr-14`}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label="Show password"
                aria-pressed={show}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-muted hover:text-ink"
              >
                {show ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <p className="text-xs text-muted sm:col-span-3">
            On the server,{" "}
            <code className="font-mono">sudo server-pulse-agent link</code>{" "}
            shows the address and password. This is the agent&apos;s password,
            not a btop or ngrok login.
          </p>
        </div>
      ) : (
        <label className="block">
          <span className="text-sm font-medium">Server link</span>
          <span className="block break-all text-xs text-muted">
            Looks like
            https://dashboard:PASSWORD@your-name.ngrok-free.dev/history
          </span>
          <div className="relative mt-1">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              type={show ? "text" : "password"}
              aria-label="Server link"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={disabled}
              placeholder="https://dashboard:PASSWORD@host"
              className={`${field} pr-14`}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label="Show password"
              aria-pressed={show}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-muted hover:text-ink"
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>
      )}

      {hint && (
        <p className="rounded-lg border border-warn-line bg-surface p-3 text-sm text-warn">
          {hint}
        </p>
      )}

      <button
        disabled={!!busy || disabled || !url}
        className="rounded-lg bg-signal px-4 py-2.5 text-sm font-medium text-on-signal disabled:opacity-50"
      >
        {busy === "test"
          ? "Testing…"
          : busy === "save"
            ? "Saving…"
            : submitLabel}
      </button>

      <div aria-live="polite" className="text-sm">
        {test?.ok && (
          <p className="text-ok">
            Connected in {test.ms} ms to {test.info?.hostname}
            {test.info?.os ? ` (${test.info.os})` : ""}.
          </p>
        )}
        {test && !test.ok && (
          <div className="space-y-2 rounded-lg border border-crit-line bg-surface p-3">
            <p className="text-crit">{test.error}</p>
            <button
              type="button"
              onClick={save}
              disabled={!!busy}
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-signal"
            >
              Save anyway
            </button>
          </div>
        )}
        {error && <p className="text-crit">{error}</p>}
      </div>
    </form>
  );
}
