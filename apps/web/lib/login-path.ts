/** The login gate's address, and the only destinations it will send you back to (same-origin app paths). */
export const LOGIN_PATH = "/login";

/** A safe "next" for after sign-in: an app path on this origin, never /login, /api, another host or a scheme. */
export function safeNext(v: string | null | undefined): string {
  if (typeof v !== "string" || v.length > 512) return "/";
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\r\n\t\\]/.test(v)) return "/";
  const path = v.split(/[?#]/)[0];
  if (path === LOGIN_PATH || path.startsWith(LOGIN_PATH + "/") || path === "/api" || path.startsWith("/api/")) return "/";
  return v;
}

/** The login page for "come back to where I am" (used when a session ends while the app is open). */
export function loginHref(current: string): string {
  const next = safeNext(current);
  return next === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}
