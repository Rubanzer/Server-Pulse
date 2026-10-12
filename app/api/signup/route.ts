import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAccount, Email, NewPassword } from "@/lib/accounts";
import { authLimiter as limiter, clientIp, COOKIE, cookieOptions, signSession, signupOpen } from "@/lib/auth";

const Body = z.object({ email: Email, password: NewPassword });

export async function POST(req: NextRequest) {
  if (!signupOpen())
    return NextResponse.json({ error: "Sign-up is turned off on this dashboard. Ask the owner, or connect a database." }, { status: 403 });
  if (!limiter.hit(clientIp(req))) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Check the form" }, { status: 400 });
  const session = await createAccount(body.data.email, body.data.password);
  if (!session) return NextResponse.json({ error: "An account with this email already exists. Log in instead." }, { status: 409 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await signSession(session), cookieOptions);
  return res;
}
