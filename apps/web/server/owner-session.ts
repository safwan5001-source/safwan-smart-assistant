import "server-only";
/**
 * A1 — the ONE owner session of the app (code or Face ID), shared by every door (/api/basht, /api/browser, /api/assistant, /api/auth).
 *
 *   cookie `safwan_session` (HttpOnly, SameSite=Strict, Secure in production, Path=/) ──HMAC──▶ API /internal/v1/auth/session
 *
 * The cookie holds the API's session secret (only a keyed hash of it is stored server-side, expiry judged by the database clock),
 * followed by a tag this BFF computes from SERVICE_AUTH_SECRET: `<secret>.<tag>`. A made-up cookie fails the tag check here and
 * never costs the API a lookup (security review M2). The BFF caches a positive or negative answer for a few seconds (bounded LRU) so
 * polling a reply does not cost a database lookup per request, and limits uncached lookups per client.
 * The legacy per-feature codes keep working until the owner removes them; this module is the single place that knows the session.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { callBackend as realCallBackend, type Env } from "./backend";
import { clientIp } from "./client-ip";

export const SESSION_COOKIE = "safwan_session";
export const REMEMBER_S = 30 * 24 * 3600; // "remember this device"
export type OwnerDeps = { env: Env; callBackend: typeof realCallBackend; now: () => number };
/** `reachable`: the API answered (false = it could not be asked; never cached). */
export type AuthConfig = { owner_auth: boolean; passkeys: boolean; reachable: boolean };

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MIN_SECRET_BYTES = 32; // as backend.ts: a weaker SERVICE_AUTH_SECRET means no API calls and no session cookies
const VALUE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
const CONFIG_MS = 15_000;
/** Session answers are cached briefly; sign-out on this instance also drops them at once (review L2). */
export const SESSION_CACHE_MS = 5_000;
const CACHE_MAX = 1000;
/** Uncached session lookups per client per minute (a genuine device needs a handful: answers are cached). */
const LOOKUPS_PER_MIN = 60;
/** Fixed-window counter per key, bounded (a full table drops expired windows, then the oldest key). */
function createLimiter(max: number, windowMs: number, cap = 10_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (id: string, now: number): boolean => {
    const h = hits.get(id);
    if (!h || h.reset <= now) {
      if (hits.size >= cap) { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); while (hits.size >= cap) hits.delete(hits.keys().next().value as string); }
      hits.set(id, { n: 1, reset: now + windowMs }); return true;
    }
    h.n++; return h.n <= max;
  };
}
let config: { at: number; value: AuthConfig } | null = null;
const seen = new Map<string, { until: number; account: string | null }>(); // insertion order = least recently used first
let lookups = createLimiter(LOOKUPS_PER_MIN, 60_000);

export function resetOwnerSessionCache(): void { config = null; seen.clear(); lookups = createLimiter(LOOKUPS_PER_MIN, 60_000); }
export function forgetSession(secret?: string): void { if (secret) seen.delete(digest(secret)); else seen.clear(); }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** The cookie tag: binds a session cookie to THIS deployment's BFF (no SERVICE_AUTH_SECRET → no valid cookie at all). */
function tag(secret: string, env: Env): string | null {
  const key = env.SERVICE_AUTH_SECRET;
  if (!key || Buffer.byteLength(key, "utf8") < MIN_SECRET_BYTES) return null;
  const k = createHmac("sha256", key).update("basht-session-cookie-v1").digest();
  return createHmac("sha256", k).update(secret).digest("base64url").slice(0, 22);
}
export function sessionCookieValue(secret: string, env: Env): string | null {
  const t = SECRET.test(secret) ? tag(secret, env) : null;
  return t ? `${secret}.${t}` : null;
}

/** The session secret of a well-formed cookie carrying OUR tag; anything else reads as "no session" without asking the API. */
export function readSessionCookie(req: Request, env: Env): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const m = VALUE.exec(part.slice(i + 1).trim());
      const want = m ? tag(m[1], env) : null;
      return m && want && timingSafeEqual(Buffer.from(want), Buffer.from(m[2])) ? m[1] : undefined;
    }
  }
  return undefined;
}

