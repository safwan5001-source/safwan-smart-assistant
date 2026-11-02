import "server-only";
/**
 * /api/browser/* — the ONLY door from the chat UI to the browser worker.
 *
 *   browser ──cookie──▶ this handler ──HMAC-signed──▶ API (/internal/v1/browser/tasks*) ──bearer──▶ worker ──▶ cloud browser
 *
 * The browser never receives (or can derive) SERVICE_AUTH_SECRET, BROWSER_SERVICE_TOKEN, the worker address, Browserbase identifiers or
 * connection URLs. Every reply is rebuilt from a whitelist; failures are fixed codes, never upstream text.
 * Same-origin only (Origin must match Host on every state-changing call), no CORS, no caching.
 */
import { callBackend as realCallBackend, type BackendResult } from "../backend";
import { createLimiter } from "../notify/api";
import { isAllowedBrowserUrl, isTaskId, parseActionRequest, parseTaskView } from "@/lib/browser-task";
import { readScopes, sessionResultOk, sessionStartUrl, sessionTargetOk, type Scope } from "./scopes";
import { COOKIE_NAME, COOKIE_PATH, codeMatches, issueCookieValue, readCookie, readGate, setCookieHeader, verifyCookieValue, type Env } from "./gate";

const BASE = "/internal/v1/browser/tasks";
const MAX_BODY = 2048;
const CONFLICTS = new Set(["action_in_progress", "limit_reached", "not_ready", "session_ended", "not_interactive", "no_pending_approval", "busy"]);
const MAX_JPEG = 260_000;

export type Deps = { env: Env; callBackend: typeof realCallBackend; now: () => number };
const defaultDeps = (): Deps => ({ env: process.env, callBackend: realCallBackend, now: Date.now });

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const err = (code: string, status: number, extra: Record<string, string> = {}) => json({ error: code }, status, extra);

/** Counts only FAILED attempts per key. A correct code is never throttled by other people's failures (review F3: no owner lock-out). */
export function createFailureLimiter(max: number, windowMs: number, cap = 10_000) {
  const fails = new Map<string, { n: number; reset: number }>();
  return {
    blocked: (id: string, now: number) => { const f = fails.get(id); return !!f && f.reset > now && f.n >= max; },
    fail: (id: string, now: number) => {
      const f = fails.get(id);
      if (!f || f.reset <= now) {
        if (fails.size >= cap) { for (const [k, v] of fails) if (v.reset <= now) fails.delete(k); if (fails.size >= cap) fails.clear(); }
        fails.set(id, { n: 1, reset: now + windowMs });
      } else f.n++;
    },
  };
}

// per-process limiters (this feature is single-owner; a shared store would be overkill)
const limiters = {
  unlockFail: createFailureLimiter(5, 60_000),
  create: createLimiter(6, 60_000), poll: createLimiter(240, 60_000), cancel: createLimiter(20, 60_000),
  act: createLimiter(40, 60_000), decide: createLimiter(30, 60_000),
};
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown").slice(0, 64);

/** State-changing calls must come from our own page: Origin present and equal to Host (a cross-site form/fetch cannot forge Origin). */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

