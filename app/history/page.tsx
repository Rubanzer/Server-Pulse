import { cookies } from "next/headers";
import { Suspense } from "react";
import { HistoryView } from "@/components/history-view";
import { COOKIE, verifySession } from "@/lib/session";

export const metadata = { title: "History" };

export default async function HistoryPage() {
  const s = await verifySession((await cookies()).get(COOKIE)?.value);
  return (
    <Suspense>
      <HistoryView owner={s?.role === "owner"} />
    </Suspense>
  );
}
