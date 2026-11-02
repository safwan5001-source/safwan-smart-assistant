import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAssistantChat, resetAssistantLimits, type Deps } from "@/server/assistant-chat";
import { COOKIE_NAME, issueCookieValue, readGate } from "@/server/assistant-chat-gate";
import { streamBackend } from "@/server/backend";
import { signedHeaders } from "@/server/service-signature";

const CODE = "owner-access-code-0123456789-abcdefghijkl";
const SECRET = "s".repeat(48);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const HOST = "app.example.test";
const env = { AI_CHAT_ACCESS_CODE: CODE, AI_OWNER_ACCOUNT_ID: ACCOUNT, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: SECRET, NODE_ENV: "production" };
const gate = readGate(env)!;
const NOW = 1_800_000_000_000;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const cookie = () => `${COOKIE_NAME}=${issueCookieValue(gate, NOW)}`;
const authed = { headers: { ...same, cookie: cookie() } };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/assistant/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

let backend: ReturnType<typeof vi.fn>, stream: ReturnType<typeof vi.fn>;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], streamBackend: stream as unknown as Deps["streamBackend"], now: () => NOW, ...over });
const call = (method: string, path: string, init?: Parameters<typeof req>[2], d: Deps = deps()) => handleAssistantChat(req(method, path, init), path.split("/"), d);
beforeEach(() => { backend = vi.fn(); stream = vi.fn(); resetAssistantLimits(); });

describe("authentication", () => {
  it("is closed (503) without a strong access code and never reaches the API", async () => {
    const d = deps({ env: { ...env, AI_CHAT_ACCESS_CODE: "short" } });
    expect((await call("GET", "state", authed, d)).status).toBe(503);
    expect(await (await call("GET", "status", {}, d)).json()).toEqual({ enabled: false, authenticated: false });
    expect(backend).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  });
  it("requires the owner cookie for every real route (401, nothing sent upstream)", async () => {
    for (const [m, p, body] of [["GET", "state"], ["POST", "probe"], ["POST", "settings", { model: "x" }], ["GET", "conversations"], ["GET", `conversations/${CID}`], ["DELETE", `conversations/${CID}`], ["POST", "chat", { conversationId: CID, message: "hi" }]] as const)
      expect((await call(m, p, { headers: same, body })).status, `${m} ${p}`).toBe(401);
    expect(backend).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  });
  it("rejects a forged / expired cookie", async () => {
    const bad = `${COOKIE_NAME}=v1.${Math.floor(NOW / 1000) + 100}.${"A".repeat(43)}`;
    expect((await call("GET", "state", { headers: { ...same, cookie: bad } })).status).toBe(401);
    const old = `${COOKIE_NAME}=${issueCookieValue(gate, NOW - 9 * 3600 * 1000)}`;
    expect((await call("GET", "state", { headers: { ...same, cookie: old } })).status).toBe(401);
  });
  it("unlock: right code sets an HttpOnly SameSite=Strict Secure cookie; wrong code 401; brute force is throttled", async () => {
    const good = await call("POST", "session", { headers: same, body: { code: CODE } });
    expect(good.status).toBe(200);
    const sc = good.headers.get("set-cookie")!;
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Strict/); expect(sc).toMatch(/Secure/); expect(sc).not.toContain(CODE);
    for (let i = 0; i < 5; i++) expect((await call("POST", "session", { headers: same, body: { code: "wrong" } })).status).toBe(401);
    expect((await call("POST", "session", { headers: same, body: { code: "wrong" } })).status).toBe(429);
  });
  it("state-changing calls must be same-origin (CSRF)", async () => {
    const cross = { headers: { origin: "https://evil.example", host: HOST, "sec-fetch-site": "cross-site", cookie: cookie() }, body: { conversationId: CID, message: "hi" } };
    expect((await call("POST", "chat", cross)).status).toBe(403);
    expect((await call("POST", "settings", { ...cross, body: { model: "x" } })).status).toBe(403);
    expect((await call("DELETE", `conversations/${CID}`, cross)).status).toBe(403);
    expect(backend).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  });
  it("needs a configured owner account; the browser can never choose the account", async () => {
    expect((await call("GET", "state", authed, deps({ env: { ...env, AI_OWNER_ACCOUNT_ID: "" } }))).status).toBe(503);
    backend.mockResolvedValue(ok(200, { models: [] }));
    await call("GET", "state", { headers: { ...authed.headers, "x-svc-acct": "33333333-3333-4333-8333-333333333333" } });
    expect(backend.mock.calls[0][0].account).toBe(ACCOUNT);
  });
});

