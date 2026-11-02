import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleBrowserChat, resetBrowserChatLimits, sameOrigin, type Deps } from "@/server/browser-chat/api";
import { COOKIE_NAME, codeMatches, issueCookieValue, readGate, verifyCookieValue, COOKIE_TTL_S } from "@/server/browser-chat/gate";
import { callBackend } from "@/server/backend";
import { STEP_IDS } from "@/lib/browser-task";

const CODE = "owner-access-code-0123456789-abcdefghijkl";
const SECRET = "s".repeat(48);
const ID = "11111111-1111-4111-8111-111111111111";
const HOST = "app.example.test";
const env = { BROWSER_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: SECRET, NODE_ENV: "production" };
const gate = readGate(env)!;
const NOW = 1_800_000_000_000;
const job = (over: Record<string, unknown> = {}) => ({ id: ID, status: "running", url: "https://example.com/", sessionReleased: false, steps: STEP_IDS.map((id) => ({ id, status: "pending" })), ...over });
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });

type Mock = ReturnType<typeof vi.fn>;
let backend: Mock;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const cookie = (value = issueCookieValue(gate, NOW)) => `${COOKIE_NAME}=${value}`;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/browser/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const call = (method: string, path: string, init?: Parameters<typeof req>[2], d: Deps = deps()) => handleBrowserChat(req(method, path, init), path.split("/"), d);
const authed = { headers: { ...same, cookie: cookie() } };

beforeEach(() => { backend = vi.fn(); resetBrowserChatLimits(); });

describe("owner gate (cookie)", () => {
  it("is off without a strong access code", () => {
    for (const e of [{}, { BROWSER_CHAT_ACCESS_CODE: "short" }, { BROWSER_CHAT_ACCESS_CODE: "é".repeat(15) }, { BROWSER_CHAT_ACCESS_CODE: "a".repeat(64) }, { BROWSER_CHAT_ACCESS_CODE: "abcabcabc".repeat(6) }]) expect(readGate(e)).toBeNull();
    expect(readGate(env)).not.toBeNull();
  });
  it("accepts only the exact code", () => {
    expect(codeMatches(gate, CODE)).toBe(true);
    for (const bad of ["", CODE + "x", CODE.slice(1), CODE.toUpperCase(), "x".repeat(300), 5, null, undefined, {}, [CODE]]) expect(codeMatches(gate, bad)).toBe(false);
  });
  it("cookies expire, cannot be forged, and die when the code is rotated", () => {
    const v = issueCookieValue(gate, NOW);
    expect(verifyCookieValue(gate, v, NOW)).toBe(true);
    expect(verifyCookieValue(gate, v, NOW + (COOKIE_TTL_S + 1) * 1000)).toBe(false);
    expect(verifyCookieValue(gate, v.slice(0, -1) + (v.endsWith("A") ? "B" : "A"), NOW)).toBe(false);
    expect(verifyCookieValue(gate, v.replace(/\.(\d+)\./, (_, n) => `.${Number(n) + 99999}.`), NOW)).toBe(false);   // extended expiry
    expect(verifyCookieValue(readGate({ ...env, BROWSER_CHAT_ACCESS_CODE: CODE + "-rotated" })!, v, NOW)).toBe(false);
    for (const bad of [undefined, "", "x", "v1.1.x", `v1.${Math.floor(NOW / 1000) + 5}.${"A".repeat(43)}`]) expect(verifyCookieValue(gate, bad, NOW)).toBe(false);
  });
});

