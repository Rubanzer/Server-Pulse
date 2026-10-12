import { type NextRequest } from "next/server";
import { canSaveLink, guard } from "@/lib/auth";
import { LIMITS, maskLink } from "@/lib/config";
import { db } from "@/lib/db";
import { mailConfigured } from "@/lib/mail";
import { getLink } from "@/lib/settings";
import { backfillPending, recentRuns, storageStats } from "@/lib/sync";
import { getUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

const safe = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

/** HIS-7: everything the Settings page shows, in one request. */
export async function GET(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  const state = await getLink(s.sid);
  const [runs, storage, pending, usage] = await Promise.all([
    safe(recentRuns(s.sid, 10), []),
    safe(storageStats(s.sid), null),
    state.link ? safe(backfillPending(s.sid), []) : Promise.resolve([]),
    state.link?.tunnel === "ngrok" ? safe(getUsage(s.sid), null) : Promise.resolve(null),
  ]);
  return Response.json({
    account: s.email ?? null,
    demo: state.demo,
    link: state.link ? maskLink(state.link) : null,
    linkError: state.error,
    linkSource: state.source,
    btopUrl: state.link?.root ?? null,
    tunnel: state.link?.tunnel ?? null,
    canSaveLink: canSaveLink(s) && !!db,
    database: !!db,
    mail: mailConfigured(),
    cronSecret: !!process.env.CRON_SECRET,
    viewer: !!process.env.VIEWER_PASSWORD,
    runs,
    storage: storage && { ...storage, limit: LIMITS.neonStorageBytes },
    pending,
    usage,
  });
}
