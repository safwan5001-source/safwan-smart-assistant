import "server-only";
/**
 * /api/basht/* — the ONLY door from the app to the real BASHT (the OpenClaw engine). BASHT Core Integration C2 + C4.
 *
 *   browser ──owner cookie──▶ this handler ──HMAC-signed──▶ API (/internal/v1/basht/*) ──BASHT_APP_TOKEN──▶ engine /app/v1/*
 *
 * A turn sent from here is an OWNER turn of BASHT (same agent, memory, tools and approval rules as the owner everywhere else), so the
 * door has its own owner gate: BASHT_CHAT_ACCESS_CODE (32+ chars, WEB service only) → signed HttpOnly SameSite=Strict cookie scoped to
 * /api/basht, 8 hours. It reuses the HMAC cookie primitives of the Claude gate with its own domain-separated key, so neither cookie
 * opens the other door. The browser never sees an engine credential, an account id or upstream error text.
 *
 * Voice (V2/V3): POST speak {text} → BASHT's reply spoken in its OWN voice (the engine's agent tts config), streamed back as audio;
 * POST transcribe <raw audio> → the engine's transcript. Same owner gate, same-origin check and bounded bodies; no provider key here.
 * Failures carry an optional allowlisted `reason`; GET voice-status answers a fixed `{speak, reason?, features}` shape (`{speak:"unknown"}` on any failure).
 */
import { hkdfSync } from "node:crypto";
import { callBackend as realCallBackend, streamBackend as realStreamBackend } from "./backend";
import { createLimiter } from "./notify/api";
import { createFailureLimiter, sameOrigin } from "./browser-chat/api";
import { doorAccess, ownerAuthOn } from "./owner-session";
import { handleAuth } from "./owner-auth";
import { DECIDE_CODES, handleBashtLive } from "./basht-live";
import { MEDIA_CODES, handleBashtExtras } from "./basht-extras";
import { handleBashtControl } from "./basht-control";
import { MIN_CODE_CHARS, MIN_DISTINCT_CHARS, COOKIE_TTL_S, codeMatches, issueCookieValue, readCookie, verifyCookieValue, type Env, type Gate } from "./assistant-chat-gate";
import { clientIp } from "./client-ip";

export const BASHT_COOKIE = "safwan_basht";
export const BASHT_COOKIE_PATH = "/api/basht";
export type Deps = { env: Env; callBackend: typeof realCallBackend; streamBackend?: typeof realStreamBackend; now: () => number };
const defaultDeps = (): Deps => ({ env: process.env, callBackend: realCallBackend, streamBackend: realStreamBackend, now: Date.now });

