import { cookies } from "next/headers";
import { LiveView } from "@/components/live-view";
import { RecentFailures } from "@/components/recent-failures";
import { COOKIE, verifySession } from "@/lib/session";

export default async function LivePage() {
  const s = await verifySession((await cookies()).get(COOKIE)?.value);
  return (
    <>
      {s?.role === "owner" && <RecentFailures />}
      <LiveView />
    </>
  );
}
