import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { changePassword, deleteAccount, NewPassword } from "@/lib/accounts";
import { COOKIE, cookieOptions, forgetAccountCheck, guard, signSession } from "@/lib/auth";

const Change = z.object({ current: z.string().min(1).max(256), next: NewPassword });
const Del = z.object({ password: z.string().min(1).max(256) });

/** Change password. Other devices are signed out; this one gets a fresh session. */
export async function POST(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  if (!s.uid) return NextResponse.json({ error: "Shared passwords are changed in Vercel's environment variables" }, { status: 400 });
  const body = Change.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Check the form" }, { status: 400 });
  const next = await changePassword(s, body.data.current, body.data.next);
  if (!next) return NextResponse.json({ error: "Current password is wrong" }, { status: 401 });
  forgetAccountCheck(s.uid);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await signSession(next), cookieOptions);
  return res;
}

/** Delete the account and all of its stored history. */
export async function DELETE(req: NextRequest) {
  const s = await guard(req, "owner");
  if (s instanceof Response) return s;
  if (!s.uid) return NextResponse.json({ error: "This login has no account to delete" }, { status: 400 });
  const body = Del.safeParse(await req.json().catch(() => null));
  if (!body.success || !(await deleteAccount(s, body.data.password)))
    return NextResponse.json({ error: "Password is wrong" }, { status: 401 });
  forgetAccountCheck(s.uid);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
