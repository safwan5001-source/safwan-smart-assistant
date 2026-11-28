import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashtError } from "@/lib/basht-client";
import { createVoicePlayer, voiceAvailability } from "@/lib/basht-voice";
import { headerModel } from "@/lib/basht-model";
import { createEngineStatusStore } from "@/lib/engine-status-store";
import { parseEngineStatus } from "@/lib/engine-status";
import { attachHealthRefresh, createLatestReader, resetHealthThrottle } from "@/lib/status-refresh";
import { readVoice } from "@/lib/status-model";
import { deferred, FakeEl, flush } from "./voice-fakes";

const learnedNow = () => { const l = voiceAvailability.get(); return { speak: l.speak, reason: l.reason, at: l.speakAt, failed: l.fail, transcribe: l.transcribe }; };

describe("1: only voice-relevant failures change the voice row", () => {
  beforeEach(() => { voiceAvailability.reset(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const proven = async () => {
    const el = new FakeEl();
    const q: ReturnType<typeof deferred<Blob>>[] = [];
    const p = createVoicePlayer({ speak: () => { const d = deferred<Blob>(); q.push(d); return d.promise; }, audio: () => el, url: { create: () => "blob:x", revoke: () => {} } });
    const a = p.play("m1", "نص.");
    q[0].resolve(new Blob(["a"])); await flush(); el.emit("playing"); el.emit("ended"); await a;
    expect(readVoice(null, learnedNow()).level).toBe("tested_ok");
    vi.advanceTimersByTime(1000);
    return { p, q, el };
  };
  for (const code of ["unauthorized", "rate_limited", "network", "timeout", "bad_request", "unavailable"]) {
    it(`a ${code} failure of the request (no audio arrived) leaves a proven voice exactly as it was`, async () => {
      const { p, q } = await proven();
      const before = voiceAvailability.get();
      const b = p.play("m2", "نص آخر.");
      q[1].reject(new BashtError(code)); await flush(); expect(await b).toBe("error");
      expect(voiceAvailability.get().fail, code).toBeNull();
      expect(voiceAvailability.get().speakAt).toBe(before.speakAt);
      expect(readVoice(null, learnedNow()), code).toMatchObject({ level: "tested_ok" });
    });
  }
  it("a request failure with NO earlier proof does not invent a voice reading either", async () => {
    const el = new FakeEl(); const d = deferred<Blob>();
    const p = createVoicePlayer({ speak: () => d.promise, audio: () => el, url: { create: () => "blob:x", revoke: () => {} } });
    const a = p.play("m", "نص."); d.reject(new BashtError("network")); await flush(); await a;
    expect(readVoice(null, learnedNow()).level).toBe("unknown");
  });
  it("audio that arrived and did not play, and an engine refusal with its reason, are still recorded (degraded)", async () => {
    const { p, q, el } = await proven();
    el.play.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const b = p.play("m2", "نص.");
    q[1].resolve(new Blob(["a"])); await flush(); await b;
    expect(readVoice(null, learnedNow())).toMatchObject({ level: "degraded", detail: expect.stringContaining("تعذّر تشغيله") });
    const c = p.play("m3", "نص.");
    q[2].reject(new BashtError("voice_unavailable", "provider_error")); await flush(); await c;
    expect(readVoice(null, learnedNow())).toMatchObject({ level: "degraded", detail: expect.stringContaining("مزوّد") });
  });
});

describe("6: a durable «no» stays «متوقف» whatever transient failure is recorded after it", () => {
  it("down beats a later transient failure", () => {
    const r = readVoice(null, { speak: "no", reason: "no_tts_config", at: 100, failed: { at: 200, kind: "unavailable", reason: "link_down" } });
    expect(r.level).toBe("down");
    expect(r.detail).toContain("نطق");
  });
  it("and through the live store: a transient failure after a durable no never lifts the row to degraded", () => {
    voiceAvailability.reset();
    voiceAvailability.set("speak", "no", "no_tts_config");
    voiceAvailability.setFailure("unavailable", "link_down");
    expect(readVoice(null, learnedNow()).level).toBe("down");
  });
});

describe("2: nested provider refs in the chat header", () => {
  const st = (id: string, reply: { provider: string | null; model: string }, over = {}) => ({ model: { id, source: "override", provider: null }, fallback: null, last_reply: { ...reply, at: 1 }, ...over }) as never;
  it("openrouter/anthropic/claude-sonnet-4 selected, reply {provider: openrouter, model: anthropic/claude-sonnet-4}: the same model", () => {
    expect(headerModel(st("openrouter/anthropic/claude-sonnet-4", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }), []).differs).toBe(false);
  });
  it("the other way round: selected anthropic/claude-sonnet-4, executed the full openrouter ref", () => {
    expect(headerModel(st("anthropic/claude-sonnet-4", { provider: null, model: "openrouter/anthropic/claude-sonnet-4" }), []).differs).toBe(false);
  });
  it("with the fast variant and a bare id mixed in", () => {
    expect(headerModel(st("openrouter/xai/grok-3-fast", { provider: "openrouter", model: "xai/grok-3" }), []).differs).toBe(false);
    expect(headerModel(st("grok-3", { provider: null, model: "xai/grok-3-fast" }), []).differs).toBe(false);
  });
  it("genuinely different models or providers still differ", () => {
    for (const [sel, rep] of [["openrouter/anthropic/claude-sonnet-4", { provider: "openrouter", model: "openai/gpt-x" }], ["openai/gpt-x", { provider: "azure", model: "gpt-x" }],
      ["openrouter/anthropic/claude-sonnet-4", { provider: "openrouter", model: "anthropic/claude-opus-4" }], ["anthropic/claude", { provider: null, model: "anthropic/claude-sonnet-4" }],
      ["a/b/gpt-x", { provider: null, model: "c/b/gpt-x" }]] as const) {
      expect(headerModel(st(sel, rep), []).differs, `${sel} vs ${rep.provider}/${rep.model}`).toBe(true);
    }
  });
});

describe("3: a «no data» answer after a good read", () => {
  const good = () => parseEngineStatus({ ok: true, ageMs: 0, link: { state: "up" }, voice: { speak: "ready" } });
  it("keeps the previous snapshot AND the 30 s floor (no refetch storm against a limiter that just said no)", async () => {
    let t = 1000, calls = 0;
    const answers = [good(), null, null, good()];
    const store = createEngineStatusStore({ fetch: async () => answers[calls++], now: () => t });
    await store.refresh();
    const first = store.get();
    t += 31_000; await store.refresh(); // the 429
    expect(calls).toBe(2);
    expect(store.get().status).toBe(first.status); // still what we knew
    t += 5_000; await store.refresh(); await store.refresh();
    expect(calls, "floor restarted by the null answer").toBe(2);
    t += 25_000; await store.refresh();
    expect(calls).toBe(3);
  });
  it("the FIRST ever null still allows a retry right after sign-in", async () => {
    let t = 0, calls = 0;
    const answers = [null, good()];
    const store = createEngineStatusStore({ fetch: async () => answers[calls++], now: () => t });
    await store.refresh(); t = 10_000; await store.refresh();
    expect(calls).toBe(2);
    expect(store.get().status?.reachable).toBe(true);
  });
  it("force still bypasses the floor", async () => {
    const t = 0; let calls = 0;
    const store = createEngineStatusStore({ fetch: async () => { calls++; return good(); }, now: () => t });
    await store.refresh(); await store.refresh({ force: true });
    expect(calls).toBe(2);
  });
});

describe("4: health reads are ordered, stamped at the start, and throttled once for everyone", () => {
  it("an older slow answer never overwrites a newer one, and the stamp is the request START", async () => {
    let t = 1000;
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const r = createLatestReader(() => { const d = deferred<string>(); pending.push(d); return d.promise; }, () => t);
    const got: [string, number][] = [];
    r.start((v, at) => got.push([v, at]));
    t = 2000; r.start((v, at) => got.push([v, at]));
    t = 9000;
    pending[1].resolve("new"); await flush();
    pending[0].resolve("old"); await flush();
    expect(got).toEqual([["new", 2000]]);
  });
  it("an older read cannot end «checking» early: only the newest delivers", async () => {
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const r = createLatestReader(() => { const d = deferred<string>(); pending.push(d); return d.promise; });
    const got: string[] = [];
    r.start((v) => got.push(v)); r.start((v) => got.push(v));
    pending[0].resolve("old"); await flush();
    expect(got).toEqual([]);
    pending[1].resolve("new"); await flush();
    expect(got).toEqual(["new"]);
  });
  it("cancel() drops answers still in flight (unmount)", async () => {
    const d = deferred<string>(); const got: string[] = [];
    const r = createLatestReader(() => d.promise);
    r.start((v) => got.push(v)); r.cancel(); d.resolve("x"); await flush();
    expect(got).toEqual([]);
  });
  it("the focus/visible throttle is shared by every mounted indicator, not per instance", () => {
    resetHealthThrottle();
    const mk = () => { const h = new Map<string, () => void>(); const tgt = { addEventListener: (t: string, f: () => void) => h.set(t, f), removeEventListener: (t: string) => h.delete(t) }; return { h, tgt }; };
    const a = mk(), b = mk();
    let t = 100_000; const refreshA = vi.fn(), refreshB = vi.fn();
    attachHealthRefresh({ getCheckedAt: () => 0, refreshQuiet: refreshA, now: () => t, win: a.tgt, doc: { ...a.tgt, visibilityState: "visible" } });
    attachHealthRefresh({ getCheckedAt: () => 0, refreshQuiet: refreshB, now: () => t, win: b.tgt, doc: { ...b.tgt, visibilityState: "visible" } });
    a.h.get("focus")!();
    b.h.get("focus")!(); // the second screen, same moment
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).not.toHaveBeenCalled();
    t += 30_000; b.h.get("focus")!();
    expect(refreshB).toHaveBeenCalledTimes(1);
  });
});
