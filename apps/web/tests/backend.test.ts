import { beforeEach, describe, expect, it, vi } from "vitest";
import { callBackend, readConfig } from "@/server/backend";
import { DEFAULT_HEALTH_CACHE_MS, buildHealth, cachedHealth, healthCacheMs, resetHealthCache } from "@/server/health";

const SECRET = "s".repeat(48);
const env = { BACKEND_URL: "https://backend.internal.example", SERVICE_AUTH_SECRET: SECRET };
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const goodPing = { status: "ok", service: "orchestrator-foundation", version: "0.3.0", features: { assistant: false, connected_integrations: 0, task_execution: false } };

describe("readConfig fails closed", () => {
  it("accepts a valid pair", () => expect(readConfig(env)).not.toBeNull());
  it.each([
    [{}], [{ BACKEND_URL: env.BACKEND_URL }], [{ SERVICE_AUTH_SECRET: SECRET }],
    [{ ...env, SERVICE_AUTH_SECRET: "short" }], [{ ...env, SERVICE_AUTH_SECRET: "é".repeat(15) }],
    [{ ...env, BACKEND_URL: "not a url" }], [{ ...env, BACKEND_URL: "ftp://x.example" }], [{ ...env, BACKEND_URL: "javascript:alert(1)" }],
    [{ ...env, BACKEND_URL: "https://user:pw@x.example" }], [{ ...env, BACKEND_URL: "https://x.example/?q=1" }], [{ ...env, BACKEND_URL: "https://x.example/#h" }],
  ])("rejects %j", (e) => expect(readConfig(e)).toBeNull());
});

