import "server-only";
import { signedHeaders } from "./service-signature";

/**
 * The ONLY way the web tier talks to the API. Fail-closed by design:
 *  - no BACKEND_URL / weak SERVICE_AUTH_SECRET  -> "unconfigured" (no request is sent, nothing is guessed)
 *  - the path is fixed to /internal/v1/* and never derived from a browser request
 *  - redirects are never followed; responses are size-capped; every call has a timeout
 *  - the secret is read per call, never logged, never returned
 */
export type BackendResult =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "unconfigured" }
  | { kind: "unreachable" }
  | { kind: "rejected"; status: number }      // the API refused our signature (misconfigured secret, clock skew, replay)
  | { kind: "unavailable"; status: number }   // the API itself reports it cannot serve (e.g. no database)
  | { kind: "invalid_response" };

export type Env = Record<string, string | undefined>;
export const MIN_SECRET_BYTES = 32;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Hard ceiling for callers that raise the per-call limit (e.g. a base64 JPEG): never unbounded. */
export const MAX_RESPONSE_BYTES_CEILING = 512 * 1024;
const PATH = /^\/internal\/v1\/[a-z0-9][a-z0-9/_-]*$/;

export function readConfig(env: Env = process.env): { base: URL; secret: string } | null {
  const raw = env.BACKEND_URL, secret = env.SERVICE_AUTH_SECRET;
  if (!raw || !secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) return null;
  let base: URL;
  try { base = new URL(raw); } catch { return null; }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) return null;
  return { base, secret };
}

/**
 * Reads the body incrementally, counting BYTES, and cancels the stream the moment `max` is exceeded, so an oversized or
 * endless upstream reply is never buffered whole (`res.text()` would) and `text.length` (UTF-16 units) is never trusted.
 * Returns null when over the cap. (Hardening carried over from the Phase 2 review of the unsigned probe.)
 */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await discard(res); return null; }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** Never leave an unread upstream body (and its connection) behind on an early return. */
const discard = (res: Response): Promise<void> => (res.body ? res.body.cancel().catch(() => {}) : Promise.resolve());

export type CallOptions = {
  path: string; method?: "GET" | "POST"; body?: unknown; account?: string | null;
  /** Raw bytes instead of a JSON body (a BASHT voice note): sent as-is with its own content type, signed over the same bytes. */
  rawBody?: { bytes: Uint8Array; type: string };
  timeoutMs?: number; maxBytes?: number; env?: Env; fetchImpl?: typeof fetch; now?: () => number;
};
/** Content types a raw body may carry (the voice note's MIME type, no parameters). */
const RAW_TYPE = /^audio\/[a-z0-9.+-]{1,40}$/;

export async function callBackend(opts: CallOptions): Promise<BackendResult> {
  const cfg = readConfig(opts.env);
  if (!cfg) return { kind: "unconfigured" };
  if (!PATH.test(opts.path)) throw new Error("backend path must be a fixed /internal/v1/* route");
  if (opts.rawBody && !RAW_TYPE.test(opts.rawBody.type)) throw new Error("raw body must carry an audio/* type");
  const method = opts.method ?? "GET";
  const body: string | Uint8Array = opts.rawBody ? opts.rawBody.bytes : opts.body === undefined ? "" : JSON.stringify(opts.body);
  // Append (never "resolve"): a base such as https://host/svc must keep its /svc prefix.
  const url = new URL(cfg.base.href.replace(/\/+$/, "") + opts.path);
  const target = url.pathname + url.search;
  const contentType = opts.rawBody ? opts.rawBody.type : "application/json";
  const headers = { accept: "application/json", ...(body.length ? { "content-type": contentType } : {}),
    ...signedHeaders(cfg.secret, { method, target, body, account: opts.account, now: opts.now }) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { method, headers, body: body.length ? (body as BodyInit) : undefined, redirect: "manual", cache: "no-store", signal: ctl.signal });
    if (res.status >= 300 && res.status < 400) { await discard(res); return { kind: "rejected", status: res.status }; }
    if (res.status === 401 || res.status === 403) { await discard(res); return { kind: "rejected", status: res.status }; }
    if (res.status >= 500 || res.status === 429) { await discard(res); return { kind: "unavailable", status: res.status }; }
    const text = await readCapped(res, Math.min(Math.max(opts.maxBytes ?? MAX_RESPONSE_BYTES, 1), MAX_RESPONSE_BYTES_CEILING));
    if (text === null) return { kind: "invalid_response" };
    try { return { kind: "ok", status: res.status, json: text ? JSON.parse(text) : null }; } catch { return { kind: "invalid_response" }; }
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
    ctl.abort(); // no-op once the body is fully read; otherwise tears down whatever is still streaming
  }
}

