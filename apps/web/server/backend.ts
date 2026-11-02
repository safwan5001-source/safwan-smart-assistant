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
  timeoutMs?: number; maxBytes?: number; env?: Env; fetchImpl?: typeof fetch; now?: () => number;
};

export async function callBackend(opts: CallOptions): Promise<BackendResult> {
  const cfg = readConfig(opts.env);
  if (!cfg) return { kind: "unconfigured" };
  if (!PATH.test(opts.path)) throw new Error("backend path must be a fixed /internal/v1/* route");
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  // Append (never "resolve"): a base such as https://host/svc must keep its /svc prefix.
  const url = new URL(cfg.base.href.replace(/\/+$/, "") + opts.path);
  const target = url.pathname + url.search;
  const headers = { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}),
    ...signedHeaders(cfg.secret, { method, target, body, account: opts.account, now: opts.now }) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { method, headers, body: body || undefined, redirect: "manual", cache: "no-store", signal: ctl.signal });
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
  | { kind: "stream"; body: ReadableStream<Uint8Array> }
  | { kind: "error"; status: number; code: string }
  | { kind: "unconfigured" }
  | { kind: "unreachable" };

export async function streamBackend(opts: { path: string; body: unknown; account: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: Env; fetchImpl?: typeof fetch; now?: () => number }): Promise<StreamResult> {
  const cfg = readConfig(opts.env);
  if (!cfg) return { kind: "unconfigured" };
  if (!PATH.test(opts.path)) throw new Error("backend path must be a fixed /internal/v1/* route");
  const body = JSON.stringify(opts.body);
  const url = new URL(cfg.base.href.replace(/\/+$/, "") + opts.path);
  const headers = { accept: "application/x-ndjson", "content-type": "application/json",
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
    let code = "unavailable";
    if (res.status >= 400 && res.status < 500 && res.status !== 401) {
      try { const t = await readCapped(res, 2048); const d = t ? (JSON.parse(t) as { detail?: { code?: unknown } }).detail?.code : undefined; if (typeof d === "string" && /^[a-z_]{1,40}$/.test(d)) code = d; } catch { /* keep generic */ }
    } else await discard(res);
    cleanup(); ctl.abort();
    return { kind: "error", status: res.status, code };
  }
  const max = Math.min(Math.max(opts.maxBytes ?? 256 * 1024, 1), 1024 * 1024);
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
  return { kind: "stream", body: out };
}
