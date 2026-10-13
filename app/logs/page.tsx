import { Suspense } from "react";
import { LogsView } from "@/components/logs-view";

export const metadata = { title: "Logs" };

export default function LogsPage() {
  return (
    <Suspense>
      <LogsView />
    </Suspense>
  );
}
