import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_KEYS, ENGINE_VOICE_REASONS, KNOWN_FEATURES, MAX_BYTES, MAX_COUNT_ATTACH, boundedInt, engineStatusWire, parseEngineStatus, unknownEngineStatus,
} from "@/lib/engine-status";
import { VOICE_REASONS, createBashtClient } from "@/lib/basht-client";
import { createEngineStatusStore, ENGINE_STATUS_MIN_MS } from "@/lib/engine-status-store";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, type Deps } from "@/server/basht-chat";
import { issueCookieValue } from "@/server/assistant-chat-gate";

const FULL = {
  ok: true, appSession: "agent:main:app", engine: { version: "2026.5.1", host: "engine.internal" }, wrapper: { commit: "0123456789ab", env: { TOKEN: "SECRET" } },
  features: [...KNOWN_FEATURES, "internal.debug"], attachments: { maxImages: 8, maxImageBytes: 10_485_760, maxTotalImageBytes: 19_922_944, maxFileBytes: 26_214_400, maxInlineBytes: 8_388_608, path: "/data" },
  link: { state: "up", pendingApprovals: 2, lastError: "ws://10.0.0.1 refused" }, voice: { speak: "degraded", reason: "link_down", warnings: ["/data/x"] },
  runs: { active: 1, engine: 3, cron: 0, approvalsPending: 2, total: 4, complete: true }, signing: { mode: "optional", active: true, reason: "path /run/secret" },
};

describe("parseEngineStatus: the fixed, validated shape", () => {
  it("reads every field the engine sends and nothing else", () => {
    const s = parseEngineStatus(FULL);
    expect(s).toEqual({
      reachable: true, version: "2026.5.1", commit: "0123456789ab", features: [...KNOWN_FEATURES],
      attachments: { maxImages: 8, maxImageBytes: 10_485_760, maxTotalImageBytes: 19_922_944, maxFileBytes: 26_214_400, maxInlineBytes: 8_388_608 },
      link: { state: "up", pendingApprovals: 2 }, voice: { speak: "degraded", reason: "link_down" },
      runs: { active: 1, total: 4, approvalsPending: 2, complete: true }, signing: { mode: "optional", active: true },
    });
    const text = JSON.stringify(s);
    for (const leak of ["SECRET", "/data", "/run", "10.0.0.1", "engine.internal", "agent:main", "debug"]) expect(text).not.toContain(leak);
  });
  it("an older engine: missing fields are absent / unknown, never defaulted to something that looks fine", () => {
    expect(parseEngineStatus({ ok: true })).toEqual({ ...unknownEngineStatus(), reachable: true });
    expect(parseEngineStatus({ ok: true, link: { state: "up" }, voice: { speak: "ready" }, features: ["voice.speak.v2"] })).toMatchObject({
      reachable: true, version: null, commit: null, features: ["voice.speak.v2"], attachments: {}, runs: null, signing: { mode: "unknown", active: null },
      link: { state: "up", pendingApprovals: null }, voice: { speak: "ready" },
    });
  });
  it.each([null, undefined, 5, "ok", [], { ok: false }, { ok: false, link: { state: "up" } }])("%j is not an answer: reachable false and nothing else", (v) => {
    expect(parseEngineStatus(v)).toEqual(unknownEngineStatus());
  });
  it("each field is judged on its own: one bad field does not discard the good ones", () => {
    const s = parseEngineStatus({ ...FULL, wrapper: { commit: "NOT HEX" }, attachments: { maxImages: "8", maxFileBytes: 100 }, link: { state: "sideways", pendingApprovals: 1 } });
    expect(s).toMatchObject({ reachable: true, commit: null, version: "2026.5.1", attachments: { maxFileBytes: 100 }, link: { state: "unknown", pendingApprovals: 1 } });
  });
  it.each(["a".repeat(33), "", "1.0 beta", "../x", "1.0\n2", 5, null, ["1"], "é1", "-1"])("version %j is dropped", (v) => {
    expect(parseEngineStatus({ ok: true, engine: { version: v } }).version).toBeNull();
  });
  it.each(["XYZ", "0123456789abc", "012345", "0123456789AB", " 0123456789a", "", null, 5, ["a"], "../../..", "0123 56789ab"])("commit %j is dropped", (v) => {
    expect(parseEngineStatus({ ok: true, wrapper: { commit: v } }).commit).toBeNull();
  });
  it.each(["0123456789ab", "0123456"])("commit %j is accepted (7-12 lowercase hex)", (v) => {
    expect(parseEngineStatus({ ok: true, wrapper: { commit: v } }).commit).toBe(v);
  });
  it.each([true, false, -1, 1.5, "8", null, [8], { a: 1 }, 2 ** 40, 1e9 + 0.5, NaN, Infinity])("attachment limit %j is dropped", (v) => {
    expect(parseEngineStatus({ ok: true, attachments: { maxImages: v, maxFileBytes: v } }).attachments).toEqual({});
  });
  it("attachment bounds: a count up to 1000, byte limits up to 1 GiB, zero allowed, one more is dropped", () => {
    expect(parseEngineStatus({ ok: true, attachments: { maxImages: MAX_COUNT_ATTACH, maxFileBytes: MAX_BYTES, maxImageBytes: 0 } }).attachments).toEqual({ maxImages: 1000, maxFileBytes: 1024 ** 3, maxImageBytes: 0 });
    expect(parseEngineStatus({ ok: true, attachments: { maxImages: MAX_COUNT_ATTACH + 1, maxFileBytes: MAX_BYTES + 1 } }).attachments).toEqual({});
    expect(boundedInt(5, 5)).toBe(5); expect(boundedInt(6, 5)).toBeNull(); expect(boundedInt(-0.5, 5)).toBeNull();
  });
  it.each(["sideways", "UP", "", null, 3, ["up"]])("link.state %j reads as unknown", (v) => {
    expect(parseEngineStatus({ ok: true, link: { state: v } }).link.state).toBe("unknown");
  });
  it.each(["off", "connecting", "up", "down"])("link.state %s passes", (v) => { expect(parseEngineStatus({ ok: true, link: { state: v } }).link.state).toBe(v); });
  it("voice: only an allowlisted state and reason; a free-text reason is dropped, an unknown state leaves voice unknown", () => {
    expect(parseEngineStatus({ ok: true, voice: { speak: "ready", reason: "key sk-LEAK rejected" } }).voice).toEqual({ speak: "ready" });
    expect(parseEngineStatus({ ok: true, voice: { speak: "loud", reason: "timeout" } }).voice).toEqual({ speak: "unknown" });
    expect(parseEngineStatus({ ok: true, voice: "ready" }).voice).toEqual({ speak: "unknown" });
  });
  it("signing: an unknown mode is unknown, active must be a real boolean", () => {
    expect(parseEngineStatus({ ok: true, signing: { mode: "paranoid", active: "yes" } }).signing).toEqual({ mode: "unknown", active: null });
    expect(parseEngineStatus({ ok: true, signing: { mode: "required", active: false } }).signing).toEqual({ mode: "required", active: false });
  });
  it("runs: bounded counts, `complete` only for a literal true", () => {
    expect(parseEngineStatus({ ok: true, runs: { active: "1", total: -4, approvalsPending: null, complete: "true" } }).runs).toEqual({ active: null, total: null, approvalsPending: null, complete: false });
  });
  it("features: known ids only, in the app's order, nothing long or non-string, a non-array is no features", () => {
    expect(parseEngineStatus({ ok: true, features: ["runs.runId.v1", "voice.speak.v2", "x".repeat(500), { a: 1 }, 5, "voice.speak.v2"] }).features).toEqual(["voice.speak.v2", "runs.runId.v1"]);
    expect(parseEngineStatus({ ok: true, features: "voice.speak.v2" }).features).toEqual([]);
  });
  it("a huge features list is read only up to 64 entries", () => {
    const many = [...Array(200).fill("junk"), "signing.v1"];
    expect(parseEngineStatus({ ok: true, features: many }).features).toEqual([]);
  });
});

