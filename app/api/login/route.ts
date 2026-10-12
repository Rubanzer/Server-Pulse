import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, Email } from "@/lib/accounts";
import { authLimiter as limiter, clientIp, COOKIE, cookieOptions, envSession, roleForPassword, signSession } from "@/lib/auth";

/** With `email`: account login. Without: the shared dashboard / viewer password from the environment. */
const Body = z.object({ email: z.string().max(254).optional(), password: z.string().min(1).max(512) });

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!limiter.hit(ip)) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Enter your password" }, { status: 400 });
  const { email, password } = body.data;

  let session = null;
  if (email) {
    const e = Email.safeParse(email);
    session = e.success ? await authenticate(e.data, password) : null;
  } else {
    const role = roleForPassword(password);
    session = role ? envSession(role) : null;
  }
  if (!session) {
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: email ? "Wrong email or password" : "Wrong password" }, { status: 401 });
  }
  limiter.clear(ip);
  const res = NextResponse.json({ role: session.role });
  res.cookies.set(COOKIE, await signSession(session), cookieOptions);
  return res;
}