describe("/api/browser/session", () => {
  it("reports status without revealing anything when the feature is off", async () => {
    const r = await call("GET", "status", {}, deps({ env: {} }));
    expect(await r.json()).toEqual({ enabled: false, authenticated: false, interactive: { enabled: false } });
  });
  it("is closed (503) for every other route while the feature is off", async () => {
    for (const [m, p] of [["POST", "session"], ["POST", "tasks"], ["GET", `tasks/${ID}`], ["POST", `tasks/${ID}/cancel`], ["GET", `tasks/${ID}/screenshot`]] as const) {
      expect((await call(m, p, { ...authed, body: m === "POST" ? { code: CODE } : undefined }, deps({ env: {} }))).status).toBe(503);
    }
    expect(backend).not.toHaveBeenCalled();
  });
  it("a correct code sets an HttpOnly SameSite=Strict Secure cookie scoped to the feature and returns no secret", async () => {
    const r = await call("POST", "session", { headers: same, body: { code: CODE } });
    expect(r.status).toBe(200);
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/); expect(set).toMatch(/SameSite=Strict/); expect(set).toMatch(/Secure/); expect(set).toMatch(/Path=\/api\/browser/);
    expect(await r.text()).not.toContain(CODE);
    expect(set).not.toContain(CODE);
    const value = /safwan_bc=([^;]+)/.exec(set)![1];
    expect(verifyCookieValue(gate, value, NOW)).toBe(true);
    expect((await call("GET", "status", { headers: { cookie: cookie(value) } })).status).toBe(200);
  });
  it("only failures count, per caller: a flood of forged-IP failures cannot lock the owner out (review F3)", async () => {
    for (let i = 0; i < 40; i++) await call("POST", "session", { headers: { ...same, "x-forwarded-for": `203.0.113.${i}` }, body: { code: "wrong" } });
    const r = await call("POST", "session", { headers: { ...same, "x-forwarded-for": "198.51.100.7" }, body: { code: CODE } });
    expect(r.status).toBe(200);                                             // the owner still gets in
    const again = await call("POST", "session", { headers: { ...same, "x-forwarded-for": "203.0.113.1" }, body: { code: CODE } });
    expect(again.status).toBe(200);                                         // even from an IP that already failed: the right code is never throttled
  });
  it("wrong codes get one uniform 401 and no cookie; attempts are rate limited", async () => {
    for (const body of [{ code: "wrong" }, { code: "" }, {}, { code: 5 }]) {
      const r = await call("POST", "session", { headers: same, body });
      expect(r.status).toBe(401); expect(r.headers.get("set-cookie")).toBeNull(); expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await call("POST", "session", { headers: same, body: { code: "wrong" } })).status;
    expect(last).toBe(429);
    expect((await call("POST", "session", { headers: same, body: { code: "x" } })).status).toBe(429);      // the same caller keeps getting throttled
  });
  it("rejects cross-site and header-less state-changing calls", async () => {
    for (const headers of [{}, { host: HOST }, { origin: "https://evil.test", host: HOST }, { ...same, "sec-fetch-site": "cross-site" }, { origin: "null", host: HOST }] as Record<string, string>[]) {
      expect((await call("POST", "session", { headers, body: { code: CODE } })).status).toBe(403);
    }
    expect(sameOrigin(req("POST", "x", { headers: same }))).toBe(true);
    expect(sameOrigin(req("POST", "x", { headers: { origin: `https://${HOST}`, "x-forwarded-host": HOST, host: "internal:8080" } }))).toBe(true);
  });
  it("logout clears the cookie", async () => {
    const r = await call("DELETE", "session", { headers: same });
    expect(r.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("tasks (authenticated)", () => {
  it("every task route needs the cookie", async () => {
    for (const [m, p] of [["POST", "tasks"], ["GET", `tasks/${ID}`], ["POST", `tasks/${ID}/cancel`], ["GET", `tasks/${ID}/screenshot`]] as const) {
      for (const cookieHeader of [undefined, cookie("v1.1.bad"), cookie(issueCookieValue(gate, NOW - (COOKIE_TTL_S + 5) * 1000))]) {
        const r = await call(m, p, { headers: { ...same, ...(cookieHeader ? { cookie: cookieHeader } : {}) }, body: m === "POST" && p === "tasks" ? { url: "https://example.com/", approved: true } : undefined });
        expect(r.status).toBe(401);
      }
    }
    expect(backend).not.toHaveBeenCalled();
  });
  it("starting needs explicit approval and an allow-listed address, and never reaches the API otherwise", async () => {
    for (const body of [{ url: "https://example.com/" }, { url: "https://example.com/", approved: "yes" }, { url: "https://example.com/", approved: 1 }]) {
      const r = await call("POST", "tasks", { ...authed, body });
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: "approval_required" });
    }
    for (const url of ["https://evil.test/", "http://example.com/", "https://169.254.169.254/", "https://example.com/?x=1", "https://example.com@evil.test/", 5, undefined]) {
      resetBrowserChatLimits(); // this test is about validation, not throttling (covered separately)
      expect(await (await call("POST", "tasks", { ...authed, body: { url, approved: true } })).json()).toEqual({ error: "url_not_allowed" });
    }
    expect((await call("POST", "tasks", { ...authed, body: "x" as unknown as object })).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("starting is rate limited", async () => {
    backend.mockResolvedValue(ok(202, { task: job() }));
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await call("POST", "tasks", { ...authed, body: { url: "https://example.com/", approved: true } })).status);
    expect(codes).toEqual([202, 202, 202, 202, 202, 202, 429, 429]);
    expect(backend).toHaveBeenCalledTimes(6);
  });
  it("forwards exactly {url} to the signed API path and rebuilds the reply from a whitelist", async () => {
    backend.mockResolvedValue(ok(202, { task: { ...job(), connectUrl: "wss://secret", sessionId: "s" } }));
    const r = await call("POST", "tasks", { ...authed, body: { url: "https://example.com/", approved: true, extra: "ignored" } });
    expect(r.status).toBe(202);
    const arg = backend.mock.calls[0][0];
    expect(arg).toMatchObject({ path: "/internal/v1/browser/tasks", method: "POST", body: { url: "https://example.com/" } });
    expect(JSON.stringify(arg.body)).not.toMatch(/approved|extra|cookie|code/i);
    const text = await r.text();
    expect(text).not.toMatch(/secret|sessionId|connectUrl/);
    expect(JSON.parse(text).task.id).toBe(ID);
  });
  it("a chat command handled locally is never forwarded to the AI provider (review F4)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../features/chat/chat-screen.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/if \(quick\.handled\) \{ if \(quick\.reply\)[\s\S]*?\}\s*else if \(ready && text\)/);
  });
  it("maps upstream failures to fixed codes and never leaks upstream text, addresses or secrets", async () => {
    const cases: [unknown, number, string][] = [
      [ok(409, { detail: { code: "busy" } }), 409, "busy"], [ok(404, { detail: { code: "not_found" } }), 404, "not_found"],
      [ok(400, { detail: { code: "url_not_allowed" } }), 400, "url_not_allowed"], [{ kind: "unavailable", status: 503 }, 503, "unavailable"],
      [{ kind: "unavailable", status: 502 }, 502, "unavailable"], [{ kind: "unconfigured" }, 503, "unavailable"], [{ kind: "unreachable" }, 502, "unavailable"],
      [{ kind: "rejected", status: 401 }, 502, "unavailable"], [{ kind: "invalid_response" }, 502, "unavailable"], [ok(200, { task: { id: "bad" } }), 502, "unavailable"],
      [ok(200, null), 502, "unavailable"],
    ];
    for (const [result, status, code] of cases) {
      backend.mockResolvedValueOnce(result);
      const r = await call("GET", `tasks/${ID}`, authed);
      expect([r.status, (await r.json()).error]).toEqual([status, code]);
    }
  });
  it("status and cancel use fixed paths; ids are validated first", async () => {
    backend.mockResolvedValue(ok(200, { task: job({ status: "cancelling" }) }));
    expect((await (await call("GET", `tasks/${ID}`, authed)).json()).task.status).toBe("cancelling");
    expect((await call("POST", `tasks/${ID}/cancel`, authed)).status).toBe(200);
    expect(backend.mock.calls.map((c) => [c[0].path, c[0].method ?? "GET"])).toEqual([[`/internal/v1/browser/tasks/${ID}`, "GET"], [`/internal/v1/browser/tasks/${ID}/cancel`, "POST"]]);
    backend.mockClear();
    for (const bad of ["x", "../../ping", ID.toUpperCase().replace(/[0-9]/g, "A"), `${ID}%2f..`]) {
      expect((await call("GET", `tasks/${bad}`, authed)).status).toBe(404);
      expect((await call("POST", `tasks/${bad}/cancel`, authed)).status).toBe(404);
    }
    expect(backend).not.toHaveBeenCalled();
  });
  it("cancel is also CSRF-protected", async () => {
    expect((await call("POST", `tasks/${ID}/cancel`, { headers: { cookie: cookie(), host: HOST, origin: "https://evil.test" } })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it("unknown routes and methods are 404", async () => {
    for (const [m, p] of [["GET", "tasks"], ["PUT", `tasks/${ID}`], ["GET", "nope"], ["DELETE", `tasks/${ID}`], ["POST", `tasks/${ID}/other`]] as const) {
      expect((await call(m, p, authed)).status).toBe(404);
    }
  });
});

describe("screenshot", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3000, 7)]);
  it("is served as a bounded, non-cacheable, inert JPEG", async () => {
    backend.mockResolvedValue(ok(200, { mimeType: "image/jpeg", base64: jpeg.toString("base64") }));
    const r = await call("GET", `tasks/${ID}/screenshot`, authed);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(jpeg);
    expect(backend.mock.calls[0][0].maxBytes).toBe(400_000);
  });
  it.each([
    [{ mimeType: "image/png", base64: "AAAA" }], [{ mimeType: "image/jpeg", base64: "<svg onload=alert(1)>" }], [{ mimeType: "image/jpeg", base64: Buffer.from("<html>").toString("base64") }],
    [{ mimeType: "image/jpeg", base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(270_000)]).toString("base64") }], [{}], [null],
  ])("refuses anything that is not a small JPEG (%#)", async (payload) => {
    backend.mockResolvedValue(ok(200, payload));
    expect((await call("GET", `tasks/${ID}/screenshot`, authed)).status).toBe(502);
  });
  it("a cancelled/expired task has no picture", async () => {
    backend.mockResolvedValue(ok(404, { detail: { code: "not_found" } }));
    expect((await call("GET", `tasks/${ID}/screenshot`, authed)).status).toBe(404);
  });
});

describe("callBackend size ceiling for large replies", () => {
  const big = (n: number) => new Response(JSON.stringify({ pad: "x".repeat(n) }), { status: 200, headers: { "content-type": "application/json" } });
  const e = { BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: SECRET };
  it("defaults to 64 KB, can be raised per call, and never beyond 512 KB", async () => {
    expect((await callBackend({ path: "/internal/v1/x", env: e, fetchImpl: (async () => big(100_000)) as unknown as typeof fetch })).kind).toBe("invalid_response");
    expect((await callBackend({ path: "/internal/v1/x", env: e, maxBytes: 400_000, fetchImpl: (async () => big(100_000)) as unknown as typeof fetch })).kind).toBe("ok");
    expect((await callBackend({ path: "/internal/v1/x", env: e, maxBytes: 10_000_000, fetchImpl: (async () => big(600_000)) as unknown as typeof fetch })).kind).toBe("invalid_response");
  });
});