describe("the wire shape the BFF sends: parse(wire(x)) is x", () => {
  it("round-trips a full, a partial and an unreachable status", () => {
    for (const raw of [FULL, { ok: true }, { ok: true, link: { state: "down" }, signing: { active: false } }, { ok: true, runs: { complete: false } }, null]) {
      const s = parseEngineStatus(raw);
      expect(parseEngineStatus(engineStatusWire(s))).toEqual(s);
    }
    expect(engineStatusWire(unknownEngineStatus())).toEqual({ ok: false });
  });
  it("the wire never carries a field the parser does not own", () => {
    const keys = Object.keys(engineStatusWire(parseEngineStatus(FULL))).sort();
    expect(keys).toEqual(["attachments", "engine", "features", "link", "ok", "runs", "signing", "voice", "wrapper"]);
  });
});

describe("shared contracts", () => {
  it("the voice reasons equal the browser client's list and the shared contract file", () => {
    expect([...ENGINE_VOICE_REASONS]).toEqual([...VOICE_REASONS]);
    const contract = JSON.parse(readFileSync(resolve(__dirname, "../../../services/api/tests/fixtures/voice-contract.json"), "utf8")) as { reasons: string[]; features: string[] };
    expect([...ENGINE_VOICE_REASONS]).toEqual(contract.reasons);
    expect(KNOWN_FEATURES.slice(0, contract.features.length)).toEqual(contract.features); // the four voice ids first, then the batch-3 ids
  });
  it("the attachment keys are the five the engine publishes", () => {
    expect([...ATTACHMENT_KEYS]).toEqual(["maxImages", "maxImageBytes", "maxTotalImageBytes", "maxFileBytes", "maxInlineBytes"]);
  });
});

