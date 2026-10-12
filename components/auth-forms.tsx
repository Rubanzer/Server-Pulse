"use client";

import Link from "next/link";
import { hardNavigate } from "@/lib/navigate";
import { useState } from "react";

export const input = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base sm:text-sm";
export const primaryBtn = "w-full rounded-lg bg-signal px-3 py-2.5 font-medium text-on-signal disabled:opacity-60";

/** Same-origin path from ?next=, or "/". Resolving against our origin defeats `//evil`, `/\evil` and tab tricks. */
export function safeNext(): string {
  const next = new URLSearchParams(location.search).get("next");
  if (!next) return "/";
  try {
    const u = new URL(next, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

async function post(url: string, body: unknown): Promise<string | null> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return "Network error. Check your connection.";
  if (r.ok) return null;
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${r.status})`;
}

export function AuthCard({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-[6vh] w-full max-w-sm sm:mt-[10vh]">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {intro && <div className="mt-1 text-sm text-muted">{intro}</div>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function ErrorText({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <p id={id} role="alert" className="text-sm text-crit">
      {error}
    </p>
  ) : null;
}

export function LoginForm({ accounts, shared, demo }: { accounts: boolean; shared: boolean; demo: boolean }) {
  const [mode, setMode] = useState<"account" | "shared">(accounts ? "account" : "shared");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const err = await post("/api/login", { email: mode === "account" ? String(fd.get("email")) : undefined, password: String(fd.get("password")) });
    if (!err) {
      hardNavigate(safeNext());
      return;
    }
    setError(err);
    setBusy(false);
  }

  return (
    <AuthCard
      title="Log in"
      intro={
        mode === "account"
          ? "Use the email and password of your Server Pulse account."
          : <>Use the dashboard password. By default it is the password inside your server link.{demo && <> Nothing is set up yet, so it is <code className="font-mono">demo</code>.</>}</>
      }
    >
      {accounts && shared && (
        <div role="tablist" aria-label="Login type" className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
          {(
            [
              ["account", "Account"],
              ["shared", "Dashboard password"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`rounded-md px-2 py-1.5 ${mode === m ? "bg-signal text-on-signal" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="space-y-4" key={mode}>
        {mode === "account" && (
          <label className="block">
            <span className="text-sm font-medium">Email</span>
            <input name="email" type="email" autoComplete="email" required autoFocus className={input} />
          </label>
        )}
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus={mode === "shared"}
            className={input}
            aria-invalid={!!error}
            aria-describedby={error ? "login-error" : undefined}
          />
        </label>
        <ErrorText id="login-error" error={error} />
        <button disabled={busy} className={primaryBtn}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      <div className="mt-6 space-y-2 text-sm text-muted">
        {accounts && (
          <p>
            New here?{" "}
            <Link href="/signup" className="text-signal underline">
              Create an account
            </Link>
          </p>
        )}
        <p>
          Server not set up yet? Follow the{" "}
          <Link href="/setup" className="text-signal underline">
            server setup guide
          </Link>
          .
        </p>
      </div>
    </AuthCard>
  );
}

export function SignupForm({ open }: { open: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get("password") !== fd.get("confirm")) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    const err = await post("/api/signup", { email: String(fd.get("email")), password: String(fd.get("password")) });
    if (!err) {
      hardNavigate("/connect");
      return;
    }
    setError(err);
    setBusy(false);
  }

  if (!open)
    return (
      <AuthCard title="Create an account">
        <p className="rounded-lg border border-line bg-surface p-4 text-sm">
          Sign-up isn&apos;t available here. Accounts need a database (Vercel → Storage → Neon), and the owner may have turned
          sign-up off with <code className="font-mono text-xs">DISABLE_SIGNUP</code>.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-signal underline">
            Back to log in
          </Link>
        </p>
      </AuthCard>
    );

  return (
    <AuthCard title="Create an account" intro="Your account gets its own server link and its own history. Nobody else can see it.">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input name="email" type="email" autoComplete="email" required autoFocus className={input} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input name="password" type="password" autoComplete="new-password" required minLength={10} className={input} aria-describedby="pw-hint" />
          <span id="pw-hint" className="mt-1 block text-xs text-muted">
            At least 10 characters.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Repeat password</span>
          <input name="confirm" type="password" autoComplete="new-password" required minLength={10} className={input} />
        </label>
        <ErrorText id="signup-error" error={error} />
        <button disabled={busy} className={primaryBtn}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-signal underline">
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}
