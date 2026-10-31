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
const PATH = /^\/internal\/v1\/[a-z0-9][a-z0-9/_-]*$/;

export function readConfig(env: Env = process.env): { base: URL; secret: string } | null {
  const raw = env.BACKEND_URL, secret = env.SERVICE_AUTH_SECRET;
  if (!raw || !secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) return null;
  let base: URL;
  try { base = new URL(raw); } catch { return null; }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) return null;
  return { base, secret };
}

export type CallOptions = {
  path: string; method?: "GET" | "POST"; body?: unknown; account?: string | null;
  timeoutMs?: number; env?: Env; fetchImpl?: typeof fetch; now?: () => number;
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
    if (res.status >= 300 && res.status < 400) return { kind: "rejected", status: res.status };
    if (res.status === 401 || res.status === 403) return { kind: "rejected", status: res.status };
    if (res.status >= 500 || res.status === 429) return { kind: "unavailable", status: res.status };
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { kind: "invalid_response" };
    try { return { kind: "ok", status: res.status, json: text ? JSON.parse(text) : null }; } catch { return { kind: "invalid_response" }; }
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
