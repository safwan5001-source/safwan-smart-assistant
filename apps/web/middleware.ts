/**
 * Login gate: with unified sign-in on (OWNER_AUTH=on), no page of the app is served without a valid owner session — the check
 * runs on the server before anything renders. Pages go to /login?next=<where you were going>; /login itself goes straight to
 * the app once signed in. /api/* is not handled here: every door checks the same session itself and answers 401 (JSON).
 * Static files (anything with an extension, /_next) stay public so the login page can show the brand.
 * With OWNER_AUTH off this is a no-op (the legacy per-door codes keep working).
 */
import { NextResponse, type NextRequest } from "next/server";
import { callBackend } from "@/server/backend";
import { checkOwnerSession, ownerAuthOn } from "@/server/owner-session";
import { LOGIN_PATH, safeNext } from "@/lib/login-path";

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!api/|_next/|.*\\.[A-Za-z0-9]+$).*)"],
};

const PRIVATE = "private, no-store";

export async function middleware(req: NextRequest) {
  if (!ownerAuthOn(process.env)) return NextResponse.next();
  const { pathname, search, searchParams } = req.nextUrl;
  const { account, outage } = await checkOwnerSession(new Request(req.url, { headers: req.headers }), { env: process.env, callBackend, now: Date.now });

  if (pathname === LOGIN_PATH) {
    if (account) return NextResponse.redirect(new URL(safeNext(searchParams.get("next")), req.url));
    const res = NextResponse.next();
    res.headers.set("Cache-Control", PRIVATE);
    return res;
  }
  if (account) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", PRIVATE);
    return res;
  }
  const to = new URL(LOGIN_PATH, req.url);
  const next = safeNext(pathname + search);
  if (next !== "/") to.searchParams.set("next", next);
  if (outage) to.searchParams.set("reason", "unavailable");
  return NextResponse.redirect(to);
}
