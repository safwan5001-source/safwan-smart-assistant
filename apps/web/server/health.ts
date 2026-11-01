/**
 * Server-side status probe for the API (User → Next.js → FastAPI).
 *
 * Runs only inside the Next.js server (route handler). The browser never learns the API address:
 * it talks to `/api/health` on its own origin and receives a coarse, secret-free summary.
 *
 * Fail-closed by design:
 *  - no/invalid BACKEND_URL            -> "unconfigured" (no request is sent)
 *  - the path is fixed to `/health`    (never derived from a browser request)
 *  - redirects are never followed, every call has a timeout, the response size is capped
 *  - the reply never contains URLs, status codes, headers or error text
 *
 * Phase 2 scope: the API's public `/health` only. Authenticated calls (signed BFF → API hop, sessions,
 * database) belong to the PR #26 design and are intentionally NOT implemented here.
 */
export type BackendState = "ok" | "unconfigured" | "unreachable" | "rejected" | "unavailable" | "invalid_response";

export type HealthBody = {
  status: "ok" | "degraded";
  web: "ok";
  backend: BackendState;
  version?: string;
  features?: { assistant: boolean; connected_integrations: number; task_execution: boolean };
};

export type Env = Record<string, string | undefined>;
export type HealthOptions = { env?: Env; fetchImpl?: typeof fetch; timeoutMs?: number };

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Accepts only a plain http(s) origin/prefix: no credentials, query or fragment. */
export function readBackendUrl(env: Env = process.env): URL | null {
  const raw = env.BACKEND_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url;
}

const isFeatures = (v: unknown): v is NonNullable<HealthBody["features"]> => {
  const f = v as Record<string, unknown> | null;
  return !!f && typeof f === "object" && typeof f.assistant === "boolean" && typeof f.task_execution === "boolean" &&
    typeof f.connected_integrations === "number" && Number.isInteger(f.connected_integrations);
};

const degraded = (backend: Exclude<BackendState, "ok">): { status: 503; body: HealthBody } =>
  ({ status: 503, body: { status: "degraded", web: "ok", backend } });

export async function buildHealth(opts: HealthOptions = {}): Promise<{ status: 200 | 503; body: HealthBody }> {
  const base = readBackendUrl(opts.env);
  if (!base) return degraded("unconfigured");
  // Append (never "resolve"): a base such as http://host:8000/prefix must keep its prefix.
  const url = base.href.replace(/\/+$/, "") + "/health";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "GET", headers: { accept: "application/json" }, redirect: "manual", cache: "no-store", signal: ctl.signal,
    });
    if (res.status >= 300 && res.status < 400) return degraded("rejected");
    if (res.status === 401 || res.status === 403) return degraded("rejected");
    if (res.status >= 500 || res.status === 429) return degraded("unavailable");
    if (res.status !== 200) return degraded("invalid_response");
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return degraded("invalid_response");
    let json: { status?: unknown; version?: unknown; features?: unknown } | null;
    try { json = JSON.parse(text); } catch { return degraded("invalid_response"); }
    if (json?.status !== "ok" || !isFeatures(json.features)) return degraded("invalid_response");
    return {
      status: 200,
      body: { status: "ok", web: "ok", backend: "ok", version: typeof json.version === "string" ? json.version.slice(0, 32) : undefined, features: json.features },
    };
  } catch {
    return degraded("unreachable");
  } finally {
    clearTimeout(timer);
  }
}
