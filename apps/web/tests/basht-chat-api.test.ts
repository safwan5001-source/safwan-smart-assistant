import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, type Deps } from "@/server/basht-chat";
import { COOKIE_NAME as AI_COOKIE, issueCookieValue, readGate } from "@/server/assistant-chat-gate";
import { createBashtClient } from "@/lib/basht-client";

const CODE = "basht-owner-code-0123456789-abcdefghijkl";
const AI_CODE = "owner-access-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const RUN = "d65fc949-4113-4cbe-a1a1-29f47545d14c";
const env = { BASHT_CHAT_ACCESS_CODE: CODE, AI_CHAT_ACCESS_CODE: AI_CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const gate = readBashtGate(env)!;
const NOW = 1_800_000_000_000;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const authed = { headers: { ...same, cookie: `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}` } };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

let backend: ReturnType<typeof vi.fn>;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const route = (p: string) => p.split("?")[0].split("/");
const call = (method: string, path: string, init?: Parameters<typeof req>[2], d: Deps = deps()) => handleBashtChat(req(method, path, init), route(path), d);
beforeEach(() => { backend = vi.fn(); resetBashtLimits(); });

describe("BASHT chat door: owner gate", () => {
  it("is closed without a strong BASHT_CHAT_ACCESS_CODE and never reaches the API", async () => {
    const d = deps({ env: { ...env, BASHT_CHAT_ACCESS_CODE: "short" } });
    expect(await (await call("GET", "status", {}, d)).json()).toEqual({ enabled: false, authenticated: false });
    expect((await call("GET", "sessions", authed, d)).status).toBe(503);
    expect(backend).not.toHaveBeenCalled();
  });
  it("requires its own cookie for every route; the Claude cookie does not open it", async () => {
    const aiCookie = { headers: { ...same, cookie: `${AI_COOKIE}=${issueCookieValue(readGate(env)!, NOW)}` } };
    for (const [m, p, body] of [["GET", "sessions"], ["GET", "history?key=agent:main:app:owner"], ["POST", "send", { message: "x" }], ["GET", `runs/${RUN}`], ["POST", `runs/${RUN}/stop`, {}]] as const) {
      expect((await call(m, p, { headers: same, body })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { headers: aiCookie.headers, body })).status, `${m} ${p} with the Claude cookie`).toBe(401);
    }
    expect(backend).not.toHaveBeenCalled();
  });
  it("unlock: right code sets an HttpOnly SameSite=Strict Secure cookie scoped to /api/basht; wrong code 401; throttled", async () => {
    const good = await call("POST", "session", { headers: same, body: { code: CODE } });
    expect(good.status).toBe(200);
    const sc = good.headers.get("set-cookie")!;
    expect(sc).toMatch(/^safwan_basht=v1\./); expect(sc).toContain("Path=/api/basht"); expect(sc).toContain("HttpOnly"); expect(sc).toContain("SameSite=Strict"); expect(sc).toContain("Secure");
    expect((await call("POST", "session", { headers: same, body: { code: AI_CODE } })).status).toBe(401);
    for (let i = 0; i < 5; i++) await call("POST", "session", { headers: same, body: { code: "wrong" } });
    expect((await call("POST", "session", { headers: same, body: { code: CODE } })).status).toBe(429);
  });
  it("cross-site writes are refused", async () => {
    const cross = { headers: { ...authed.headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" } };
    expect((await call("POST", "send", { ...cross, body: { message: "x" } })).status).toBe(403);
    expect((await call("POST", "session", { ...cross, body: { code: CODE } })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("BASHT chat door: relay", () => {
  it("send: validates, relays only the message and maps busy/rate limits", async () => {
    backend.mockResolvedValueOnce(ok(200, { run_id: RUN }));
    const r = await call("POST", "send", { ...authed, body: { message: "جهّز تقرير اليوم", sessionKey: "agent:main:whatsapp:direct:+1" } });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ runId: RUN });
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/send", method: "POST", body: { message: "جهّز تقرير اليوم" } });
    expect((await call("POST", "send", { ...authed, body: { message: "  " } })).status).toBe(400);
    expect((await call("POST", "send", { ...authed, body: { message: "x".repeat(8001) } })).status).toBe(400);
    // the full supported length in Arabic (2 bytes/char) and in characters JSON escapes to 6 bytes each still fits the body bound
    backend.mockResolvedValue(ok(200, { run_id: RUN }));
    expect((await call("POST", "send", { ...authed, body: { message: "ب".repeat(8000) } })).status).toBe(200);
    expect((await call("POST", "send", { ...authed, body: { message: "\u0001".repeat(8000) } })).status).toBe(200);
    backend.mockReset();
    backend.mockResolvedValueOnce(ok(409, { detail: { code: "busy", secret: "upstream text" } }));
    const busy = await call("POST", "send", { ...authed, body: { message: "ثانية" } });
    expect(busy.status).toBe(409); expect(await busy.json()).toEqual({ error: "busy" });
  });
  it("history: only well-formed keys; run view is whitelisted", async () => {
    expect((await call("GET", "history?key=../setup", authed)).status).toBe(400);
    backend.mockResolvedValueOnce(ok(200, { key: "agent:main:app:owner", messages: [{ role: "user", text: "مرحبا", at: 1 }] }));
    const h = await call("GET", "history?key=agent:main:app:owner", authed);
    expect(h.status).toBe(200);
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/history", method: "POST", body: { key: "agent:main:app:owner", limit: 50 } });
    expect(backend.mock.calls[0][0].maxBytes).toBeLessThanOrEqual(512 * 1024);
    // every relayed path is a fixed /internal/v1/* route, which the real callBackend enforces (no query strings)
    for (const c of backend.mock.calls) expect(c[0].path).toMatch(/^\/internal\/v1\/[a-z0-9/_-]+$/);
    backend.mockResolvedValueOnce(ok(200, { run_id: RUN, status: "done", text: "تم", failed: false, extra: "x" }));
    expect(await (await call("GET", `runs/${RUN}`, authed)).json()).toEqual({ status: "done", text: "تم", failed: false, firstTokenMs: null, totalMs: null, steps: [] });
    backend.mockResolvedValueOnce({ kind: "unreachable" });
    expect((await call("GET", "sessions", authed)).status).toBe(503);
  });
});

describe("browser client", () => {
  it("turns failures into Arabic messages and never surfaces upstream text", async () => {
    const c = createBashtClient(async () => new Response(JSON.stringify({ error: "busy" }), { status: 409 }));
    await expect(c.send("x")).rejects.toThrow("باشت ينفّذ طلبًا سابقًا");
    const offline = createBashtClient(async () => { throw new Error("network down"); });
    await expect(offline.sessions()).rejects.toThrow("انقطع الاتصال");
    expect(await offline.status()).toEqual({ enabled: false, authenticated: false });
  });
});

describe("BASHT chat door: model control (M)", () => {
  it("reads the catalog and state through fixed API paths", async () => {
    backend.mockResolvedValueOnce(ok(200, { models: [{ id: "mock/echo" }] })).mockResolvedValueOnce(ok(200, { model: { id: "mock/echo" } }));
    expect(await (await call("GET", "models", authed)).json()).toEqual({ models: [{ id: "mock/echo" }] });
    expect((await call("GET", "model", authed)).status).toBe(200);
    expect(backend.mock.calls.map((c) => [c[0].path, c[0].method])).toEqual([["/internal/v1/basht/models", "GET"], ["/internal/v1/basht/model", "GET"]]);
  });
  it("writes only validated values; malformed input never reaches the API", async () => {
    backend.mockResolvedValue(ok(200, {}));
    for (const [p, body] of [["model", { model: "openai/gpt-5" }], ["model", { model: "default" }], ["thinking", { level: "high" }], ["fast", { mode: "off" }]] as const)
      expect((await call("POST", p, { ...authed, body })).status, p).toBe(200);
    expect(backend.mock.calls.map((c) => c[0].body)).toEqual([{ model: "openai/gpt-5" }, { model: "default" }, { level: "high" }, { mode: "off" }]);
    expect(new Set(backend.mock.calls.map((c) => c[0].timeoutMs))).toEqual(new Set([45_000])); // queued on the engine: never cut short
    backend.mockClear();
    for (const [p, body] of [["model", { model: "a b" }], ["model", { model: 5 }], ["thinking", { level: "HIGH!" }], ["fast", { mode: "turbo" }]] as const)
      expect((await call("POST", p, { ...authed, body })).status, JSON.stringify(body)).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("needs the owner and same-origin like every other route", async () => {
    expect((await call("GET", "models", { headers: same })).status).toBe(401);
    const cross = { headers: { ...authed.headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" } };
    expect((await call("POST", "model", { ...cross, body: { model: "openai/gpt-5" } })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it("passes the engine's specific refusal codes through; anything else stays generic", async () => {
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "fast_mode_unsupported" } }));
    expect(await (await call("POST", "fast", { ...authed, body: { mode: "on" } })).json()).toEqual({ error: "fast_mode_unsupported" });
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "model_control_unavailable" } }));
    expect(await (await call("GET", "models", authed)).json()).toEqual({ error: "model_control_unavailable" });
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "<script>" } }));
    expect(await (await call("POST", "model", { ...authed, body: { model: "x/y" } })).json()).toEqual({ error: "bad_request" });
  });
  it("a run carries the bridge-measured latency", async () => {
    backend.mockResolvedValueOnce(ok(200, { status: "done", text: "x", failed: false, first_token_ms: 640, total_ms: 2100 }));
    expect(await (await call("GET", `runs/${RUN}`, authed)).json()).toEqual({ status: "done", text: "x", failed: false, firstTokenMs: 640, totalMs: 2100, steps: [] });
  });
});
