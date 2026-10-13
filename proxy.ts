import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifySession } from "@/lib/session";

// APP-3: every page and API route needs a session, except login, sign-up, the public setup guide, cron and
// static assets. Signature + expiry only here (no DB); routes re-check account sessions via lib/auth.
export async function proxy(req: NextRequest) {
  const s = await verifySession(req.cookies.get(COOKIE)?.value);
  const { pathname, search } = req.nextUrl;
  if (!s) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  if (s.role === "viewer" && (pathname.startsWith("/settings") || pathname.startsWith("/connect") || pathname.startsWith("/logs")))
    return NextResponse.redirect(new URL("/", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: [
    // API routes are excluded: each one checks the session itself (guard), so the proxy would only add a hop
    "/((?!api/|install\.sh|login|signup|setup|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|sw.js).*)",
  ],
};