describe("callBackend", () => {
  it("sends nothing when unconfigured", async () => {
    const f = vi.fn();
    expect(await callBackend({ path: "/internal/v1/ping", env: {}, fetchImpl: f as unknown as typeof fetch })).toEqual({ kind: "unconfigured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("signs the exact path, sends only service headers and never follows redirects", async () => {
    const f = vi.fn(async () => ok(goodPing));
    const r = await callBackend({ path: "/internal/v1/ping", env, fetchImpl: f as unknown as typeof fetch });
    expect(r.kind).toBe("ok");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit & { headers: Record<string, string> }];
    expect(url.toString()).toBe("https://backend.internal.example/internal/v1/ping");
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers).sort()).toEqual(["accept", "x-svc-nonce", "x-svc-sig", "x-svc-ts"]);
    expect(JSON.stringify(init.headers)).not.toContain(SECRET);
    expect(init.cache).toBe("no-store");
  });

  it("respects a base URL with a path prefix", async () => {
    const f = vi.fn(async () => ok(goodPing));
    await callBackend({ path: "/internal/v1/ping", env: { ...env, BACKEND_URL: "https://h.example/svc" }, fetchImpl: f as unknown as typeof fetch });
    expect((f.mock.calls[0] as unknown as [URL])[0].pathname).toBe("/svc/internal/v1/ping");
  });

  it.each(["/health", "/internal/v2/x", "/internal/v1/", "//evil.example/x", "/internal/v1/../../etc", "https://evil.example/internal/v1/x", "/internal/v1/a b", "/internal/v1/A"])(
    "refuses a path outside the fixed internal namespace: %s", async (path) => {
      const f = vi.fn();
      await expect(callBackend({ path, env, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow();
      expect(f).not.toHaveBeenCalled();
    });

  it("classifies failures without leaking detail", async () => {
    const run = (res: () => Promise<Response>) => callBackend({ path: "/internal/v1/ping", env, fetchImpl: res as unknown as typeof fetch });
    expect(await run(async () => { throw new Error("ECONNREFUSED secret-host:5432"); })).toEqual({ kind: "unreachable" });
    expect(await run(async () => new Response("{}", { status: 401 }))).toEqual({ kind: "rejected", status: 401 });
    expect(await run(async () => new Response("{}", { status: 403 }))).toEqual({ kind: "rejected", status: 403 });
    expect(await run(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).toEqual({ kind: "rejected", status: 302 });
    expect(await run(async () => new Response("{}", { status: 503 }))).toEqual({ kind: "unavailable", status: 503 });
    expect(await run(async () => new Response("<html>nope</html>", { status: 200 }))).toEqual({ kind: "invalid_response" });
    expect(await run(async () => new Response("x".repeat(70_000), { status: 200 }))).toEqual({ kind: "invalid_response" });
  });

  it("times out instead of hanging", async () => {
    const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    const r = await callBackend({ path: "/internal/v1/ping", env, timeoutMs: 20, fetchImpl: hang as unknown as typeof fetch });
    expect(r).toEqual({ kind: "unreachable" });
  });

  it("uses a different nonce for every call", async () => {
    const nonces: string[] = [];
    const f = async (_u: unknown, init?: RequestInit) => { nonces.push((init!.headers as Record<string, string>)["x-svc-nonce"]); return ok(goodPing); };
    for (let i = 0; i < 5; i++) await callBackend({ path: "/internal/v1/ping", env, fetchImpl: f as unknown as typeof fetch });
    expect(new Set(nonces).size).toBe(5);
  });
});

describe("buildHealth (public /api/health)", () => {
  const run = (res: () => Promise<Response>, e: Record<string, string | undefined> = env) => buildHealth({ env: e, fetchImpl: res as unknown as typeof fetch });

  it("reports ok only when the signed hop succeeds with a well-formed body", async () => {
    const r = await run(async () => ok(goodPing));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", web: "ok", backend: "ok", version: "0.3.0", features: { assistant: false } });
  });

  it("passes BASHT's engine state through as a known enum only, and drops unknown feature fields", async () => {
    const body = async (features: object) => (await run(async () => ok({ ...goodPing, features: { ...goodPing.features, ...features } }))).body.features;
    expect(await body({ basht: "connected" })).toEqual({ ...goodPing.features, basht: "connected" });
    expect(await body({ basht: "https://engine.example" })).toMatchObject({ basht: "offline" });
    expect(await body({ secret_url: "https://x" })).toEqual(goodPing.features);
  });

  it.each([
    ["unconfigured", async () => ok(goodPing), {}],
    ["unreachable", async () => { throw new Error("x"); }, env],
    ["rejected", async () => new Response("{}", { status: 401 }), env],
    ["unavailable", async () => new Response("{}", { status: 503 }), env],
    ["invalid_response", async () => ok({ status: "ok", features: { assistant: "yes" } }), env],
    ["invalid_response", async () => ok({ status: "degraded", features: goodPing.features }), env],
  ] as const)("degrades as %s (HTTP 503)", async (reason, res, e) => {
    const r = await run(res, e);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: "degraded", web: "ok", backend: reason });
  });

  it("never echoes secrets or URLs", async () => {
    for (const res of [async () => ok(goodPing), async () => new Response("{}", { status: 401 })]) {
      const text = JSON.stringify((await run(res)).body);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("backend.internal");
    }
  });
});

describe("response hardening (bytes, streaming, connection teardown)", () => {
  const run = (res: () => Promise<Response>) => callBackend({ path: "/internal/v1/ping", env, fetchImpl: res as unknown as typeof fetch });

  it("counts BYTES, not UTF-16 units: a multibyte body over 64 KB is rejected", async () => {
    const body = JSON.stringify({ ...goodPing, pad: "é".repeat(40_000) }); // ~40k chars, ~80 KB on the wire
    expect(body.length).toBeLessThan(64 * 1024);
    expect(await run(async () => new Response(body, { status: 200 }))).toEqual({ kind: "invalid_response" });
  });

  it("stops reading and cancels an endless stream instead of buffering it", async () => {
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); }, cancel() { cancelled = true; } });
    expect(await run(async () => new Response(stream, { status: 200 }))).toEqual({ kind: "invalid_response" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("rejects early on a declared Content-Length over the cap", async () => {
    const res = new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
    expect(await run(async () => res)).toEqual({ kind: "invalid_response" });
  });

  it.each([503, 429, 401, 403, 302])("cancels an unread upstream body on HTTP %i", async (code) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
    const r = await run(async () => new Response(stream, { status: code }));
    expect(r.kind === "rejected" || r.kind === "unavailable").toBe(true);
    expect(cancelled).toBe(true);
  });

  it("aborts the upstream request once finished", async () => {
    let signal: AbortSignal | undefined;
    await callBackend({ path: "/internal/v1/ping", env, fetchImpl: (async (_u: unknown, init?: RequestInit) => { signal = init?.signal ?? undefined; return ok(goodPing); }) as unknown as typeof fetch });
    expect(signal?.aborted).toBe(true);
  });
});

