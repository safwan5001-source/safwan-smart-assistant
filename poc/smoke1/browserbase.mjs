// Minimal Browserbase REST client, written against the official API reference (fetched 2026-10-31):
//   POST /v1/sessions            body { projectId?, timeout (60..21600 s), keepAlive, browserSettings.viewport, region, userMetadata }
//                                -> 201 { id, status, expiresAt, connectUrl (wss), seleniumRemoteUrl, signingKey, ... }
//   GET  /v1/sessions/{id}/debug ?expiresIn=60..21600 -> { debuggerFullscreenUrl, debuggerUrl, wsUrl, pages[] }
//   POST /v1/sessions/{id}       body { status: "REQUEST_RELEASE" }   (no projectId in the body)
//   GET  /v1/sessions/{id}       -> Session { status: PENDING|RUNNING|ERROR|TIMED_OUT|COMPLETED, ... }
// Auth: header `X-BB-API-Key`. The key is read from the environment only and is never logged or written anywhere.
// Secrets that appear in responses (connectUrl, signingKey, live-view URLs) are returned to the caller but never printed:
// use `mask()` for anything that reaches a log or a report.

const DEFAULT_BASE = "https://api.browserbase.com";

export class BrowserbaseError extends Error {
  constructor(op, status) { super(`${op} failed with HTTP ${status}`); this.name = "BrowserbaseError"; this.status = status; }
}

export function isRealApi(base) { return new URL(base).hostname === new URL(DEFAULT_BASE).hostname; }

export function mask(url) {
  // scheme + host + path length only: live-view and connect URLs are bearer secrets
  try { const u = new URL(url); return `${u.protocol}//${u.host}/…(${u.pathname.length} path chars, ${u.search ? "query present" : "no query"})`; } catch { return "(unparseable url)"; }
}

export function createClient({ apiKey, base = DEFAULT_BASE, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY is not set");
  const call = async (op, method, path, body) => {
    const res = await fetchImpl(base.replace(/\/$/, "") + path, {
      method,
      headers: { "X-BB-API-Key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new BrowserbaseError(op, res.status); // never include the response body: it may echo identifiers
    return res.json();
  };
  return {
    createSession: ({ projectId, timeoutSeconds = 300, viewport = { width: 1280, height: 800 }, region, userMetadata } = {}) => {
      if (!(timeoutSeconds >= 60 && timeoutSeconds <= 21600)) throw new Error("timeout must be 60..21600 seconds");
      return call("create session", "POST", "/v1/sessions", {
        ...(projectId ? { projectId } : {}), timeout: timeoutSeconds, keepAlive: false,
        browserSettings: { viewport }, ...(region ? { region } : {}), ...(userMetadata ? { userMetadata } : {}),
      });
    },
    liveUrls: (id, expiresInSeconds) => {
      if (expiresInSeconds !== undefined && !(expiresInSeconds >= 60 && expiresInSeconds <= 21600)) throw new Error("expiresIn must be 60..21600 seconds");
      return call("live urls", "GET", `/v1/sessions/${encodeURIComponent(id)}/debug${expiresInSeconds ? `?expiresIn=${expiresInSeconds}` : ""}`);
    },
    release: (id) => call("release session", "POST", `/v1/sessions/${encodeURIComponent(id)}`, { status: "REQUEST_RELEASE" }),
    retrieve: (id) => call("retrieve session", "GET", `/v1/sessions/${encodeURIComponent(id)}`),
  };
}
