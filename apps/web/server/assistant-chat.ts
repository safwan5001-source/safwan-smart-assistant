import "server-only";
/**
 * /api/assistant/* — the ONLY door from the chat UI to Claude.
 *
 *   browser ──owner cookie──▶ this handler ──HMAC-signed + acting account──▶ API (/internal/v1/assistant/*) ──server key──▶ Anthropic
 *
 * The browser never receives the Anthropic key, SERVICE_AUTH_SECRET, the account id or any upstream text: replies are rebuilt from a
 * whitelist. Spend limits are enforced durably in the API (PostgreSQL); the small per-process limiter here is only a first filter.
 */
import { callBackend as realCallBackend, streamBackend as realStreamBackend } from "./backend";
import { createLimiter } from "./notify/api";
import { createFailureLimiter, sameOrigin } from "./browser-chat/api";
import { doorAccess, ownerAuthOn } from "./owner-session";
import { handleAuth } from "./owner-auth";
import { COOKIE_NAME, COOKIE_PATH, codeMatches, issueCookieValue, readCookie, readGate, setCookieHeader, verifyCookieValue, type Env } from "./assistant-chat-gate";

export type Deps = { env: Env; callBackend: typeof realCallBackend; streamBackend: typeof realStreamBackend; now: () => number };
const defaultDeps = (): Deps => ({ env: process.env, callBackend: realCallBackend, streamBackend: realStreamBackend, now: Date.now });
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const err = (code: string, status: number) => json({ error: code }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 12_000, MAX_MESSAGE = 8000;
const limiters = { unlockFail: createFailureLimiter(5, 60_000), chat: createLimiter(30, 60_000), read: createLimiter(120, 60_000), write: createLimiter(30, 60_000) };
export const resetAssistantLimits = () => { limiters.unlockFail = createFailureLimiter(5, 60_000); limiters.chat = createLimiter(30, 60_000); limiters.read = createLimiter(120, 60_000); limiters.write = createLimiter(30, 60_000); };

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

const ownerAccount = (env: Env): string | null => { const a = (env.AI_OWNER_ACCOUNT_ID ?? "").trim().toLowerCase(); return UUID.test(a) && a !== "00000000-0000-0000-0000-000000000000" ? a : null; };
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown").slice(0, 64);

/** Fixed mapping of the API's failure codes to what the browser may learn. */
const CHAT_ERRORS: Record<string, [number, string]> = {
  rate_limited: [429, "rate_limited"], budget_daily: [429, "budget_daily"], budget_monthly: [429, "budget_monthly"],
  not_found: [404, "not_found"], conversation_full: [409, "conversation_full"], unknown_model: [422, "bad_request"], empty_message: [422, "bad_request"],
};

export async function handleAssistantChat(req: Request, path: string[], deps: Deps = defaultDeps()): Promise<Response> {
  const route = path.join("/");
  const gate = readGate(deps.env);
  const now = deps.now();
  const access = await doorAccess(req, deps, { on: !!gate, ok: !!gate && verifyCookieValue(gate, readCookie(req), now) }); // A1
  if (req.method === "GET" && route === "status") return json({ enabled: access.enabled, authenticated: access.authenticated });
  if (!access.enabled) return err("disabled", 503);

  if (route === "session") {
    if (ownerAuthOn(deps.env) && req.method === "POST") return handleAuth(req, ["login", "code"], { env: deps.env, callBackend: deps.callBackend, now: deps.now }); // A1
    if (!gate) return err("disabled", 503);
    if (!sameOrigin(req)) return err("forbidden", 403);
    if (req.method === "DELETE") return json({ authenticated: false }, 200, { "Set-Cookie": `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${deps.env.NODE_ENV === "production" ? "; Secure" : ""}` });
    if (req.method !== "POST") return err("not_found", 404);
    const ip = clientIp(req);
    if (limiters.unlockFail.blocked(ip, now)) return err("rate_limited", 429);
    const data = await readJson(req);
    if (!data) return err("bad_request", 400);
    if (!codeMatches(gate, data.code)) { limiters.unlockFail.fail(ip, now); return err("unauthorized", 401); }
    return json({ authenticated: true }, 200, { "Set-Cookie": setCookieHeader(issueCookieValue(gate, now), deps.env.NODE_ENV === "production") });
  }

  if (!access.authenticated) return err("unauthorized", 401);
  // the owner session carries the verified account; the legacy gate keeps using the configured owner account
  const account = access.account ?? ownerAccount(deps.env);
  if (!account) return err("disabled", 503);
  const write = req.method !== "GET";
  if (write && !sameOrigin(req)) return err("forbidden", 403);
  if (!(write ? limiters.write : limiters.read)("owner", now)) return err("rate_limited", 429);

  const unavailable = () => err("unavailable", 503);
  // plain JSON calls to the API: whitelist the shapes we pass on
  const relay = async (apiPath: string, method: "GET" | "POST", body?: unknown, max = 64 * 1024) => {
    const r = await deps.callBackend({ path: apiPath, method, body, account, env: deps.env, timeoutMs: 15_000, maxBytes: max });
    if (r.kind !== "ok") return unavailable();
    if (r.status === 404) return err("not_found", 404);
    if (r.status !== 200) return err(r.status === 422 ? "bad_request" : "unavailable", r.status === 422 ? 422 : 502);
    return json(r.json);
  };

  if (req.method === "GET" && route === "state") return relay("/internal/v1/assistant/state", "GET");
  if (req.method === "POST" && route === "probe") return relay("/internal/v1/assistant/probe", "POST", {});
  if (req.method === "POST" && route === "settings") {
    const data = await readJson(req);
    const model = data?.model;
    if (typeof model !== "string" || !model || model.length > 100) return err("bad_request", 400);
    return relay("/internal/v1/assistant/settings", "POST", { model });
  }
  if (req.method === "GET" && route === "conversations") return relay("/internal/v1/assistant/conversations", "GET", undefined, 256 * 1024);
  const conv = /^conversations\/([0-9a-f-]{36})$/.exec(route);
  if (conv && UUID.test(conv[1])) {
    if (req.method === "GET") return relay(`/internal/v1/assistant/conversations/${conv[1]}`, "GET", undefined, 1024 * 1024);
    if (req.method === "DELETE") return relay(`/internal/v1/assistant/conversations/${conv[1]}/delete`, "POST", {});
  }

  if (req.method === "POST" && route === "chat") {
    if (!limiters.chat("owner", now)) return err("rate_limited", 429);
    const data = await readJson(req);
    const cid = data?.conversationId, message = data?.message;
    if (typeof cid !== "string" || !UUID.test(cid) || typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return err("bad_request", 400);
    const r = await deps.streamBackend({ path: "/internal/v1/assistant/chat", body: { conversation_id: cid, message }, account, signal: req.signal, env: deps.env });
    if (r.kind === "stream") return new Response(r.body, { status: 200, headers: { "Cache-Control": "no-store, no-transform", "Content-Type": "application/x-ndjson; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" } });
    if (r.kind === "error") { const m = CHAT_ERRORS[r.code]; return m ? err(m[1], m[0]) : unavailable(); }
    return unavailable();
  }
  return err("not_found", 404);
}
