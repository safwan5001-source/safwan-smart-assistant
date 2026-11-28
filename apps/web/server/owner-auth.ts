import "server-only";
import { createHash } from "node:crypto";
/**
 * /api/auth/* — sign in to BASHT once, for the whole app (A1).
 *
 *   GET  status                       → { owner_auth, passkeys, authenticated, gate, unavailable, owner_scope? }  (`owner_scope`: only when authenticated)
 *                                        (gate = the web switch OWNER_AUTH; unavailable = the API could not be asked)
 *   POST login/code {code, remember}  → owner code → session cookie
 *   POST logout · POST logout-all     → this device · every device (DELETE also accepted: the doors' legacy "lock")
 *   GET  sessions · POST sessions/revoke {id}   (this account's live sessions, by device; end one)
 *   GET  passkeys · POST passkeys/delete {id} · POST passkeys/delete-all
 *   POST passkeys/register/options {code}|verify   (signed-in owner adds Face ID on this device; the owner code again = step-up)
 *   POST passkeys/login/options|verify      (Face ID → the same owner session)
 *
 * The browser never sees the owner code's value, the session secret (HttpOnly cookie) or the sealed WebAuthn challenge
 * (HttpOnly cookie scoped to /api/auth, 5 min). Every state change is same-origin only; code failures are throttled per client.
 */
import { callBackend as realCallBackend } from "./backend";
import { createFailureLimiter, sameOrigin } from "./browser-chat/api";
import { COOKIE_NAME as AI_COOKIE, COOKIE_PATH as AI_PATH } from "./assistant-chat-gate";
import { COOKIE_NAME as BC_COOKIE, COOKIE_PATH as BC_PATH } from "./browser-chat/gate";
import { deviceLabel } from "./device-label";
import { checkOwnerSession, clearSessionCookieHeader, forgetSession, ownerAuthConfig, ownerAuthOn, readSessionCookie, sessionCookieHeader, type OwnerDeps } from "./owner-session";
import { clientIp } from "./client-ip";

