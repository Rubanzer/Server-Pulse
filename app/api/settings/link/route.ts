import { type NextRequest } from "next/server";
import { z } from "zod";
import { canSaveLink, guard } from "@/lib/auth";
import { maskLink, parseServerLink } from "@/lib/config";
import { clearLink, saveLink } from "@/lib/settings";

export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().min(1).max(2048) });

/**
 * APP-4: save the server link (no redeploy). Env server → settings override of SERVER_URL; account → encrypted
 * on its own server row. The password is never echoed back.
 */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  if (!canSaveLink(s))
    return Response.json(
      { error: "Set SERVER_URL or DASHBOARD_PASSWORD in Vercel first, so the public demo password stops working. Or create an account." },
      { status: 400 },
    );
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Paste a link" }, { status: 400 });
  try {
    const raw = body.data.url.trim();
    const link = parseServerLink(raw, { sid: s.sid, trusted: false });
    await saveLink(s.sid, raw);
    return Response.json({ ok: true, link: maskLink(link) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Forget the saved link (env server falls back to SERVER_URL). */
export async function DELETE(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  await clearLink(s.sid);
  return Response.json({ ok: true });
}
