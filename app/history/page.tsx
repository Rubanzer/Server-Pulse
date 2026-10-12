import { Suspense } from "react";
import { HistoryView } from "@/components/history-view";

export const metadata = { title: "History" };

export default function HistoryPage() {
  return (
    <Suspense>
      <HistoryView />
    </Suspense>
  );
}
