import "server-only";
/**
 * A1 — the ONE owner session of the app (code or Face ID), shared by every door (/api/basht, /api/browser, /api/assistant, /api/auth).
 *
 *   cookie `safwan_session` (HttpOnly, SameSite=Strict, Secure in production, Path=/) ──HMAC──▶ API /internal/v1/auth/session
 *
 * The cookie holds the API's session secret (only its SHA-256 is stored server-side, expiry judged by the database clock). The BFF
 * caches a positive or negative answer for a few seconds so polling a reply does not cost a database lookup per request.
 * The legacy per-feature codes keep working until the owner removes them; this module is the single place that knows the session.
 */
import { createHash } from "node:crypto";
import { callBackend as realCallBackend, type Env } from "./backend";

export const SESSION_COOKIE = "safwan_session";
export const REMEMBER_S = 30 * 24 * 3600; // "remember this device"
export type OwnerDeps = { env: Env; callBackend: typeof realCallBackend; now: () => number };
export type AuthConfig = { owner_auth: boolean; passkeys: boolean };

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CACHE_MS = 15_000;
let config: { at: number; value: AuthConfig } | null = null;
const seen = new Map<string, { until: number; account: string | null }>();

export function resetOwnerSessionCache(): void { config = null; seen.clear(); }
export function forgetSession(secret?: string): void { if (secret) seen.delete(digest(secret)); else seen.clear(); }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) { const v = part.slice(i + 1).trim(); return SECRET.test(v) ? v : undefined; }
  }
  return undefined;
}

export function sessionCookieHeader(secret: string, remember: boolean, secure: boolean): string {
  // without "remember", a browser-session cookie (the server-side session also ends after 12 h)
  return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${REMEMBER_S}` : ""}${secure ? "; Secure" : ""}`;
}
export const clearSessionCookieHeader = (secure: boolean) => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

/** The web switch for the unified owner login (not a secret). The owner code itself lives on the API only. */
export const ownerAuthOn = (env: Env) => env.OWNER_AUTH === "on";

/** Is owner login (and are passkeys) switched on in the API? Cached briefly; any failure reads as "off" (fail closed). */
export async function ownerAuthConfig(deps: OwnerDeps): Promise<AuthConfig> {
  if (!ownerAuthOn(deps.env)) return { owner_auth: false, passkeys: false };
  const now = deps.now();
  if (config && now - config.at < CACHE_MS) return config.value;
  const r = await deps.callBackend({ path: "/internal/v1/auth/config", method: "POST", body: {}, env: deps.env, timeoutMs: 5_000, maxBytes: 4096 });
  const j = (r.kind === "ok" && r.status === 200 ? r.json : null) as Partial<AuthConfig> | null;
  const value = { owner_auth: j?.owner_auth === true, passkeys: j?.owner_auth === true && j?.passkeys === true };
  if (r.kind === "ok") config = { at: now, value }; // do not cache an outage
  return value;
}

/** The owner's account id when the request carries a valid owner session, else null. */
export async function ownerSessionAccount(req: Request, deps: OwnerDeps): Promise<string | null> {
  return (await checkOwnerSession(req, deps)).account;
}

/** Same lookup, telling "not signed in" apart from "the API could not be asked" (`outage`, never cached). */
export async function checkOwnerSession(req: Request, deps: OwnerDeps): Promise<{ account: string | null; outage: boolean }> {
  const secret = readSessionCookie(req);
  if (!secret) return { account: null, outage: false };
  const key = digest(secret), now = deps.now();
  const hit = seen.get(key);
  if (hit && hit.until > now) return { account: hit.account, outage: false };
  const r = await deps.callBackend({ path: "/internal/v1/auth/session", method: "POST", body: { session: secret }, env: deps.env, timeoutMs: 5_000, maxBytes: 4096 });
  if (r.kind !== "ok") return { account: null, outage: true }; // outage: not signed in, and not cached
  const account = r.status === 200 && typeof (r.json as { account_id?: unknown })?.account_id === "string" ? (r.json as { account_id: string }).account_id : null;
  if (seen.size > 1000) seen.clear();
  seen.set(key, { until: now + CACHE_MS, account });
  return { account, outage: false };
}

/**
 * What a door needs: is it usable at all (`enabled`), and is this request the owner (`authenticated`)?
 * `legacy` = the door's own code gate (kept during the transition): `on` when configured, `ok` when its cookie is valid.
 */
export async function doorAccess(req: Request, deps: OwnerDeps, legacy: { on: boolean; ok: boolean }): Promise<{ enabled: boolean; authenticated: boolean; account: string | null }> {
  if (legacy.ok) return { enabled: true, authenticated: true, account: null };
  const owner = ownerAuthOn(deps.env);
  // no session cookie → no lookup at all (an anonymous request, or a door that is off, never reaches the API)
  const account = owner && readSessionCookie(req) ? await ownerSessionAccount(req, deps) : null;
  return { enabled: legacy.on || owner, authenticated: account !== null, account };
}