export type Deps = OwnerDeps;
const defaultDeps = (): Deps => ({ env: process.env, callBackend: realCallBackend, now: Date.now });
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const CHALLENGE_COOKIE = "safwan_wa", CHALLENGE_PATH = "/api/auth";
const MAX_BODY = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let fails = createFailureLimiter(5, 60_000);
export const resetAuthLimits = () => { fails = createFailureLimiter(5, 60_000); };

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const h = new Headers(HEADERS);
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
};
const err = (code: string, status: number, cookies: string[] = []) => json({ error: code }, status, cookies);
const secure = (deps: Deps) => deps.env.NODE_ENV === "production";
// the per-door cookies of the transition: expired on sign-out too (they no longer open anything while unified sign-in is on)
const LEGACY_COOKIES: [string, string][] = [[AI_COOKIE, AI_PATH], [BC_COOKIE, BC_PATH], ["safwan_basht", "/api/basht"]];
const expireLegacy = (deps: Deps) => LEGACY_COOKIES.map(([n, p]) => `${n}=; Path=${p}; Max-Age=0; HttpOnly; SameSite=Strict${secure(deps) ? "; Secure" : ""}`);
const challengeCookie = (v: string, deps: Deps, maxAge = 300) => `${CHALLENGE_COOKIE}=${v}; Path=${CHALLENGE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(deps) ? "; Secure" : ""}`;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  if ((req.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") return undefined;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { await reader.cancel().catch(() => {}); return undefined; }
    chunks.push(value);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

// The API answers owner-level refusals as 400 + a code (401/403/429 on the internal hop mean transport trouble — see backend.ts);
// here they become the browser-facing status. Unknown codes are a plain 400.
const REFUSALS: Record<string, [string, number]> = {
  unauthorized: ["unauthorized", 401], rate_limited: ["rate_limited", 429], owner_disabled: ["forbidden", 403],
  passkey_exists: ["exists", 409], not_found: ["not_found", 404],
  reauth_failed: ["wrong_code", 403], // step-up: a wrong code while signed in is NOT a sign-out (never 401)
};
const refusal = (json: unknown): [string, number] => {
  const code = (json as { detail?: { code?: unknown } } | null)?.detail?.code;
  return (typeof code === "string" && REFUSALS[code]) || ["bad_request", 400];
};

/**
 * An opaque, stable id of the signed-in owner for scoping this device's local data (the saved photo copies): the first 16 hex
 * characters of SHA-256 over the server-held account id, domain-separated. The account id itself is never sent. 64 bits is ample to
 * keep two owners' device data apart; it identifies nobody outside this server.
 */
export const ownerScopeOf = (account: string): string => createHash("sha256").update(`basht-owner-scope-v1:${account}`).digest("hex").slice(0, 16);

export async function handleAuth(req: Request, path: string[], deps: Deps = defaultDeps()): Promise<Response> {
  const route = path.join("/");
  const cfg = await ownerAuthConfig(deps);
  if (req.method === "GET" && route === "status") {
    const check = cfg.owner_auth ? await checkOwnerSession(req, deps) : { account: null, outage: false };
    // unavailable: the API (or its database) could not be asked — NOT "signed out"; clients must not send the owner to /login
    return json({ owner_auth: cfg.owner_auth, passkeys: cfg.passkeys, authenticated: check.account !== null, gate: ownerAuthOn(deps.env),
      unavailable: !cfg.reachable || check.outage,
      // only an authenticated owner learns it (an anonymous, locked or outage answer carries no scope)
      ...(check.account !== null ? { owner_scope: ownerScopeOf(check.account) } : {}) });
  }
  if (!cfg.owner_auth) return err("disabled", 503);
  if (req.method !== "GET" && !sameOrigin(req)) return err("forbidden", 403);

  const api = async (p: string, body: Record<string, unknown>) => {
    const r = await deps.callBackend({ path: `/internal/v1/auth/${p}`, method: "POST", body, env: deps.env, timeoutMs: 10_000, maxBytes: 64 * 1024 });
    if (r.kind !== "ok") return { ok: false as const, res: err("unavailable", 503) };
    if (r.status !== 200) { const [code, status] = r.status >= 400 && r.status < 500 ? refusal(r.json) : ["unavailable", 502]; return { ok: false as const, res: err(code, status) }; }
    return { ok: true as const, data: (r.json ?? {}) as Record<string, unknown> };
  };
  const signedIn = (data: Record<string, unknown>, remember: boolean, extra: string[] = []) => {
    const cookie = typeof data.session === "string" ? sessionCookieHeader(data.session, remember, secure(deps), deps.env) : null;
    return cookie ? json({ authenticated: true }, 200, [cookie, ...extra]) : err("unavailable", 502);
  };
  const session = readSessionCookie(req, deps.env);

  if (req.method === "POST" && route === "login/code") {
    const ip = clientIp(req), now = deps.now();
    if (fails.blocked(ip, now)) return err("rate_limited", 429);
    const data = await readJson(req);
    if (typeof data?.code !== "string" || !data.code || data.code.length > 256) return err("bad_request", 400);
    const remember = data.remember === true;
    const r = await api("login/code", { code: data.code, remember, device: deviceLabel(req.headers.get("user-agent")), client: ip });
    if (!r.ok) { if (r.res.status === 401) fails.fail(ip, now); return r.res; }
    return signedIn(r.data, remember);
  }
  if ((req.method === "POST" || req.method === "DELETE") && (route === "logout" || route === "logout-all")) {
    if (session) {
      const r = await api(route, { session });
      // a session the API no longer knows is already signed out; any other failure is reported and the cookie is KEPT,
      // so the owner can retry — never "signed out everywhere" while other devices are still in
      if (!r.ok && r.res.status !== 401) return r.res;
    }
    forgetSession(route === "logout" ? session : undefined); // logout-all: drop every cached session on this instance too
    return json({ authenticated: false }, 200, [clearSessionCookieHeader(secure(deps)), ...expireLegacy(deps)]);
  }

  // Face ID sign-in: no session yet
  if (req.method === "POST" && route === "passkeys/login/options") {
    if (!cfg.passkeys) return err("disabled", 503);
    const r = await api("passkeys/login/options", {});
    if (!r.ok) return r.res;
    return json({ options: r.data.options }, 200, [challengeCookie(String(r.data.challenge ?? ""), deps)]);
  }
  if (req.method === "POST" && route === "passkeys/login/verify") {
    if (!cfg.passkeys) return err("disabled", 503);
    const data = await readJson(req);
    const challenge = readCookie(req, CHALLENGE_COOKIE);
    if (!data || typeof data.credential !== "object" || !data.credential || !challenge) return err("bad_request", 400);
    const remember = data.remember === true;
    const r = await api("passkeys/login/verify", { challenge, credential: data.credential, remember, device: deviceLabel(req.headers.get("user-agent")) });
    const clear = challengeCookie("", deps, 0);
    if (!r.ok) return new Response(r.res.body, { status: r.res.status, headers: (() => { const h = new Headers(r.res.headers); h.append("Set-Cookie", clear); return h; })() });
    return signedIn(r.data, remember, [clear]);
  }

  // everything below belongs to a signed-in owner
  if (!session) return err("unauthorized", 401);
  const me = await checkOwnerSession(req, deps);
  if (me.account === null) return me.outage ? err("unavailable", 503) : err("unauthorized", 401);
  if (req.method === "GET" && route === "sessions") {
    const r = await api("sessions/list", { session });
    return r.ok ? json({ sessions: Array.isArray(r.data.sessions) ? r.data.sessions : [] }) : r.res;
  }
  if (req.method === "POST" && route === "sessions/revoke") {
    const data = await readJson(req);
    if (typeof data?.id !== "string" || !UUID.test(data.id)) return err("bad_request", 400);
    const r = await api("sessions/revoke", { session, id: data.id });
    if (!r.ok) return r.res;
    // the ended session is another device's: its secret is unknown here, so drop this instance's whole cache (review L2) —
    // the next request of that device is checked afresh (single owner: a handful of entries)
    forgetSession();
    // the API says whether the ended session was this device's own (no second lookup that could fail): then it is a sign-out
    if (r.data.current !== true) return json({ ok: true, signedOut: false });
    return json({ ok: true, signedOut: true }, 200, [clearSessionCookieHeader(secure(deps))]);
  }
  if (req.method === "GET" && route === "passkeys") {
    const r = await api("passkeys/list", { session });
    return r.ok ? json({ passkeys: Array.isArray(r.data.passkeys) ? r.data.passkeys : [] }) : r.res;
  }
  if (req.method === "POST" && route === "passkeys/delete") {
    const data = await readJson(req);
    if (typeof data?.id !== "string" || !UUID.test(data.id)) return err("bad_request", 400);
    const r = await api("passkeys/delete", { session, id: data.id });
    return r.ok ? json({ ok: true }) : r.res;
  }
  if (req.method === "POST" && route === "passkeys/delete-all") {
    const r = await api("passkeys/delete-all", { session });
    return r.ok ? json({ ok: true, removed: typeof r.data.removed === "number" ? r.data.removed : 0 }) : r.res;
  }
  if (req.method === "POST" && route === "passkeys/register/options") {
    if (!cfg.passkeys) return err("disabled", 503);
    // step-up (review M3): adding a lasting sign-in method needs the owner code again; throttled like the login
    const ip = clientIp(req), now = deps.now();
    if (fails.blocked(ip, now)) return err("rate_limited", 429);
    const data = await readJson(req);
    if (typeof data?.code !== "string" || !data.code || data.code.length > 256) return err("bad_request", 400);
    const r = await api("passkeys/register/options", { session, code: data.code, client: ip });
    if (!r.ok) { if (r.res.status === 403) fails.fail(ip, now); return r.res; }
    return json({ options: r.data.options }, 200, [challengeCookie(String(r.data.challenge ?? ""), deps)]);
  }
  if (req.method === "POST" && route === "passkeys/register/verify") {
    if (!cfg.passkeys) return err("disabled", 503);
    const data = await readJson(req);
    const challenge = readCookie(req, CHALLENGE_COOKIE);
    if (!data || typeof data.credential !== "object" || !data.credential || !challenge) return err("bad_request", 400);
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 60) : "هذا الجهاز";
    const r = await api("passkeys/register/verify", { session, challenge, credential: data.credential, name });
    return r.ok ? json({ ok: true }, 200, [challengeCookie("", deps, 0)]) : r.res;
  }
  return err("not_found", 404);
}
