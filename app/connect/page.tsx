"use client";

import Link from "next/link";
import { LinkForm } from "@/components/link-form";
import { hardNavigate } from "@/lib/navigate";

export default function ConnectPage() {
  return (
    <div className="mx-auto mt-[4vh] w-full max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Connect your server</h1>
        <p className="max-w-[65ch] text-muted">
          Paste the link to your server and the dashboard starts reading it immediately: live vitals now, and 30 days of
          history imported in the background.
        </p>
      </header>

      <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <LinkForm
          onSaved={() => {
            hardNavigate("/"); // the 30-day history import starts on the next page (BackfillRunner)
          }}
        />
      </section>

      <section className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="rounded-xl border border-line p-4">
          <h2 className="font-medium">No link yet?</h2>
          <p className="mt-1 text-muted">
            The{" "}
            <Link href="/setup" className="text-signal underline">
              server setup guide
            </Link>{" "}
            installs everything on Ubuntu in about ten minutes and gives you this link at the end.
          </p>
        </div>
        <div className="rounded-xl border border-line p-4">
          <h2 className="font-medium">Is it safe?</h2>
          <p className="mt-1 text-muted">
            The link uses a read-only login that can&apos;t change anything on the server. It is stored encrypted and never sent
            back to your browser.
          </p>
        </div>
      </section>
    </div>
  );
}
