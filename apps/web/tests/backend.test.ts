import { describe, expect, it, vi } from "vitest";
import { callBackend, readConfig } from "@/server/backend";
import { buildHealth } from "@/server/health";

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
