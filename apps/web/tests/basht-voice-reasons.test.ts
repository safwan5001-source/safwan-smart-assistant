import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, VOICE_FEATURES, VOICE_REASONS, voiceStatusView, type Deps } from "@/server/basht-chat";
import { issueCookieValue } from "@/server/assistant-chat-gate";
import { streamBackend } from "@/server/backend";

const CODE = "basht-owner-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const env = { BASHT_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const gate = readBashtGate(env)!;
const NOW = 1_800_000_000_000;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const authed = { headers: { ...same, cookie: `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}` } };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

let backend: ReturnType<typeof vi.fn>;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const call = (method: string, path: string, init?: Parameters<typeof req>[2], d: Deps = deps()) => handleBashtChat(req(method, path, init), path.split("/"), d);
beforeEach(() => { backend = vi.fn(); resetBashtLimits(); });

describe("voice failure reasons (additive, allowlisted)", () => {
  const stream = vi.fn();
  const d = () => deps({ streamBackend: stream as unknown as Deps["streamBackend"] });
  beforeEach(() => stream.mockReset());
  const speak = (answer: unknown) => { stream.mockResolvedValueOnce(answer); return call("POST", "speak", { ...authed, body: { text: "x" } }, d()); };

  it("speak: every allowlisted reason rides along; code and HTTP status are exactly today's", async () => {
    for (const reason of VOICE_REASONS) {
      for (const [answer, status, error] of [
        [{ kind: "error", status: 400, code: "voice_unavailable", reason }, 503, "voice_unavailable"],
        [{ kind: "error", status: 502, code: "unavailable", reason }, 503, "unavailable"],
        [{ kind: "error", status: 429, code: "rate_limited", reason }, 429, "rate_limited"],
      ] as const) {
        const r = await speak(answer);
        expect([r.status, await r.json()], JSON.stringify(answer)).toEqual([status, { error, reason }]);
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
    }
  });
  it("speak: without a reason (older engine) the body is exactly {error}; a reason outside the list is dropped, never forwarded", async () => {
    expect(await (await speak({ kind: "error", status: 400, code: "voice_unavailable" })).json()).toEqual({ error: "voice_unavailable" });
    for (const reason of ["provider said sk-LEAK", "TIMEOUT", "", 5, null, { a: 1 }, ["timeout"], "../x"]) {
      const r = await speak({ kind: "error", status: 400, code: "voice_unavailable", reason });
      expect([r.status, await r.json()], String(reason)).toEqual([503, { error: "voice_unavailable" }]);
    }
    const unknownCode = await speak({ kind: "error", status: 400, code: "free text from engine", reason: "timeout" });
    expect([unknownCode.status, await unknownCode.json()]).toEqual([503, { error: "unavailable", reason: "timeout" }]);
    expect(await (await speak({ kind: "unreachable" })).json()).toEqual({ error: "unavailable" });
  });
  it("transcribe: reads {detail:{code,reason}} from the API the same way", async () => {
    const audio = new Uint8Array(2048).fill(7);
    const post = () => handleBashtChat(new Request(`https://${HOST}/api/basht/transcribe`, { method: "POST", headers: { ...authed.headers, "content-type": "audio/ogg" }, body: audio }), ["transcribe"], deps());
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "voice_unavailable", reason: "tool_denied" } }));
    let r = await post();
    expect([r.status, await r.json()]).toEqual([503, { error: "voice_unavailable", reason: "tool_denied" }]);
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "voice_unavailable", reason: "secret text" } }));
    r = await post();
    expect([r.status, await r.json()]).toEqual([503, { error: "voice_unavailable" }]);
    backend.mockResolvedValueOnce(ok(422, { detail: { code: "no_speech", reason: "timeout" } }));
    r = await post();
    expect([r.status, await r.json()]).toEqual([422, { error: "no_speech", reason: "timeout" }]);
    backend.mockResolvedValueOnce(ok(502, { detail: { code: "weird" } }));
    r = await post();
    expect([r.status, await r.json()]).toEqual([503, { error: "unavailable" }]);
  });
});