describe("GET /api/basht/engine-status (BFF)", () => {
  const CODE = "basht-owner-code-0123456789-abcdefghijkl";
  const HOST = "app.example.test";
  const env = { BASHT_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
  const gate = readBashtGate(env)!;
  const NOW = 1_800_000_000_000;
  const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
  const authed = { headers: { ...same, cookie: `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}` } };
  const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
  let backend: ReturnType<typeof vi.fn>;
  const deps = (): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW });
  const get = (init: { headers?: Record<string, string> } = {}) => handleBashtChat(new Request(`https://${HOST}/api/basht/engine-status`, { method: "GET", headers: init.headers }), ["engine-status"], deps());
  beforeEach(() => { backend = vi.fn(); resetBashtLimits(); });

  it("needs the owner session; nothing reaches the API without it", async () => {
    expect((await get({ headers: same })).status).toBe(401);
    expect(backend).not.toHaveBeenCalled();
  });
  it("relays one fixed GET and answers the validated wire shape with no-store; leaks are dropped even if the API passed them", async () => {
    backend.mockResolvedValueOnce(ok(200, FULL));
    const r = await get(authed);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(parseEngineStatus(body).reachable).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|\/data|engine\.internal|10\.0\.0\.1|agent:main|debug/);
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/engine-status", method: "GET" });
  });
  it("any failure on the way is 200 {ok:false}, never an error to the UI", async () => {
    for (const answer of [{ kind: "unreachable" }, { kind: "unconfigured" }, { kind: "unavailable", status: 503 }, { kind: "invalid_response" }, ok(400, {}), ok(200, null), ok(200, { ok: false }), ok(200, "x")]) {
      backend.mockResolvedValueOnce(answer);
      const r = await get(authed);
      expect([r.status, await r.json()], JSON.stringify(answer)).toEqual([200, { ok: false }]);
    }
  });
});

describe("browser client + store: no polling, cached", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("401/403/404/429/503 = null (not asked: no data), a network failure or a non-answer = reachable false", async () => {
    const mk = (f: () => Promise<Response>) => createBashtClient(f as unknown as typeof fetch);
    expect(await mk(async () => res(401, { error: "unauthorized" })).engineStatus()).toBeNull();
    expect(await mk(async () => res(403, { error: "forbidden" })).engineStatus()).toBeNull();
    expect(await mk(async () => res(503, { error: "disabled" })).engineStatus()).toBeNull();
    expect(await mk(async () => res(503, { error: "unavailable" })).engineStatus()).toBeNull(); // an outage of the door is no data, not "asked and nobody answered"
    expect(await mk(async () => res(500, { error: "x" })).engineStatus()).toEqual(unknownEngineStatus());
    expect(await mk(async () => { throw new Error("net"); }).engineStatus()).toEqual(unknownEngineStatus());
    expect(await mk(async () => res(200, { ok: true, link: { state: "up" } })).engineStatus()).toMatchObject({ reachable: true, link: { state: "up" } });
    expect(await mk(async () => new Response("<html>", { status: 200 })).engineStatus()).toEqual(unknownEngineStatus());
  });
  it("the store reads once, shares an in-flight read, and rereads no sooner than 30 s (force skips only the age)", async () => {
    let t = 1000;
    const fetch = vi.fn(async () => parseEngineStatus({ ok: true }));
    const store = createEngineStatusStore({ fetch, now: () => t });
    expect(ENGINE_STATUS_MIN_MS).toBe(30_000);
    expect(store.get()).toEqual({ status: null, at: 0 });
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 29_999; await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 1; await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    await store.refresh({ force: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(store.get().at).toBe(t);
  });
  it("a throwing fetch becomes `null` (no data) and notifies subscribers; reset clears", async () => {
    const store = createEngineStatusStore({ fetch: async () => { throw new Error("x"); }, now: () => 5 });
    const seen = vi.fn();
    store.subscribe(seen);
    await store.refresh();
    expect(store.get()).toEqual({ status: null, at: 5 });
    expect(seen).toHaveBeenCalled();
    store.reset();
    expect(store.get()).toEqual({ status: null, at: 0 });
  });
  it("there is no timer in the store module (no polling storm; hidden pages cannot poll)", () => {
    const src = readFileSync(resolve(__dirname, "../lib/engine-status-store.ts"), "utf8");
    expect(src).not.toMatch(/setInterval|setTimeout/); // weaker source-contract check, flagged: complements the behavioural tests above
    expect(src).toMatch(/visibilityState !== "hidden"/);
  });
});