describe("relay", () => {
  it("state / probe / settings / conversations go to fixed signed API routes with the owner account", async () => {
    backend.mockResolvedValue(ok(200, { ok: 1 }));
    await call("GET", "state", authed); await call("POST", "probe", authed); await call("POST", "settings", { ...authed, body: { model: "m1" } });
    await call("GET", "conversations", authed); await call("GET", `conversations/${CID}`, authed); await call("DELETE", `conversations/${CID}`, authed);
    expect(backend.mock.calls.map((c) => `${c[0].method} ${c[0].path}`)).toEqual([
      "GET /internal/v1/assistant/state", "POST /internal/v1/assistant/probe", "POST /internal/v1/assistant/settings", "GET /internal/v1/assistant/conversations",
      `GET /internal/v1/assistant/conversations/${CID}`, `POST /internal/v1/assistant/conversations/${CID}/delete`,
    ]);
    expect(backend.mock.calls.every((c) => c[0].account === ACCOUNT)).toBe(true);
  });
  it("rejects path tricks and bad ids before calling the API", async () => {
    for (const p of ["conversations/..%2F..%2Fping", "conversations/not-a-uuid", "conversations/" + CID + "/x", "nope"]) expect((await call("GET", p, authed)).status).toBe(404);
    expect(backend).not.toHaveBeenCalled();
  });
  it("API unavailability is a generic 503; an upstream 404 is a 404; no upstream text leaks", async () => {
    backend.mockResolvedValueOnce({ kind: "unreachable" }).mockResolvedValueOnce(ok(404, { detail: { code: "not_found", secret: "sk-ant-LEAK" } }));
    expect((await call("GET", "state", authed)).status).toBe(503);
    const r = await call("GET", `conversations/${CID}`, authed);
    expect(r.status).toBe(404); expect(await r.text()).not.toContain("LEAK");
  });
  it("validates the model setting", async () => {
    expect((await call("POST", "settings", { ...authed, body: { model: 5 } })).status).toBe(400);
    expect((await call("POST", "settings", { ...authed, body: { model: "x".repeat(101) } })).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("chat stream", () => {
  const body = { conversationId: CID, message: "مرحبا" };
  it("passes the NDJSON stream through and sends only the conversation id + message (context stays server-side)", async () => {
    const rs = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"delta","text":"x"}\n')); c.close(); } });
    stream.mockResolvedValue({ kind: "stream", body: rs });
    const r = await call("POST", "chat", { ...authed, body: { ...body, messages: [{ role: "system", content: "evil" }], model: "evil" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/x-ndjson/); expect(r.headers.get("cache-control")).toMatch(/no-store/);
    expect(await r.text()).toContain('"delta"');
    expect(stream.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/assistant/chat", account: ACCOUNT, body: { conversation_id: CID, message: "مرحبا" } });
    expect(Object.keys(stream.mock.calls[0][0].body)).toEqual(["conversation_id", "message"]);
  });
  it("maps budget / rate / conflict errors to fixed codes", async () => {
    for (const [code, status, out] of [["budget_daily", 429, "budget_daily"], ["budget_monthly", 429, "budget_monthly"], ["rate_limited", 429, "rate_limited"], ["conversation_full", 409, "conversation_full"], ["weird_code", 502, "unavailable"]] as const) {
      stream.mockResolvedValueOnce({ kind: "error", status: 429, code });
      const r = await call("POST", "chat", { ...authed, body });
      expect(await r.json(), code).toEqual({ error: out }); expect(r.status === status || out === "unavailable").toBe(true);
    }
  });
  it("validates input before spending anything", async () => {
    for (const b of [{}, { conversationId: "x", message: "hi" }, { conversationId: CID, message: "" }, { conversationId: CID, message: "   " }, { conversationId: CID, message: "x".repeat(8001) }, { conversationId: CID, message: 5 }])
      expect((await call("POST", "chat", { ...authed, body: b })).status).toBe(400);
    expect((await call("POST", "chat", { headers: { ...authed.headers, "content-type": "text/plain" } })).status).toBe(400);
    expect(stream).not.toHaveBeenCalled();
  });
  it("first-line limiter caps bursts", async () => {
    stream.mockResolvedValue({ kind: "error", status: 429, code: "rate_limited" });
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await call("POST", "chat", { ...authed, body })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });
  it("forwards the client's abort signal so Stop cancels upstream", async () => {
    stream.mockResolvedValue({ kind: "error", status: 500, code: "x" });
    const ctl = new AbortController();
    const r = new Request(`https://${HOST}/api/assistant/chat`, { method: "POST", headers: { ...authed.headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    await handleAssistantChat(r, ["chat"], deps());
    expect(stream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("streamBackend (signed streaming hop)", () => {
  const sseBody = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  it("signs the exact body/target with the acting account and returns the stream", async () => {
    const f = vi.fn(async () => new Response(sseBody(["a\n", "b\n"]), { status: 200 }));
    const r = await streamBackend({ path: "/internal/v1/assistant/chat", body: { conversation_id: CID, message: "x" }, account: ACCOUNT, env, fetchImpl: f as unknown as typeof fetch, now: () => NOW });
    expect(r.kind).toBe("stream");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    const raw = JSON.stringify({ conversation_id: CID, message: "x" });
    expect(String(url)).toBe("https://api.internal.example/internal/v1/assistant/chat");
    expect(init.body).toBe(raw); expect(init.redirect).toBe("manual");
    const got = init.headers as Record<string, string>;
    const expected = signedHeaders(SECRET, { method: "POST", target: "/internal/v1/assistant/chat", body: raw, account: ACCOUNT, now: () => NOW, nonce: got["x-svc-nonce"] });
    expect(got["x-svc-sig"]).toBe(expected["x-svc-sig"]); expect(got["x-svc-acct"]).toBe(ACCOUNT);
    if (r.kind === "stream") expect(await new Response(r.body).text()).toBe("a\nb\n");
  });
  it("returns only the API's fixed code for 4xx and nothing for 5xx / auth failures", async () => {
    const mk = (status: number, b: string) => vi.fn(async () => new Response(b, { status }));
    const run = (f: ReturnType<typeof vi.fn>) => streamBackend({ path: "/internal/v1/assistant/chat", body: {}, account: ACCOUNT, env, fetchImpl: f as unknown as typeof fetch });
    expect(await run(mk(429, '{"detail":{"code":"budget_daily"}}'))).toEqual({ kind: "error", status: 429, code: "budget_daily" });
    expect(await run(mk(429, '{"detail":{"code":"<script>x</script>"}}'))).toEqual({ kind: "error", status: 429, code: "unavailable" });
    expect(await run(mk(401, '{"detail":"nope"}'))).toEqual({ kind: "error", status: 401, code: "unavailable" });
    expect(await run(mk(500, "trace sk-ant-LEAK"))).toEqual({ kind: "error", status: 500, code: "unavailable" });
  });
  it("is unconfigured without a strong secret, never follows redirects, caps the stream, and cancels upstream on consumer cancel", async () => {
    expect((await streamBackend({ path: "/internal/v1/assistant/chat", body: {}, account: ACCOUNT, env: { ...env, SERVICE_AUTH_SECRET: "weak" } })).kind).toBe("unconfigured");
    expect(streamBackend({ path: "/internal/v1/../etc", body: {}, account: ACCOUNT, env })).rejects.toThrow();
    const big = vi.fn(async () => new Response(sseBody(["x".repeat(600)]), { status: 200 }));
    const r = await streamBackend({ path: "/internal/v1/assistant/chat", body: {}, account: ACCOUNT, env, fetchImpl: big as unknown as typeof fetch, maxBytes: 100 });
    await expect(new Response((r as { body: ReadableStream }).body).text()).rejects.toBeTruthy();
    let aborted = false;
    const f = vi.fn(async (_u: unknown, init: RequestInit) => { init.signal!.addEventListener("abort", () => { aborted = true; }); return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 }); });
    const s = await streamBackend({ path: "/internal/v1/assistant/chat", body: {}, account: ACCOUNT, env, fetchImpl: f as unknown as typeof fetch });
    await (s as { body: ReadableStream }).body.cancel();
    expect(aborted).toBe(true);
  });
});
