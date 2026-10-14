"use client";

/** A render error on one page shows this instead of Next's bare "Application error" screen. */
export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="mx-auto mt-[8vh] max-w-xl rounded-xl border border-crit-line bg-surface p-6 text-center sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong on this page</h1>
      <p className="mt-2 text-muted">Your server and its history are fine. Try again, or open another page from the menu.</p>
      <button onClick={reset} className="mt-6 rounded-lg bg-signal px-4 py-2.5 font-medium text-on-signal">
        Try again
      </button>
    </section>
  );
}