export function readBashtGate(env: Env): Gate | null {
  const code = env.BASHT_CHAT_ACCESS_CODE;
  if (!code || Buffer.byteLength(code, "utf8") < MIN_CODE_CHARS || new Set(code).size < MIN_DISTINCT_CHARS) return null;
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), Buffer.from("safwan-basht-chat"), Buffer.from("cookie-v1"), 32));
  return { key, code: Buffer.from(code, "utf8") };
}
const cookie = (value: string, secure: boolean, maxAge = COOKIE_TTL_S) =>
  `${BASHT_COOKIE}=${value}; Path=${BASHT_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const err = (code: string, status: number) => json({ error: code }, status);
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^agent:[a-z0-9_-]{1,64}:\S{1,200}$/i;
const MSG_ID = /^[A-Za-z0-9_-]{6,100}$/;
const CURSOR = /^[A-Za-z0-9_-]{6,100}(?:\.[A-Za-z0-9_-]{6,100})?$/;
// 8000 UTF-16 units can need up to 6 bytes each once JSON-escaped (\u00XX); Arabic needs 2. 64 KiB covers both, still bounded.
const MAX_MESSAGE = 8000, MAX_BODY = 64 * 1024;

// Voice: one spoken chunk ≤ 1500 chars (the client splits longer replies); one voice note ≤ 10 MiB (≈ 3 minutes, enforced by the client too).
export const MAX_SPEAK_CHARS = 1500, MAX_AUDIO_BYTES = 10 * 1024 * 1024, MIN_AUDIO_BYTES = 1024;
const AUDIO_TYPES = new Set(["audio/ogg", "audio/webm", "audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"]);
const SPEECH_TYPES = new Set(["audio/mpeg", "audio/ogg", "audio/wav"]);
/** Voice refusals the browser may see as they are (fixed list): the UI explains them and falls back to dictation. */
const VOICE_CODES: Record<string, number> = { voice_unavailable: 503, no_speech: 422, too_large: 413, unsupported_audio: 415, rate_limited: 429, bad_request: 400 };

// Polling a live reply costs ~40 reads a minute; writes are rarer. Voice has its own budget (a live voice turn = one transcription,
// one send, and one spoken chunk per ~1500 characters). The API and the engine limit again on their side.
const newLimiters = () => ({ unlockFail: createFailureLimiter(5, 60_000), read: createLimiter(240, 60_000), write: createLimiter(30, 60_000), voice: createLimiter(60, 60_000) });
let limiters = newLimiters();
export const resetBashtLimits = () => { limiters = newLimiters(); };

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  if ((req.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") return undefined;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { // bounded while reading: an oversized body is cut off, never buffered whole
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { await reader.cancel().catch(() => {}); return undefined; }
    chunks.push(value);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}
/** A raw body, bounded while reading (never buffered whole beyond `max`). null = empty/unreadable, "too_large" = over `max`. */
async function readBytes(req: Request, max: number): Promise<Uint8Array | null | "too_large"> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return "too_large";
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return "too_large"; }
    chunks.push(value);
  }
  return total ? new Uint8Array(Buffer.concat(chunks)) : null;
}
/** Why the engine's voice failed (fixed list, additive to the code). Anything else is dropped; engine/API free text never reaches the browser. */
export const VOICE_REASONS = ["identity_mismatch", "tool_denied", "unconfigured", "provider_error", "link_down", "timeout"] as const;
const voiceReason = (reason: unknown): (typeof VOICE_REASONS)[number] | undefined => (VOICE_REASONS as readonly unknown[]).includes(reason) ? (reason as (typeof VOICE_REASONS)[number]) : undefined;
/** `{ error: <code>, reason?: <allowlisted reason> }` with the status of the code (unknown codes: 503 unavailable, as before). */
const voiceErr = (code: unknown, reason?: unknown) => {
  const r = voiceReason(reason);
  const known = typeof code === "string" && Object.hasOwn(VOICE_CODES, code);
  return json({ error: known ? code : "unavailable", ...(r ? { reason: r } : {}) }, known ? VOICE_CODES[code] : 503);
};

/** GET voice-status: the one fixed shape the browser may see. Anything unexpected is `{ speak: "unknown" }` (never an error to the UI). */
export const VOICE_SPEAK_STATES = ["ready", "degraded", "unconfigured", "mismatch", "unknown"] as const;
export const VOICE_FEATURES = ["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1"] as const;
export function voiceStatusView(j: unknown): { speak: string; reason?: string; features?: string[] } {
  const o = (j && typeof j === "object" ? j : {}) as { speak?: unknown; reason?: unknown; features?: unknown };
  if (!(VOICE_SPEAK_STATES as readonly unknown[]).includes(o.speak)) return { speak: "unknown" };
  const reason = voiceReason(o.reason);
  const feats = Array.isArray(o.features) ? o.features : [];
  return { speak: o.speak as string, ...(reason ? { reason } : {}), features: VOICE_FEATURES.filter((f) => feats.includes(f)) };
}

/** Model-control refusals the browser may see as they are (a fixed list; never upstream text). */
const MODEL_CODES = new Set(["unknown_model", "model_unavailable", "model_not_selectable", "unsupported_level", "fast_mode_unsupported", "rejected", "model_control_unavailable"]);
/** Settings writes wait their turn on the engine (one at a time across devices) and spawn its CLI: give them time. */
const SETTINGS_MS = 45_000;
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const LEVEL = /^[a-z][a-z0-9_-]{0,39}$/;

/** What the browser may learn from the API's status codes. */
const API_ERRORS: Record<number, [number, string]> = { 400: [400, "bad_request"], 404: [404, "not_found"], 409: [409, "busy"], 422: [400, "bad_request"], 429: [429, "rate_limited"], 503: [503, "unavailable"] };

export async function handleBashtChat(req: Request, path: string[], deps: Deps = defaultDeps()): Promise<Response> {
  const route = path.join("/");
  const gate = readBashtGate(deps.env);
  const now = deps.now();
  // A1: the unified owner session opens this door too; the legacy BASHT code keeps working during the transition
  const access = await doorAccess(req, deps, { on: !!gate, ok: !!gate && verifyCookieValue(gate, readCookie(req, BASHT_COOKIE), now) });
  // a session that could not be checked (API/DB down) is "unavailable" (clients show offline), never "signed out"
  if (req.method === "GET" && route === "status") return access.outage ? err("unavailable", 503) : json({ enabled: access.enabled, authenticated: access.authenticated });
  if (!access.enabled) return err("disabled", 503);

  if (route === "session") {
    // A1: with the unified login on, this unlock signs in to the WHOLE app (one owner session, one code)
    if (ownerAuthOn(deps.env) && req.method === "POST") return handleAuth(req, ["login", "code"], deps);
    if (ownerAuthOn(deps.env) && req.method === "DELETE") return handleAuth(req, ["logout"], deps); // "lock" = sign out of the app on this device
    if (!gate) return err("disabled", 503); // the legacy code unlock exists only while that code is configured
    if (!sameOrigin(req)) return err("forbidden", 403);
    const secure = deps.env.NODE_ENV === "production";
    if (req.method === "DELETE") return json({ authenticated: false }, 200, { "Set-Cookie": cookie("", secure, 0) });
    if (req.method !== "POST") return err("not_found", 404);
    const ip = clientIp(req);
    if (limiters.unlockFail.blocked(ip, now)) return err("rate_limited", 429);
    const data = await readJson(req);
    if (!data) return err("bad_request", 400);
    if (!codeMatches(gate, data.code)) { limiters.unlockFail.fail(ip, now); return err("unauthorized", 401); }
    return json({ authenticated: true }, 200, { "Set-Cookie": cookie(issueCookieValue(gate, now), secure) });
  }

  if (!access.authenticated) return access.outage ? err("unavailable", 503) : err("unauthorized", 401); // an unverifiable session is an outage, not a sign-out
  const write = req.method !== "GET";
  if (write && !sameOrigin(req)) return err("forbidden", 403);
  const voice = route === "speak" || route === "transcribe";
  if (!(voice ? limiters.voice : write ? limiters.write : limiters.read)("owner", now)) return err("rate_limited", 429);

  const relay = async (apiPath: string, method: "GET" | "POST", body?: unknown, pick?: (j: Record<string, unknown>) => unknown, timeoutMs = 15_000) => {
    // 512 KiB is callBackend's hard ceiling; history pages are kept well under it (the engine also caps one page at 80 KiB)
    const r = await deps.callBackend({ path: apiPath, method, body, env: deps.env, timeoutMs, maxBytes: 512 * 1024 });
    if (r.kind !== "ok") return err("unavailable", 503);
    if (r.status !== 200) {
      const code = (r.json as { detail?: { code?: unknown } } | null)?.detail?.code;
      if (r.status === 400 && typeof code === "string" && (MODEL_CODES.has(code) || DECIDE_CODES.has(code) || MEDIA_CODES.has(code))) return err(code, 400);
      const m = API_ERRORS[r.status]; return m ? err(m[1], m[0]) : err("unavailable", 502);
    }
    const j = (r.json ?? {}) as Record<string, unknown>;
    return json(pick ? pick(j) : j);
  };

  // B1/B2: photos on a turn, files out, «محادثة جديدة», search (server/basht-extras.ts)
  const extra = await handleBashtExtras(req, route, { relay, deps });
  if (extra) return extra;
  if (req.method === "GET" && route === "voice-status") {
    // can BASHT speak right now? Same owner session as every read; any failure on the way reads as "unknown", never as an error
    const r = await deps.callBackend({ path: "/internal/v1/basht/voice-status", method: "GET", env: deps.env, timeoutMs: 8_000 });
    return json(r.kind === "ok" && r.status === 200 ? voiceStatusView(r.json) : { speak: "unknown" });
  }
  if (req.method === "GET" && route === "sessions") return relay("/internal/v1/basht/sessions", "GET", undefined, (j) => ({ sessions: Array.isArray(j.sessions) ? j.sessions : [] }));
  if (req.method === "GET" && route === "history") {
    const u = new URL(req.url);
    const key = u.searchParams.get("key") ?? "";
    const offset = u.searchParams.get("offset");
    // B1: earlier rows by cursor (also across «محادثة جديدة») or a window around one message (a search hit); ids only
    const before = u.searchParams.get("before"); const around = u.searchParams.get("around");
    if (!KEY.test(key) || (offset !== null && !/^\d{1,7}$/.test(offset))) return err("bad_request", 400);
    if ((before !== null && !CURSOR.test(before)) || (around !== null && !MSG_ID.test(around))) return err("bad_request", 400);
    // fixed path + JSON body: callBackend never takes a query string (server/backend.ts)
    return relay("/internal/v1/basht/history", "POST", { key, limit: 50, ...(offset !== null ? { offset: Number(offset) } : {}),
      ...(before !== null ? { before } : around !== null ? { around } : {}) }, undefined, before !== null || around !== null ? 35_000 : 15_000);
  }
  if (req.method === "POST" && route === "send") {
    const data = await readJson(req);
    const message = data?.message;
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return err("bad_request", 400);
    return relay("/internal/v1/basht/send", "POST", { message }, (j) => ({ runId: j.run_id }));
  }
  // Model control (M): read what the engine offers; change it for the app conversation only
  if (req.method === "GET" && route === "models") return relay("/internal/v1/basht/models", "GET");
  if (req.method === "GET" && route === "model") return relay("/internal/v1/basht/model", "GET");
  if (req.method === "POST" && (route === "model" || route === "thinking" || route === "fast")) {
    const data = await readJson(req);
    if (route === "model") {
      const model = typeof data?.model === "string" ? data.model.trim() : "";
      if (model !== "default" && !MODEL_REF.test(model)) return err("bad_request", 400);
      return relay("/internal/v1/basht/model", "POST", { model }, undefined, SETTINGS_MS);
    }
    if (route === "thinking") {
      const level = typeof data?.level === "string" ? data.level.trim() : "";
      if (!LEVEL.test(level)) return err("bad_request", 400);
      return relay("/internal/v1/basht/thinking", "POST", { level }, undefined, SETTINGS_MS);
    }
    const mode = data?.mode;
    if (mode !== "on" && mode !== "off" && mode !== "default") return err("bad_request", 400);
    return relay("/internal/v1/basht/fast", "POST", { mode }, undefined, SETTINGS_MS);
  }
  // Voice (V2): one chunk of a reply spoken in BASHT's own voice. Only the text goes out; the audio streams back as it arrives.
  if (req.method === "POST" && route === "speak") {
    const data = await readJson(req);
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text || text.length > MAX_SPEAK_CHARS) return err("bad_request", 400);
    const r = await (deps.streamBackend ?? realStreamBackend)({ path: "/internal/v1/basht/speak", body: { text }, accept: "audio/*, application/json",
      signal: req.signal, timeoutMs: 80_000, maxBytes: 4 * 1024 * 1024, env: deps.env });
    if (r.kind === "stream") {
      if (!SPEECH_TYPES.has(r.contentType)) { await r.body.cancel().catch(() => {}); return err("unavailable", 502); }
      return new Response(r.body, { status: 200, headers: { "Content-Type": r.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return r.kind === "error" ? voiceErr(r.code, r.reason) : err("unavailable", 503);
  }
  // Voice (V3): a voice note → the engine's transcript (its own audio config). The raw audio is passed through, never kept.
  if (req.method === "POST" && route === "transcribe") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type)) return err("unsupported_audio", 415);
    const bytes = await readBytes(req, MAX_AUDIO_BYTES);
    if (bytes === "too_large") return err("too_large", 413);
    if (!bytes || bytes.byteLength < MIN_AUDIO_BYTES) return err("no_speech", 422);
    const r = await deps.callBackend({ path: "/internal/v1/basht/transcribe", method: "POST", rawBody: { bytes, type }, env: deps.env, timeoutMs: 110_000, maxBytes: 64 * 1024 });
    if (r.kind !== "ok") return err("unavailable", 503);
    if (r.status !== 200) { const d = (r.json as { detail?: { code?: unknown; reason?: unknown } } | null)?.detail; return voiceErr(d?.code, d?.reason); }
    const text = (r.json as { text?: unknown } | null)?.text;
    return typeof text === "string" && text.trim() ? json({ text: text.trim().slice(0, MAX_MESSAGE) }) : err("no_speech", 422);
  }
  // B5–B7: BASHT's scheduled tasks, usage, memory (read-only) and capabilities — same gate and limits (server/basht-control.ts)
  const control = await handleBashtControl(req, route, deps);
  if (control) return control;
  const run = /^runs\/([0-9a-f-]{36})(\/stop)?$/.exec(route);
  if (run && RUN.test(run[1])) {
    if (req.method === "GET" && !run[2]) return relay(`/internal/v1/basht/runs/${run[1]}`, "GET", undefined, (j) => ({ status: j.status, text: typeof j.text === "string" ? j.text : "", failed: j.failed === true,
      firstTokenMs: typeof j.first_token_ms === "number" ? j.first_token_ms : null, totalMs: typeof j.total_ms === "number" ? j.total_ms : null,
      steps: Array.isArray(j.steps) ? j.steps : [] }));
    if (req.method === "POST" && run[2]) return relay(`/internal/v1/basht/runs/${run[1]}/stop`, "POST", {});
  }
  // B3/B4: approvals and the push link (server/basht-live.ts), behind the same gate, origin check and limiters as above
  const live = await handleBashtLive(req, route, { relay, readJson });
  if (live) return live;
  return err("not_found", 404);
}