describe("streamBackend: the reason is a short token, from any error status; the code stays 4xx-only", () => {
  const run = (status: number, body: string) =>
    streamBackend({ path: "/internal/v1/basht/speak", body: {}, env, fetchImpl: vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch });
  it("carries detail.reason when it is a plain token", async () => {
    expect(await run(400, '{"detail":{"code":"voice_unavailable","reason":"identity_mismatch"}}')).toEqual({ kind: "error", status: 400, code: "voice_unavailable", reason: "identity_mismatch" });
    expect(await run(502, '{"detail":{"code":"basht_unavailable","reason":"link_down"}}')).toEqual({ kind: "error", status: 502, code: "unavailable", reason: "link_down" });
  });
  it("ignores anything that is not a token, and keeps its old shape without one", async () => {
    expect(await run(400, '{"detail":{"code":"voice_unavailable","reason":"<b>x</b> sk-LEAK"}}')).toEqual({ kind: "error", status: 400, code: "voice_unavailable" });
    expect(await run(500, "trace sk-ant-LEAK")).toEqual({ kind: "error", status: 500, code: "unavailable" });
    expect(await run(401, '{"detail":{"code":"x","reason":"timeout"}}')).toEqual({ kind: "error", status: 401, code: "unavailable" });
  });
});

describe("GET /api/basht/voice-status", () => {
  const STATUS = { speak: "ready", features: ["voice.speak.v2", "signing.v1"] };
  it("needs the owner session (401 / 503 disabled), reads need no same-origin header, and nothing reaches the API without it", async () => {
    expect((await call("GET", "voice-status", { headers: same })).status).toBe(401);
    expect((await call("GET", "voice-status", authed, deps({ env: { ...env, BASHT_CHAT_ACCESS_CODE: "short" } }))).status).toBe(503);
    expect(backend).not.toHaveBeenCalled();
  });
  it("relays one fixed GET and returns the fixed shape with no-store", async () => {
    backend.mockResolvedValueOnce(ok(200, STATUS));
    const r = await call("GET", "voice-status", authed);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual(STATUS);
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/voice-status", method: "GET" });
    expect(backend.mock.calls[0][0].body).toBeUndefined();
  });
  it("passes a state with its allowlisted reason", async () => {
    backend.mockResolvedValueOnce(ok(200, { speak: "mismatch", reason: "identity_mismatch", features: [] }));
    expect(await (await call("GET", "voice-status", authed)).json()).toEqual({ speak: "mismatch", reason: "identity_mismatch", features: [] });
  });
  it("filters: unknown fields, free-text reasons, unknown states and unlisted features never reach the browser", async () => {
    backend.mockResolvedValueOnce(ok(200, { speak: "degraded", reason: "key sk-LEAK rejected", features: ["voice.speak.v2", "internal.debug", 7], tts: { voiceId: "LEAK" }, link: {} }));
    expect(await (await call("GET", "voice-status", authed)).json()).toEqual({ speak: "degraded", features: ["voice.speak.v2"] });
    backend.mockResolvedValueOnce(ok(200, { speak: "on fire", reason: "timeout", features: ["signing.v1"] }));
    expect(await (await call("GET", "voice-status", authed)).json()).toEqual({ speak: "unknown" });
    expect(voiceStatusView(null)).toEqual({ speak: "unknown" });
    expect(voiceStatusView("ready")).toEqual({ speak: "unknown" });
    expect(voiceStatusView({ speak: "ready" })).toEqual({ speak: "ready", features: [] });
    expect([...VOICE_FEATURES]).toEqual(expect.arrayContaining(["voice.speak.v2", "signing.v1"]));
  });
  it("any failure on the way is 200 {speak:'unknown'}, never an error to the UI", async () => {
    for (const answer of [{ kind: "unreachable" }, { kind: "unconfigured" }, { kind: "unavailable", status: 503 }, { kind: "rejected", status: 401 }, { kind: "invalid_response" },
      ok(400, { detail: { code: "x" } }), ok(200, null), ok(200, { speak: 5 })]) {
      backend.mockResolvedValueOnce(answer);
      const r = await call("GET", "voice-status", authed);
      expect([r.status, await r.json()], JSON.stringify(answer)).toEqual([200, { speak: "unknown" }]);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("is a read: the read limiter applies and a POST is not a voice-status route", async () => {
    expect((await call("POST", "voice-status", { ...authed, body: {} })).status).toBe(404);
  });
});