async function readJson(req: Request): Promise<unknown | undefined> {
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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

/** Fixed mapping from what the API answered to what the browser may learn. */
function upstreamError(r: BackendResult): Response | null {
  if (r.kind === "ok") return null;
  if (r.kind === "unconfigured") return err("unavailable", 503);
  if (r.kind === "unavailable" && r.status === 503) return err("unavailable", 503);   // API says it cannot serve (flag off, worker not configured)
  return err("unavailable", 502);                                                    // incl. "rejected": a signature problem is OUR misconfiguration
}

function taskReply(r: BackendResult, okStatus: number, scopes: Scope[] = []): Response {
  const bad = upstreamError(r);
  if (bad) return bad;
  const ok = r as Extract<BackendResult, { kind: "ok" }>;
  if (ok.status === okStatus || ok.status === 200) {
    // an interactive view is accepted only when WE also have a scope configured, and only for URLs inside it
    const task = parseTaskView((ok.json as { task?: unknown } | null)?.task, { sessionUrlOk: (u) => scopes.length > 0 && sessionResultOk(u, scopes) });
    return task ? json({ task }, okStatus === 202 ? 202 : 200) : err("unavailable", 502);
  }
  const detail = (ok.json as { detail?: { code?: unknown } } | null)?.detail?.code;
  switch (ok.status) {
    case 404: return err("not_found", 404);
    case 409: return err(typeof detail === "string" && CONFLICTS.has(detail) ? detail : "conflict", 409);
    case 400: return err(detail === "url_not_allowed" ? "url_not_allowed" : "bad_request", 400);
    default: return err("unavailable", 502);
  }
}

/** The pending step is decided by the user's click on THIS card only: no body, a bounded step number, the same Origin/cookie checks as every other write. */
const stepNumber = (v: string | undefined) => (v !== undefined && /^[1-9][0-9]?$/.test(v) && Number(v) <= 20 ? Number(v) : null);

export async function handleBrowserChat(req: Request, path: string[], deps: Deps = defaultDeps()): Promise<Response> {
  const method = req.method.toUpperCase();
  const route = `${method} /${path.join("/")}`;
  const now = deps.now();
  const gate = readGate(deps.env);
  const secure = deps.env.NODE_ENV === "production";
  try {
    const scopes = readScopes(deps.env);
    if (route === "GET /status") {
      const authenticated = !!gate && verifyCookieValue(gate, readCookie(req), now);
      // the lab address is shown only to the signed-in owner
      return json({ enabled: !!gate, authenticated, interactive: { enabled: !!gate && scopes.length > 0, ...(authenticated && scopes.length ? { startUrl: sessionStartUrl(scopes) } : {}) } });
    }
    if (!gate) return err("disabled", 503);                               // feature off: nothing below is reachable

    if (route === "POST /session") {
      if (!sameOrigin(req)) return err("forbidden", 403);
      const ip = clientIp(req);
      const body = (await readJson(req)) as { code?: unknown } | undefined;
      if (!body || typeof body !== "object") return err("bad_request", 400);
      // Only failures count, and only against the caller's own key: the right code is always honoured, an anonymous caller (who can
      // forge X-Forwarded-For) can burn nothing but its own budget. The code is 32+ high-entropy characters, so guessing is infeasible.
      if (!codeMatches(gate, body.code)) {
        if (limiters.unlockFail.blocked(ip, now)) return err("rate_limited", 429);
        limiters.unlockFail.fail(ip, now);
        return err("unauthorized", 401);                                   // same answer for every wrong input
      }
      return json({ authenticated: true }, 200, { "Set-Cookie": setCookieHeader(issueCookieValue(gate, now), secure) });
    }
    if (route === "DELETE /session") {
      if (!sameOrigin(req)) return err("forbidden", 403);
      return json({ authenticated: false }, 200, { "Set-Cookie": `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}` });
    }

    // everything below needs a valid owner cookie
    if (!verifyCookieValue(gate, readCookie(req), now)) return err("unauthorized", 401);
    const id = path[1];

    if (route === "POST /tasks") {
      if (!sameOrigin(req)) return err("forbidden", 403);
      if (!limiters.create("owner", now)) return err("rate_limited", 429);
      const body = (await readJson(req)) as { url?: unknown; approved?: unknown; mode?: unknown } | undefined;
      if (!body || typeof body !== "object") return err("bad_request", 400);
      // Explicit, per-run approval: the UI sets this only after the user presses «تشغيل» on a card that shows the exact address.
      if (body.approved !== true) return err("approval_required", 400);
      if (body.mode === "interactive") {
        if (!scopes.length) return err("interactive_disabled", 503);       // no lab scope here: interactive control is OFF
        const url = body.url === undefined ? sessionStartUrl(scopes) : body.url;
        if (!sessionTargetOk(url, scopes)) return err("url_not_allowed", 400);
        return taskReply(await deps.callBackend({ path: BASE, method: "POST", body: { url, mode: "interactive" }, timeoutMs: 12_000, env: deps.env }), 202, scopes);
      }
      if (body.mode !== undefined) return err("bad_request", 400);
      if (!isAllowedBrowserUrl(body.url)) return err("url_not_allowed", 400);
      return taskReply(await deps.callBackend({ path: BASE, method: "POST", body: { url: body.url }, timeoutMs: 12_000, env: deps.env }), 202);
    }
    if (path[0] === "tasks" && id !== undefined) {
      if (!isTaskId(id)) return err("not_found", 404);
      if (route === `GET /tasks/${id}`) {
        if (!limiters.poll("owner", now)) return err("rate_limited", 429);
        return taskReply(await deps.callBackend({ path: `${BASE}/${id}`, timeoutMs: 6_000, env: deps.env }), 200, scopes);
      }
      // ── interactive control: every route below needs the owner cookie, a same-origin write, a rate limit and a configured scope ──
      if (route === `POST /tasks/${id}/actions`) {
        if (!sameOrigin(req)) return err("forbidden", 403);
        if (!scopes.length) return err("interactive_disabled", 503);
        if (!limiters.act("owner", now)) return err("rate_limited", 429);
        const action = parseActionRequest(await readJson(req), (u) => sessionTargetOk(u, scopes));
        if (!action) return err("bad_request", 400);
        // Rebuilt from validated fields; the typed text goes on to the worker and is never logged or echoed by this tier.
        return taskReply(await deps.callBackend({ path: `${BASE}/${id}/actions`, method: "POST", body: action, timeoutMs: 12_000, env: deps.env }), 202, scopes);
      }
      const decision = /^(approve|reject)$/.exec(path[4] ?? "");
      if (path[2] === "actions" && decision && path.length === 5 && method === "POST") {
        if (!sameOrigin(req)) return err("forbidden", 403);
        if (!scopes.length) return err("interactive_disabled", 503);
        const seq = stepNumber(path[3]);
        if (seq === null) return err("not_found", 404);
        if (!limiters.decide("owner", now)) return err("rate_limited", 429);
        return taskReply(await deps.callBackend({ path: `${BASE}/${id}/actions/${seq}/${decision[1]}`, method: "POST", body: {}, timeoutMs: 12_000, env: deps.env }), 200, scopes);
      }
      if (route === `POST /tasks/${id}/finish`) {
        if (!sameOrigin(req)) return err("forbidden", 403);
        if (!scopes.length) return err("interactive_disabled", 503);
        if (!limiters.cancel("owner", now)) return err("rate_limited", 429);
        return taskReply(await deps.callBackend({ path: `${BASE}/${id}/finish`, method: "POST", body: {}, timeoutMs: 12_000, env: deps.env }), 200, scopes);
      }
      if (route === `POST /tasks/${id}/cancel`) {
        if (!sameOrigin(req)) return err("forbidden", 403);
        if (!limiters.cancel("owner", now)) return err("rate_limited", 429);
        return taskReply(await deps.callBackend({ path: `${BASE}/${id}/cancel`, method: "POST", body: {}, timeoutMs: 12_000, env: deps.env }), 200, scopes);
      }
      if (route === `GET /tasks/${id}/screenshot`) {
        if (!limiters.poll("owner", now)) return err("rate_limited", 429);
        const r = await deps.callBackend({ path: `${BASE}/${id}/screenshot`, timeoutMs: 12_000, maxBytes: 400_000, env: deps.env });
        const bad = upstreamError(r);
        if (bad) return bad;
        const ok = r as Extract<BackendResult, { kind: "ok" }>;
        if (ok.status === 404) return err("not_found", 404);
        const j = ok.json as { mimeType?: unknown; base64?: unknown } | null;
        if (ok.status !== 200 || j?.mimeType !== "image/jpeg" || typeof j.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(j.base64)) return err("unavailable", 502);
        const bytes = Buffer.from(j.base64, "base64");
        if (bytes.length < 4 || bytes.length > MAX_JPEG || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return err("unavailable", 502);
        return new Response(new Uint8Array(bytes), { status: 200, headers: {
          "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox",
        } });
      }
    }
    return err("not_found", 404);
  } catch {
    return err("server_error", 500);
  }
}

/** Test seam: forget rate-limit history. */
export function resetBrowserChatLimits() {
  limiters.unlockFail = createFailureLimiter(5, 60_000);
  limiters.create = createLimiter(6, 60_000); limiters.poll = createLimiter(240, 60_000); limiters.cancel = createLimiter(20, 60_000);
  limiters.act = createLimiter(40, 60_000); limiters.decide = createLimiter(30, 60_000);
}
