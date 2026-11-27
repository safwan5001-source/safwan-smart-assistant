import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, type Deps } from "@/server/basht-chat";
import { checkImages, decodedSize, MAX_MEDIA_BYTES } from "@/server/basht-extras";
import { issueCookieValue } from "@/server/assistant-chat-gate";
import { bashtMediaUrl, createBashtClient } from "@/lib/basht-client";

const CODE = "basht-owner-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const RUN = "d65fc949-4113-4cbe-a1a1-29f47545d14c";
const env = { BASHT_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const gate = readBashtGate(env)!;
const NOW = 1_800_000_000_000;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const authed = { headers: { ...same, cookie: `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}` } };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(30, 1)]).toString("base64");
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

let backend: ReturnType<typeof vi.fn>;
let fetchImpl: ReturnType<typeof vi.fn>;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, fetchImpl, ...over } as Deps);
const route = (p: string) => p.split("?")[0].split("/");
const call = (method: string, path: string, init?: Parameters<typeof req>[2], d: Deps = deps()) => handleBashtChat(req(method, path, init), route(path), d);
beforeEach(() => { backend = vi.fn(); fetchImpl = vi.fn(); resetBashtLimits(); });

describe("B2 photos in: /api/basht/send-media", () => {
  it("relays the photos and message to the fixed API route, with a long timeout", async () => {
    backend.mockResolvedValueOnce(ok(200, { run_id: RUN }));
    const r = await call("POST", "send-media", { ...authed, body: { message: " صف ", images: [{ mime: "image/png", data: PNG }], sessionKey: "agent:main:main" } });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ runId: RUN });
    const c = backend.mock.calls[0][0];
    expect(c).toMatchObject({ path: "/internal/v1/basht/send-media", method: "POST", body: { message: "صف", images: [{ mime: "image/png", data: PNG }] } });
    expect(c.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(JSON.stringify(c.body)).not.toContain("sessionKey");
  });
  it("refuses bad photos before the API: type, base64, count, size", async () => {
    for (const images of [[{ mime: "image/svg+xml", data: PNG }], [{ mime: "image/png", data: "%%%%" }], [], Array.from({ length: 9 }, () => ({ mime: "image/png", data: PNG })), "x"]) {
      expect((await call("POST", "send-media", { ...authed, body: { message: "x", images } })).status, JSON.stringify(images).slice(0, 40)).toBe(400);
    }
    expect(await (await call("POST", "send-media", { ...authed, body: { message: "x", images: Array.from({ length: 9 }, () => ({ mime: "image/png", data: PNG })) } })).json()).toEqual({ error: "too_many_images" });
    expect((await call("POST", "send-media", { ...authed, body: { message: "x".repeat(8001), images: [{ mime: "image/png", data: PNG }] } })).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("passes the engine's photo refusal codes through; others stay generic", async () => {
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "image_too_large" } }));
    expect(await (await call("POST", "send-media", { ...authed, body: { images: [{ mime: "image/png", data: PNG }] } })).json()).toEqual({ error: "image_too_large" });
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "secret upstream" } }));
    expect(await (await call("POST", "send-media", { ...authed, body: { images: [{ mime: "image/png", data: PNG }] } })).json()).toEqual({ error: "bad_request" });
  });
  it("needs the owner and same origin", async () => {
    expect((await call("POST", "send-media", { headers: same, body: { images: [{ mime: "image/png", data: PNG }] } })).status).toBe(401);
    const cross = { headers: { ...authed.headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" } };
    expect((await call("POST", "send-media", { ...cross, body: { images: [{ mime: "image/png", data: PNG }] } })).status).toBe(403);
    expect((await call("POST", "new", { ...cross, body: {} })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it("checkImages: decoded sizes and the per-message total", () => {
    expect(decodedSize("AAAA")).toBe(3); expect(decodedSize("AA==")).toBe(1);
    const big = "A".repeat(Math.ceil((10 * 1024 * 1024 + 3) / 3) * 4);
    expect(checkImages([{ mime: "image/jpeg", data: big }])).toEqual({ error: "image_too_large" });
    const nine = "A".repeat(Math.ceil((7.5 * 1024 * 1024) / 3) * 4);
    expect(checkImages([{ mime: "image/jpeg", data: nine }, { mime: "image/jpeg", data: nine }])).toEqual({ error: "images_too_large" });
    expect(checkImages([{ mime: "image/png", data: PNG }])).toEqual({ images: [{ mime: "image/png", data: PNG }] });
  });
});

describe("B2 files out: /api/basht/media", () => {
  const media = (q = `key=agent:main:app:owner&msg=msg-app-02&ref=${"a".repeat(32)}`) => call("GET", `media?${q}`, authed);
  it("fetches the bytes with a signed fixed route and serves them with safe headers", async () => {
    fetchImpl.mockResolvedValueOnce(new Response(Buffer.from("\x89PNG", "latin1"), { status: 200, headers: { "content-type": "image/png", "content-disposition": "attachment; filename*=UTF-8''chart.png" } }));
    const r = await media();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    // Review (Codex, integration PR): a cached private image could be served from the HTTP cache after sign-out
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''chart.png");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.internal.example/internal/v1/basht/media");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body)).toEqual({ key: "agent:main:app:owner", msg: "msg-app-02", ref: "a".repeat(32) });
    expect(init.headers["x-svc-sig"]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses malformed ids before the API", async () => {
    for (const q of ["key=../x&msg=msg-app-02&ref=" + "a".repeat(32), "key=agent:main:app:owner&msg=../../x&ref=" + "a".repeat(32), "key=agent:main:app:owner&msg=msg-app-02&ref=/etc/passwd"])
      expect((await media(q)).status, q).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses types outside the allowlist, oversized and failed answers", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await media()).status).toBe(415);
    fetchImpl.mockResolvedValueOnce(new Response("x", { status: 200, headers: { "content-type": "image/png", "content-length": String(MAX_MEDIA_BYTES + 1) } }));
    expect((await media()).status).toBe(413);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { code: "not_found", secret: "x" } }), { status: 404 }));
    expect(await (await media()).json()).toEqual({ error: "not_found" });
    fetchImpl.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://evil.example" } }));
    expect((await media()).status).toBe(503);
    fetchImpl.mockRejectedValueOnce(new Error("down"));
    expect((await media()).status).toBe(503);
  });
  it("needs the owner", async () => {
    expect((await call("GET", `media?key=agent:main:app:owner&msg=msg-app-02&ref=${"a".repeat(32)}`, { headers: same })).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("B1: new conversation, search, earlier/around history, run steps", () => {
  it("new and search relay to fixed routes; search needs a query", async () => {
    backend.mockResolvedValueOnce(ok(200, { at: 5, earlier: true, extra: 1 })).mockResolvedValueOnce(ok(200, { results: [{ key: "agent:main:app:owner", message_id: "msg-app-01" }] }));
    expect(await (await call("POST", "new", { ...authed, body: {} })).json()).toEqual({ at: 5, earlier: true });
    expect(await (await call("GET", `search?q=${encodeURIComponent("التقرير")}`, authed)).json()).toEqual({ results: [{ key: "agent:main:app:owner", message_id: "msg-app-01" }] });
    expect(backend.mock.calls.map((c) => [c[0].path, c[0].method, c[0].body])).toEqual([["/internal/v1/basht/new", "POST", {}], ["/internal/v1/basht/search", "POST", { q: "التقرير" }]]);
    expect(backend.mock.calls[0][0].timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect((await call("GET", "search?q=", authed)).status).toBe(400);
    expect((await call("GET", `search?q=${"x".repeat(201)}`, authed)).status).toBe(400);
  });
  it("history accepts an earlier cursor or a message id only", async () => {
    backend.mockResolvedValue(ok(200, { messages: [], earlier: null }));
    expect((await call("GET", "history?key=agent:main:app:owner&before=msg-app-02.reset-row-1", authed)).status).toBe(200);
    expect(backend.mock.calls.at(-1)![0].body).toEqual({ key: "agent:main:app:owner", limit: 50, before: "msg-app-02.reset-row-1" });
    expect((await call("GET", "history?key=agent:main:app:owner&around=msg-app-02", authed)).status).toBe(200);
    expect(backend.mock.calls.at(-1)![0].body).toEqual({ key: "agent:main:app:owner", limit: 50, around: "msg-app-02" });
    expect(backend.mock.calls.at(-1)![0].timeoutMs).toBeGreaterThanOrEqual(30_000);
    backend.mockClear();
    for (const q of ["before=../x", "around=a.b.c", "before=x"]) expect((await call("GET", `history?key=agent:main:app:owner&${q}`, authed)).status, q).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("a run carries its tool steps", async () => {
    backend.mockResolvedValueOnce(ok(200, { status: "running", text: "", failed: false, steps: [{ tool: "web_search", done: false }] }));
    expect((await (await call("GET", `runs/${RUN}`, authed)).json()).steps).toEqual([{ tool: "web_search", done: false }]);
  });
});

describe("browser client (B1/B2)", () => {
  it("historyPage, sendMedia, newConversation, search and media URLs", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const c = createBashtClient(async (url, init) => {
      seen.push([String(url), init]);
      const u = String(url);
      const body = u.startsWith("/api/basht/history") ? { messages: [{ role: "system", kind: "reset", text: "", at: 1, id: "reset-row-1" }], earlier: "reset-row-1", has_more: false, next_offset: null }
        : u.startsWith("/api/basht/send-media") ? { runId: RUN } : u.startsWith("/api/basht/new") ? { at: 1, earlier: true } : { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    expect(await c.historyPage("agent:main:app:owner", { before: "reset-row-1" })).toEqual({ messages: [{ role: "system", kind: "reset", text: "", at: 1, id: "reset-row-1" }], earlier: "reset-row-1", hasMore: false, nextOffset: null });
    expect(seen.at(-1)![0]).toBe("/api/basht/history?key=agent%3Amain%3Aapp%3Aowner&before=reset-row-1");
    expect(await c.sendMedia("x", [{ mime: "image/jpeg", data: "AAAA" }])).toBe(RUN);
    expect(JSON.parse(String(seen.at(-1)![1]!.body))).toEqual({ message: "x", images: [{ mime: "image/jpeg", data: "AAAA" }] });
    expect(await c.newConversation()).toEqual({ at: 1, earlier: true });
    expect(await c.search("تقرير")).toEqual([]);
    expect(seen.at(-1)![0]).toBe(`/api/basht/search?q=${encodeURIComponent("تقرير")}`);
    expect(bashtMediaUrl("agent:main:app:owner", "msg-1", "a".repeat(32))).toBe(`/api/basht/media?key=agent%3Amain%3Aapp%3Aowner&msg=msg-1&ref=${"a".repeat(32)}`);
  });
  it("photo refusals become Arabic messages", async () => {
    const c = createBashtClient(async () => new Response(JSON.stringify({ error: "too_many_images" }), { status: 400 }));
    await expect(c.sendMedia("x", [])).rejects.toThrow("8 صور");
  });
});
