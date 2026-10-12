"use client";

import { useEffect, useMemo, useState } from "react";
import { buildSteps, fullScript, HOST, randomPassword, SAFE_PASSWORD, serverLink, UNINSTALL, type SetupInput } from "@/lib/setup-script";
import { CodeBlock } from "./code-block";


const field = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-crit">{error}</span> : hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function SetupGuide() {
  const [i, setI] = useState<SetupInput>(() => ({
    ownerPass: "",
    appPass: "",
    tunnel: "tailscale",
    ngrokToken: "",
    ngrokDomain: "",
    telegramToken: "",
    telegramChat: "",
    smtpHost: "smtp.gmail.com",
    smtpPort: "587",
    smtpUser: "",
    smtpPass: "",
    mailTo: "",
  }));
  const [host, setHost] = useState("");
  // generated after mount: random values during server render would not match the client
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setI((x) => ({ ...x, ownerPass: randomPassword(), appPass: randomPassword() }));
  }, []);
  const set = <K extends keyof SetupInput>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setI((x) => ({ ...x, [k]: e.target.value }));

  const pwErr = (p: string) => (SAFE_PASSWORD.test(p) ? null : "Use 12 or more letters and digits only. It goes inside a URL.");
  const errors = {
    owner: pwErr(i.ownerPass),
    app: pwErr(i.appPass) ?? (i.appPass === i.ownerPass ? "Use a different password from the owner one." : null),
    domain: i.tunnel === "ngrok" && i.ngrokDomain && !HOST.test(i.ngrokDomain) ? "Just the domain, like my-name.ngrok-free.app" : null,
    host: host && !HOST.test(host) ? "Just the host name, like my-server.tail1234.ts.net" : null,
  };
  const valid = !errors.owner && !errors.app && !errors.domain;

  const steps = useMemo(() => buildSteps(i), [i]);
  const publicHost = i.tunnel === "ngrok" ? i.ngrokDomain : host;
  const link = serverLink(i, publicHost);

  function download() {
    const blob = new Blob([fullScript(i)], { type: "text/x-shellscript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "server-pulse-setup.sh";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-3 pt-4">
        <h1 className="text-3xl font-semibold tracking-tight">Set up your server</h1>
        <p className="max-w-[68ch] text-muted">
          About ten minutes on an Ubuntu 22.04 or 24.04 machine with a sudo user. When you finish you will have btop in your browser,
          Netdata recording every second, one login protecting both, and a private HTTPS link that this dashboard reads. No router
          ports are opened.
        </p>
        <p className="max-w-[68ch] text-sm text-muted">
          Everything on this page is generated in your browser. Passwords you type here are not sent anywhere.
        </p>
      </header>

      <section aria-labelledby="choices" className="space-y-5 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 id="choices" className="text-lg font-semibold">
          Your choices
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your login password (user owner)" hint="You type this when you open btop in the browser." error={errors.owner}>
            <div className="flex gap-2">
              <input className={`${field} font-mono`} value={i.ownerPass} onChange={set("ownerPass")} spellCheck={false} autoComplete="off" />
              <button type="button" className="mt-1 rounded-lg border border-line px-3 text-sm" onClick={() => setI((x) => ({ ...x, ownerPass: randomPassword() }))}>
                New
              </button>
            </div>
          </Field>
          <Field label="Dashboard password (user dashboard)" hint="Only this app uses it. It ends up inside SERVER_URL." error={errors.app}>
            <div className="flex gap-2">
              <input className={`${field} font-mono`} value={i.appPass} onChange={set("appPass")} spellCheck={false} autoComplete="off" />
              <button type="button" className="mt-1 rounded-lg border border-line px-3 text-sm" onClick={() => setI((x) => ({ ...x, appPass: randomPassword() }))}>
                New
              </button>
            </div>
          </Field>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">How the dashboard reaches your server</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(
              [
                ["tailscale", "Tailscale Funnel", "Recommended. Free, a fixed https://….ts.net address, no request limit."],
                ["ngrok", "ngrok", "Free plan allows 20,000 requests a month, so live view refreshes every 10 s and pauses at 80%."],
              ] as const
            ).map(([v, title, desc]) => (
              <label
                key={v}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${i.tunnel === v ? "border-signal ring-1 ring-signal" : "border-line"}`}
              >
                <input type="radio" name="tunnel" value={v} checked={i.tunnel === v} onChange={set("tunnel")} className="mt-1 accent-[var(--color-signal)]" />
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted">{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {i.tunnel === "ngrok" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="ngrok authtoken" hint={<>From dashboard.ngrok.com → Your Authtoken.</>}>
              <input className={`${field} font-mono`} value={i.ngrokToken} onChange={set("ngrokToken")} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="ngrok free domain" hint="From dashboard.ngrok.com → Domains. Every free account gets one." error={errors.domain}>
              <input className={`${field} font-mono`} value={i.ngrokDomain} onChange={set("ngrokDomain")} placeholder="my-name.ngrok-free.app" spellCheck={false} />
            </Field>
          </div>
        )}

        <details className="rounded-lg border border-line p-4">
          <summary className="cursor-pointer text-sm font-medium">Alerts on Telegram (optional)</summary>
          <p className="mt-2 text-xs text-muted">
            Create a bot with @BotFather and copy its token. Send your bot any message, then open
            https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates and copy the chat id.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Bot token">
              <input className={`${field} font-mono`} value={i.telegramToken} onChange={set("telegramToken")} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Chat id">
              <input className={`${field} font-mono`} value={i.telegramChat} onChange={set("telegramChat")} spellCheck={false} />
            </Field>
          </div>
        </details>

        <details className="rounded-lg border border-line p-4">
          <summary className="cursor-pointer text-sm font-medium">Email alerts and a 30-day report (optional)</summary>
          <p className="mt-2 text-xs text-muted">For Gmail, create an App Password at myaccount.google.com/apppasswords. Your normal password will not work.</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host">
              <input className={field} value={i.smtpHost} onChange={set("smtpHost")} spellCheck={false} />
            </Field>
            <Field label="SMTP port">
              <select className={field} value={i.smtpPort} onChange={set("smtpPort")}>
                <option value="587">587 (STARTTLS)</option>
                <option value="465">465 (SSL)</option>
              </select>
            </Field>
            <Field label="SMTP user">
              <input className={field} value={i.smtpUser} onChange={set("smtpUser")} placeholder="you@gmail.com" spellCheck={false} />
            </Field>
            <Field label="SMTP password">
              <input className={`${field} font-mono`} type="password" value={i.smtpPass} onChange={set("smtpPass")} autoComplete="off" />
            </Field>
            <Field label="Send alerts and reports to">
              <input className={field} type="email" value={i.mailTo} onChange={set("mailTo")} placeholder="you@gmail.com" />
            </Field>
          </div>
        </details>
      </section>

      <section aria-labelledby="run" className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="run" className="text-lg font-semibold">
              Run these on your server
            </h2>
            <p className="text-sm text-muted">SSH in as your normal user and paste each block in order, or download them as one script.</p>
          </div>
          <button
            type="button"
            disabled={!valid}
            onClick={download}
            className="rounded-lg bg-signal px-4 py-2 text-sm font-medium text-on-signal disabled:opacity-50"
          >
            Download setup script
          </button>
        </div>
        {!valid && <p className="text-sm text-crit">Fix the highlighted fields above first.</p>}

        <ol className="space-y-8">
          {steps.map((s, n) => (
            <li key={s.id} className="grid gap-3 sm:grid-cols-[2.5rem_1fr]">
              <span aria-hidden className="font-cond text-3xl font-semibold leading-none text-signal">
                {n + 1}
              </span>
              <div className="min-w-0 space-y-3">
                <div>
                  <h3 className="font-semibold">
                    {s.title}
                    {s.optional && <span className="ml-2 text-xs font-normal text-muted">optional</span>}
                  </h3>
                  <p className="mt-0.5 max-w-[68ch] text-sm text-muted">{s.why}</p>
                </div>
                <CodeBlock code={s.script} label={s.title} />
                {s.note && (
                  <p className="rounded-lg border border-warn/50 bg-surface px-3 py-2 text-sm">
                    <strong className="font-medium text-warn">Needed for 24/7: </strong>
                    {s.note}
                  </p>
                )}
                {s.verify && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted">Check it worked</p>
                    <CodeBlock code={s.verify} label={`Check: ${s.title}`} />
                  </div>
                )}
              </div>
            </li>
          ))}

          <li className="grid gap-3 sm:grid-cols-[2.5rem_1fr]">
            <span aria-hidden className="font-cond text-3xl font-semibold leading-none text-signal">
              {steps.length + 1}
            </span>
            <div className="min-w-0 space-y-4">
              <div>
                <h3 className="font-semibold">Connect this dashboard</h3>
                <p className="mt-0.5 max-w-[68ch] text-sm text-muted">This is the one link the dashboard needs.</p>
              </div>
              {i.tunnel === "tailscale" && (
                <Field label="Your Funnel address" hint="Shown by tailscale funnel status, without https://" error={errors.host}>
                  <input className={`${field} font-mono`} value={host} onChange={(e) => setHost(e.target.value.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))} placeholder="my-server.tail1234.ts.net" spellCheck={false} />
                </Field>
              )}
              <CodeBlock code={link} label="Your SERVER_URL" />
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                <li>
                  In Vercel open your project → Settings → Environment Variables, add <code className="font-mono text-xs">SERVER_URL</code> with the link above and mark it Sensitive.
                </li>
                <li>Storage → Create Database → Neon → connect it to this project. This keeps your history beyond 30 days.</li>
                <li>Deployments → the latest one → Redeploy.</li>
                <li>Log in with the dashboard password. The 30-day history import starts by itself.</li>
              </ol>
              <p className="text-sm text-muted">
                Already logged in as the owner? Paste the link in Settings → Change link to use it without redeploying.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section aria-labelledby="trouble" className="space-y-3">
        <h2 id="trouble" className="text-lg font-semibold">
          If something does not work
        </h2>
        <dl className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
          {[
            ["Connection test says HTTP 401", "The user or password in SERVER_URL does not match step 3. Run step 3 again or fix the link."],
            ["Connection test times out", "Check systemctl is-active caddy netdata, and tailscale funnel status (or systemctl status ngrok-pulse)."],
            ["Offline after months of working (Tailscale)", "The machine's key expired. Run sudo tailscale up, then disable key expiry in the admin console (step 4)."],
            ["Offline when the laptop sleeps", "Run the keep-awake step and reboot."],
            ["HTTP 502 from the server", "Caddy is running but Netdata is not: sudo systemctl restart netdata."],
            ["btop page looks garbled", "Zoom the browser out; the service already sets TERM=xterm-256color."],
            ["No Telegram alert", "Re-check the bot token and chat id, then run the check command in the Telegram step."],
            ["Report email not sent", "journalctl -u btop-report -n 30. Gmail needs an App Password."],
          ].map(([q, a]) => (
            <div key={q} className="grid gap-1 p-4 sm:grid-cols-[16rem_1fr] sm:gap-4">
              <dt className="font-medium">{q}</dt>
              <dd className="text-muted">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <details className="rounded-xl border border-line bg-surface p-5">
        <summary className="cursor-pointer font-semibold">Remove everything</summary>
        <p className="my-3 text-sm text-muted">Stops and deletes every service, binary and config file the steps above created.</p>
        <CodeBlock code={UNINSTALL} label="Uninstall" />
      </details>
    </div>
  );
}
