import { AddServer } from "@/components/add-server";
import { db } from "@/lib/db";

export const metadata = { title: "Add server" };
export const dynamic = "force-dynamic";

export default function ConnectPage() {
  return (
    <div className="mx-auto mt-[3vh] w-full max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Add a server</h1>
        <p className="max-w-[65ch] text-muted">One command on your Ubuntu server. Live charts appear here a few seconds after it finishes.</p>
      </header>
      <AddServer database={!!db} />
    </div>
  );
}