/**
 * Streaming variant (Claude answers). Same signing and the same fixed-route / no-redirect rules as callBackend, but a 200 body is handed
 * back as a stream (capped at `maxBytes`, cancelled upstream when the consumer goes away or `signal` aborts). Non-200 answers are read
 * (<= 2 KB) only to extract the API's fixed `detail.code`; nothing else from upstream text is ever returned.
 */
export type StreamResult =
  | { kind: "stream"; body: ReadableStream<Uint8Array>; contentType: string }
  | { kind: "error"; status: number; code: string; reason?: string }
  | { kind: "unconfigured" }
  | { kind: "unreachable" };

/** Hard ceiling for a streamed answer: BASHT's spoken reply chunk (audio) is the largest (the API caps it at 4 MiB). */
export const MAX_STREAM_BYTES_CEILING = 4 * 1024 * 1024;

export async function streamBackend(opts: { path: string; body: unknown; account?: string | null; accept?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: Env; fetchImpl?: typeof fetch; now?: () => number }): Promise<StreamResult> {
  const cfg = readConfig(opts.env);
  if (!cfg) return { kind: "unconfigured" };
  if (!PATH.test(opts.path)) throw new Error("backend path must be a fixed /internal/v1/* route");
  const body = JSON.stringify(opts.body);
  const url = new URL(cfg.base.href.replace(/\/+$/, "") + opts.path);
  const headers = { accept: opts.accept ?? "application/x-ndjson", "content-type": "application/json",
    ...signedHeaders(cfg.secret, { method: "POST", target: url.pathname + url.search, body, account: opts.account, now: opts.now }) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 130_000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { method: "POST", headers, body, redirect: "manual", cache: "no-store", signal: ctl.signal });
  } catch { cleanup(); return { kind: "unreachable" }; }
  if (res.status !== 200 || !res.body) {
    let code = "unavailable", reason: string | undefined;
    if (res.status >= 400 && res.status !== 401) {
      try {
        const t = await readCapped(res, 2048);
        const d = t ? (JSON.parse(t) as { detail?: { code?: unknown; reason?: unknown } }).detail : undefined;
        // the code is read from 4xx answers only (a 5xx is always generic); the optional `reason` (BASHT voice) from any: a short token,
        // never free text. The caller filters it against its own allowlist.
        if (res.status < 500 && typeof d?.code === "string" && /^[a-z_]{1,40}$/.test(d.code)) code = d.code;
        if (typeof d?.reason === "string" && /^[a-z_]{1,40}$/.test(d.reason)) reason = d.reason;
      } catch { /* keep generic */ }
    } else await discard(res);
    cleanup(); ctl.abort();
    return { kind: "error", status: res.status, code, ...(reason ? { reason } : {}) };
  }
  const max = Math.min(Math.max(opts.maxBytes ?? 256 * 1024, 1), MAX_STREAM_BYTES_CEILING);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const reader = res.body.getReader();
  let total = 0;
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { cleanup(); controller.close(); return; }
        total += value.byteLength;
        if (total > max) { cleanup(); ctl.abort(); controller.error(new Error("stream too large")); return; }
        controller.enqueue(value);
      } catch (e) { cleanup(); ctl.abort(); controller.error(e); }
    },
    cancel() { cleanup(); ctl.abort(); return reader.cancel().catch(() => {}); },
  });
  return { kind: "stream", body: out, contentType };
}