describe("cachedHealth (public route cannot amplify load on the API or PostgreSQL)", () => {
  const probe = (ok_ = true) => vi.fn(async () => ({ status: (ok_ ? 200 : 503) as 200 | 503, body: { status: ok_ ? "ok" : "degraded", web: "ok", backend: ok_ ? "ok" : "unreachable" } as never }));
  beforeEach(() => resetHealthCache());

  it("serves repeated requests from one probe within the window", async () => {
    const p = probe();
    let t = 1_000;
    for (let i = 0; i < 50; i++) await cachedHealth(() => t, p);
    expect(p).toHaveBeenCalledTimes(1);
    t += DEFAULT_HEALTH_CACHE_MS + 1;
    await cachedHealth(() => t, p);
    expect(p).toHaveBeenCalledTimes(2);
  });

  it("reads the window from HEALTH_CACHE_MS: 0 disables, junk falls back, the maximum is bounded", () => {
    expect(healthCacheMs({})).toBe(5000);
    expect(healthCacheMs({ HEALTH_CACHE_MS: "0" })).toBe(0);
    expect(healthCacheMs({ HEALTH_CACHE_MS: "250" })).toBe(250);
    expect(healthCacheMs({ HEALTH_CACHE_MS: "99999999" })).toBe(60_000);
    for (const junk of ["", "  ", "abc", "-1", "NaN", "Infinity"]) expect(healthCacheMs({ HEALTH_CACHE_MS: junk })).toBe(5000);
  });

  it("shares one in-flight probe between concurrent requests", async () => {
    const p = probe();
    await Promise.all(Array.from({ length: 100 }, () => cachedHealth(() => 1, p)));
    expect(p).toHaveBeenCalledTimes(1);
  });

  it("does not hammer a failing backend either", async () => {
    const p = probe(false);
    for (let i = 0; i < 20; i++) expect((await cachedHealth(() => 5, p)).status).toBe(503);
    expect(p).toHaveBeenCalledTimes(1);
  });

  it("a probe that throws is not cached and does not wedge later requests", async () => {
    const bad = vi.fn(async () => { throw new Error("boom"); });
    await expect(cachedHealth(() => 1, bad as never)).rejects.toThrow();
    const good = probe();
    expect((await cachedHealth(() => 2, good)).status).toBe(200);
  });
});

describe("binary transport for BASHT voice", () => {
  it("callBackend sends a raw audio body with its type, signed over the exact bytes", async () => {
    const { createHmac, createHash } = await import("node:crypto");
    const f = vi.fn(async () => ok({ text: "x" }));
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    await callBackend({ path: "/internal/v1/basht/transcribe", method: "POST", rawBody: { bytes, type: "audio/webm" }, env, fetchImpl: f as unknown as typeof fetch });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["content-type"]).toBe("audio/webm");
    expect(init.body).toBe(bytes);
    const h = init.headers;
    const canon = ["safwan-svc-v1", "POST", "/internal/v1/basht/transcribe", h["x-svc-ts"], h["x-svc-nonce"], createHash("sha256").update(bytes).digest("hex"), "-"].join("\n");
    expect(h["x-svc-sig"]).toBe(createHmac("sha256", SECRET).update(canon, "utf8").digest("hex"));
  });
  it("callBackend refuses a raw body that is not audio", async () => {
    const f = vi.fn();
    await expect(callBackend({ path: "/internal/v1/basht/transcribe", method: "POST", rawBody: { bytes: new Uint8Array(3), type: "text/html" }, env, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("streamBackend hands back the content type and allows up to 4 MiB (never more)", async () => {
    const { streamBackend } = await import("@/server/backend");
    const five = new Uint8Array(5 * 1024 * 1024);
    const f = vi.fn(async () => new Response(five, { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const r = await streamBackend({ path: "/internal/v1/basht/speak", body: { text: "x" }, accept: "audio/*", maxBytes: 64 * 1024 * 1024, env, fetchImpl: f as unknown as typeof fetch });
    expect(r.kind).toBe("stream");
    if (r.kind !== "stream") return;
    expect(r.contentType).toBe("audio/mpeg");
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit & { headers: Record<string, string> }])[1];
    expect(init.headers.accept).toBe("audio/*");
    expect(init.headers["x-svc-acct"]).toBeUndefined();
    await expect(new Response(r.body).arrayBuffer()).rejects.toThrow();
  });
});