/** Set-Cookie for a new session, or null when no cookie can be tagged (no SERVICE_AUTH_SECRET: the BFF cannot reach the API anyway). */
export function sessionCookieHeader(secret: string, remember: boolean, secure: boolean, env: Env): string | null {
  const value = sessionCookieValue(secret, env);
  if (!value) return null;
  // without "remember", a browser-session cookie (the server-side session also ends after 12 h)
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${REMEMBER_S}` : ""}${secure ? "; Secure" : ""}`;
}
export const clearSessionCookieHeader = (secure: boolean) => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

/** The web switch for the unified owner login (not a secret). The owner code itself lives on the API only. */
export const ownerAuthOn = (env: Env) => env.OWNER_AUTH === "on";

/** Is owner login (and are passkeys) switched on in the API? Cached briefly; any failure reads as "off" (fail closed). */
export async function ownerAuthConfig(deps: OwnerDeps): Promise<AuthConfig> {
  if (!ownerAuthOn(deps.env)) return { owner_auth: false, passkeys: false, reachable: true };
  const now = deps.now();
  if (config && now - config.at < CONFIG_MS) return config.value;
  const r = await deps.callBackend({ path: "/internal/v1/auth/config", method: "POST", body: {}, env: deps.env, timeoutMs: 5_000, maxBytes: 4096 });
  const j = (r.kind === "ok" && r.status === 200 ? r.json : null) as Partial<AuthConfig> | null;
  const value = { owner_auth: j?.owner_auth === true, passkeys: j?.owner_auth === true && j?.passkeys === true, reachable: r.kind === "ok" };
  if (r.kind === "ok") config = { at: now, value }; // do not cache an outage
  return value;
}

/** The owner's account id when the request carries a valid owner session, else null. */
export async function ownerSessionAccount(req: Request, deps: OwnerDeps): Promise<string | null> {
  return (await checkOwnerSession(req, deps)).account;
}

/** Same lookup, telling "not signed in" apart from "the API could not be asked" (`outage`, never cached). */
export async function checkOwnerSession(req: Request, deps: OwnerDeps): Promise<{ account: string | null; outage: boolean }> {
  const secret = readSessionCookie(req, deps.env);
  if (!secret) return { account: null, outage: false };
  const key = digest(secret), now = deps.now();
  const hit = seen.get(key);
  if (hit && hit.until > now) { seen.delete(key); seen.set(key, hit); return { account: hit.account, outage: false }; } // most recently used last
  // a flood of lookups from one client reads as "cannot check now" (never as signed out, never cached)
  if (!lookups(clientIp(req), now)) return { account: null, outage: true };
  const r = await deps.callBackend({ path: "/internal/v1/auth/session", method: "POST", body: { session: secret }, env: deps.env, timeoutMs: 5_000, maxBytes: 4096 });
  if (r.kind !== "ok") return { account: null, outage: true }; // outage: not signed in, and not cached
  const account = r.status === 200 && typeof (r.json as { account_id?: unknown })?.account_id === "string" ? (r.json as { account_id: string }).account_id : null;
  seen.delete(key);
  seen.set(key, { until: now + SESSION_CACHE_MS, account });
  while (seen.size > CACHE_MAX) seen.delete(seen.keys().next().value as string); // evict the least recently used, never the whole cache
  return { account, outage: false };
}

/**
 * What a door needs: is it usable at all (`enabled`), and is this request the owner (`authenticated`)?
 * `legacy` = the door's own code gate (kept during the transition): `on` when configured, `ok` when its cookie is valid.
 * `ok` counts only while unified sign-in is off.
 */
export async function doorAccess(req: Request, deps: OwnerDeps, legacy: { on: boolean; ok: boolean }): Promise<{ enabled: boolean; authenticated: boolean; account: string | null; outage: boolean }> {
  const owner = ownerAuthOn(deps.env);
  // With unified sign-in on, the owner session is the ONLY credential: a per-door cookie issued before the switch no longer
  // opens anything, so signing out of the app really closes every door on this device.
  if (legacy.ok && !owner) return { enabled: true, authenticated: true, account: null, outage: false };
  // no session cookie → no lookup at all (an anonymous request, or a door that is off, never reaches the API)
  // `outage`: the session could not be checked (API/DB down) — a door answers "unavailable", never "signed out"
  const { account, outage } = owner && readSessionCookie(req, deps.env) ? await checkOwnerSession(req, deps) : { account: null, outage: false };
  return { enabled: legacy.on || owner, authenticated: account !== null, account, outage };
}
