import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto mt-[8vh] max-w-xl rounded-xl border border-line bg-surface p-6 text-center sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">There&apos;s no page at this address</h1>
      <p className="mt-2 text-muted">Check the link, or go back to the live view.</p>
      <Link href="/" className="mt-6 inline-block rounded-lg bg-signal px-4 py-2.5 font-medium text-on-signal">
        Back to Live
      </Link>
    </section>
  );
}
