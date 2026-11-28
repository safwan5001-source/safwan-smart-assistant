import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashtError } from "@/lib/basht-client";
import { createVoicePlayer, voiceAvailability, type PlayerPhase } from "@/lib/basht-voice";
import { readVoice } from "@/lib/status-model";
import { deferred, FakeEl, flush } from "./voice-fakes";

/** A player on a fake element; `speak` answers from a queue of deferreds the test resolves. */
function rig(opts: { stallMs?: number; startMs?: number } = {}) {
  const el = new FakeEl();
  const asked: string[] = [], signals: AbortSignal[] = [];
  const pending: ReturnType<typeof deferred<Blob>>[] = [];
  const made: string[] = [], revoked: string[] = [];
  const p = createVoicePlayer({
    speak: (t, s) => { asked.push(t); signals.push(s); const d = deferred<Blob>(); pending.push(d); return d.promise; },
    audio: () => el,
    url: { create: () => { const u = "blob:" + made.length; made.push(u); return u; }, revoke: (u) => revoked.push(u) },
    ...opts,
  });
  const states: PlayerPhase[] = [];
  p.subscribe(() => { const ph = p.getSnapshot().phase; if (states.at(-1) !== ph) states.push(ph); });
  return { p, el, asked, signals, pending, made, revoked, states };
}

beforeEach(() => { voiceAvailability.reset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("player phases come from the media element (honest)", () => {
  it("idle → preparing → playing only on `playing` → idle; loadstart/canplay/stalled never claim playback", async () => {
    const r = rig();
    const onPhase: PlayerPhase[] = [];
    const done = r.p.play("m", "مرحبا.", { onPhase: (ph) => onPhase.push(ph) });
    expect(r.p.getSnapshot()).toMatchObject({ id: "m", phase: "preparing" });
    r.pending[0].resolve(new Blob(["a"])); await flush();
    for (const e of ["loadstart", "canplay", "stalled", "waiting"]) { r.el.emit(e); expect(r.p.getSnapshot().phase).toBe("preparing"); }
    r.el.emit("playing");
    expect(r.p.getSnapshot().phase).toBe("playing");
    r.el.emit("ended");
    expect(await done).toBe("done");
    expect(r.states).toEqual(["preparing", "playing", "idle"]);
    expect(onPhase).toEqual(["preparing", "playing"]);
  });

  it("the reply is cleaned for speech before the TTS: no MEDIA marker, path or markdown is ever sent to /speak", async () => {
    const r = rig();
    void r.p.play("m", "**تم** حفظ الصورة.\nMEDIA: /tmp/out/chart.png\nراجع `/home/user/report.pdf` الآن.");
    expect(r.asked).toEqual(["تم حفظ الصورة. راجع الآن."]);
    r.p.stop();
    const empty = rig();
    expect(await empty.p.play("m", "MEDIA: /tmp/a.png")).toBe("done"); // nothing speakable: nothing requested
    expect(empty.asked).toEqual([]);
  });

  it("events of another source (the unlock sound) never drive the state", async () => {
    const r = rig();
    r.p.unlock();
    expect(r.el.src.startsWith("data:audio/wav")).toBe(true);
    void r.p.play("m", "نص.");
    r.el.emit("playing"); r.el.emit("ended"); // the silent WAV still reporting
    expect(r.p.getSnapshot().phase).toBe("preparing");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing");
    expect(r.p.getSnapshot().phase).toBe("playing");
    const plays = r.el.play.mock.calls.length;
    r.p.unlock(); // a tap while BASHT speaks never interrupts it
    expect(r.el.src).toBe("blob:0"); expect(r.el.play.mock.calls.length).toBe(plays);
  });
});

describe("watchdogs: never stuck", () => {
  it("after `playing`, a clock that does not advance for 4 s is reported as stalled (no automatic retry)", async () => {
    const r = rig();
    const done = r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing");
    await vi.advanceTimersByTimeAsync(3000);
    r.el.currentTime = 1; r.el.emit("timeupdate"); // it advanced: the watchdog re-arms
    await vi.advanceTimersByTimeAsync(3500);
    expect(r.p.getSnapshot().phase).toBe("playing");
    r.el.emit("timeupdate"); // same time: no progress
    await vi.advanceTimersByTimeAsync(600);
    expect(await done).toBe("error");
    expect(r.p.getSnapshot()).toMatchObject({ phase: "error", code: "stalled", errorKind: "stalled", canResume: false });
    expect(r.asked).toHaveLength(1); // not retried by itself: the owner decides («أعد المحاولة»)
  });
  it("a source that never starts playing ends in an error after 15 s", async () => {
    const r = rig();
    const done = r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await done).toBe("error");
    expect(r.p.getSnapshot().code).toBe("stalled");
  });
  it("progress follows the element's clock over the whole reply", async () => {
    const r = rig();
    void r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing"); r.el.duration = 4; r.el.currentTime = 2; r.el.emit("timeupdate");
    expect(r.p.getProgress()).toBe(0.5);
    r.p.stop();
    expect(r.p.getProgress()).toBe(0);
  });
});

describe("errors are classified, and every path ends in idle or error", () => {
  const start = async (r: ReturnType<typeof rig>) => { const d = r.p.play("m", "نص."); r.pending[0].resolve(new Blob(["a"])); await flush(); r.el.emit("playing"); return { d }; };
  it("an OS pause (call, route change) becomes a resumable interruption; the pause before `ended` does not", async () => {
    const r = rig();
    const { d: done } = await start(r);
    r.el.emit("pause");
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toBe("error");
    expect(r.p.getSnapshot()).toMatchObject({ code: "interrupted", canResume: true });
    const again = r.p.resume();
    r.el.emit("playing"); r.el.emit("pause"); r.el.emit("ended");
    await vi.advanceTimersByTimeAsync(400);
    expect(await again).toBe("done");
    expect(r.asked).toHaveLength(1);
  });
  it("a media `error` is a decode failure (network for MEDIA_ERR_NETWORK); `emptied` mid-playback stops cleanly", async () => {
    const a = rig(); const { d: da } = await start(a); a.el.error = { code: 4 }; a.el.emit("error");
    expect(await da).toBe("error"); expect(a.p.getSnapshot()).toMatchObject({ code: "decode", errorKind: "decode" });
    const b = rig(); const { d: db } = await start(b); b.el.error = { code: 2 }; b.el.emit("error");
    expect(await db).toBe("error"); expect(b.p.getSnapshot().errorKind).toBe("network");
    const c = rig(); const { d: dc } = await start(c); c.el.emit("emptied");
    expect(await dc).toBe("error"); expect(c.p.getSnapshot()).toMatchObject({ phase: "error", code: "playback" });
  });
  it("engine voice errors carry their reason; only configuration failures hide «استمع»", async () => {
    const r = rig();
    const d = r.p.play("m", "نص.");
    r.pending[0].reject(new BashtError("voice_unavailable", "provider_error"));
    expect(await d).toBe("error");
    expect(r.p.getSnapshot()).toMatchObject({ errorKind: "unavailable", errorReason: "provider_error" });
    expect(r.p.getSnapshot().error).toMatch(/مزوّد الصوت/);
    expect(voiceAvailability.get().speak, "a provider hiccup is not a missing voice").toBe("unknown");
    const m = rig();
    const d2 = m.p.play("m", "نص.");
    m.pending[0].reject(new BashtError("voice_unavailable", "identity_mismatch"));
    expect(await d2).toBe("error");
    expect(voiceAvailability.get()).toMatchObject({ speak: "no", reason: "identity_mismatch" });
  });
  it("network failures and a lapsed session are reported as such", async () => {
    const n = rig(); const dn = n.p.play("m", "نص."); n.pending[0].reject(new BashtError("network"));
    expect(await dn).toBe("error"); expect(n.p.getSnapshot()).toMatchObject({ errorKind: "network", code: "network" });
    const u = rig(); const du = u.p.play("m", "نص."); u.pending[0].reject(new BashtError("unauthorized"));
    expect(await du).toBe("error"); expect(u.p.getSnapshot().code).toBe("unauthorized");
  });
  it("clearError() and stop() return to idle; a blocked play() that throws synchronously is still caught", async () => {
    const r = rig();
    r.el.play.mockImplementationOnce(() => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); });
    const d = r.p.play("m", "نص."); r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(await d).toBe("error");
    expect(r.p.getSnapshot()).toMatchObject({ code: "playback_blocked", canResume: true });
    r.p.clearError();
    expect(r.p.getSnapshot()).toMatchObject({ id: null, phase: "idle", error: "" });
    expect(await r.p.resume()).toBe("error"); // nothing left to continue
  });
});

describe("chunk pipeline and generation token", () => {
  it("prefetches chunk n+1 only once chunk n plays; a stopped reply never plays a chunk that arrives late", async () => {
    const r = rig();
    const long = Array.from({ length: 2 }, (_, i) => `فقرة ${i} ` + "س".repeat(1400) + ".").join(" ");
    const done = r.p.play("m", long);
    r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(r.asked).toHaveLength(1);
    r.el.emit("playing");
    expect(r.asked).toHaveLength(2);
    r.p.stop();
    expect(r.signals[1].aborted).toBe(true);
    r.pending[1].resolve(new Blob(["b"])); await flush();
    expect(await done).toBe("stopped");
    expect(r.el.src).toBe("blob:0"); // chunk 2 never reached the element
    expect(r.p.getSnapshot()).toMatchObject({ id: null, phase: "idle" });
  });
  it("a fetch still pending when another reply starts is abandoned; the new reply owns the element", async () => {
    const r = rig();
    const a = r.p.play("a", "أولى.");
    const b = r.p.play("b", "ثانية.");
    expect(await a).toBe("stopped");
    r.pending[0].resolve(new Blob(["old"])); r.pending[1].resolve(new Blob(["new"])); await flush();
    expect(r.made).toEqual(["blob:0"]); // only the new reply's audio was ever turned into a source
    r.el.emit("playing");
    expect(r.p.getSnapshot()).toMatchObject({ id: "b", phase: "playing" });
    r.el.emit("ended");
    expect(await b).toBe("done");
  });
  it("muting the output mutes the element (the reply runs its course silently)", async () => {
    const r = rig();
    r.p.setMuted(true);
    void r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(r.el.muted).toBe(true);
    r.p.setMuted(false); expect(r.el.muted).toBe(false); expect(r.p.isMuted()).toBe(false);
  });
});

describe("a terminated playback can never start or resume behind an error (review P2)", () => {
  it("start watchdog: the element is paused and its source dropped", async () => {
    const r = rig();
    const d = r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    const before = r.el.pause.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await d).toBe("error");
    expect(r.el.pause.mock.calls.length).toBeGreaterThan(before);
    expect(r.el.src).toBe(""); // a late `playing` of the old source has nothing to play
    r.el.emit("playing");
    expect(r.p.getSnapshot().phase).toBe("error");
  });
  it("stall watchdog: paused at once; if the clock recovers after the error, the state stays error and nothing plays on", async () => {
    const r = rig();
    const d = r.p.play("m", "نص.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing");
    const before = r.el.pause.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(await d).toBe("error");
    expect(r.el.pause.mock.calls.length).toBeGreaterThan(before);
    r.el.currentTime = 2; r.el.emit("timeupdate"); r.el.emit("playing"); // recovery after the error
    expect(r.p.getSnapshot()).toMatchObject({ phase: "error", code: "stalled" });
    expect(r.el.src).toBe("");
  });
});

describe("a voice is TESTED only when its audio really played through (review P2)", () => {
  const learnedNow = () => { const a = voiceAvailability.get(); return { speak: a.speak, reason: a.reason, at: a.speakAt, failed: a.fail, transcribe: a.transcribe }; };
  const level = () => readVoice(null, learnedNow()).level;
  it("blob fetched, nothing played yet (and while it is playing): never tested_ok", async () => {
    const r = rig();
    const done = r.p.play("m", "مرحبا.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(voiceAvailability.get().speak).toBe("unknown");
    expect(level()).toBe("unknown");
    r.el.emit("playing");
    expect(level(), "playing is not finished").toBe("unknown");
    r.el.emit("ended");
    expect(await done).toBe("done");
  });
  it("blob fetched and playback completed: tested_ok, with the time of that playback", async () => {
    vi.setSystemTime(new Date(1_800_000_000_000));
    const r = rig();
    const done = r.p.play("m", "مرحبا.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing"); r.el.emit("ended");
    expect(await done).toBe("done");
    expect(voiceAvailability.get().speak).toBe("yes");
    expect(voiceAvailability.speakCheckedAt()).toBe(1_800_000_000_000);
    expect(readVoice(null, learnedNow())).toMatchObject({ level: "tested_ok", checkedAt: 1_800_000_000_000 });
  });
  it("blocked autoplay: audio fetched, play() refused: degraded, not tested_ok; «استمع» stays (the engine voice is fine)", async () => {
    const r = rig();
    r.el.play.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const done = r.p.play("m", "مرحبا.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(await done).toBe("error");
    expect(voiceAvailability.get().speak).not.toBe("yes");
    expect(voiceAvailability.get().speak).not.toBe("no");
    expect(voiceAvailability.playbackFailure()).toMatchObject({ kind: "playback_blocked" });
    expect(level()).toBe("degraded");
  });
  it("blob fetched, then a decode error: degraded, not tested_ok", async () => {
    const r = rig();
    const done = r.p.play("m", "مرحبا.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    r.el.emit("playing"); r.el.error = { code: 3 }; r.el.emit("error");
    expect(await done).toBe("error");
    expect(level()).toBe("degraded");
  });
  it("a stalled start (never plays) is degraded, and a later completed playback clears the failure", async () => {
    const r = rig({ startMs: 100 });
    const done = r.p.play("m", "مرحبا.");
    r.pending[0].resolve(new Blob(["a"])); await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(await done).toBe("error");
    expect(level()).toBe("degraded");
    const ok = rig();
    const again = ok.p.play("m", "مرحبا.");
    ok.pending[0].resolve(new Blob(["a"])); await flush();
    ok.el.emit("playing"); ok.el.emit("ended");
    expect(await again).toBe("done");
    expect(voiceAvailability.playbackFailure()).toBeNull();
    expect(level()).toBe("tested_ok");
  });
  it("a multi-chunk reply is tested only after a chunk finished, not when the first blob arrives", async () => {
    const r = rig();
    const done = r.p.play("m", "جملة أولى طويلة. ".repeat(120));
    r.pending[0].resolve(new Blob(["a"])); await flush();
    expect(voiceAvailability.get().speak).toBe("unknown");
    r.el.emit("playing"); r.el.emit("ended"); await flush();
    expect(voiceAvailability.get().speak).toBe("yes");
    r.p.stop(); await done.catch(() => {});
  });
  it("success, then a playback failure, then a retry success: a NEW snapshot and a notification at every step, the time refreshes", async () => {
    const seen: unknown[] = [];
    const off = voiceAvailability.subscribe(() => seen.push(voiceAvailability.get()));
    const playOnce = async (r: ReturnType<typeof rig>, end: "ended" | "error") => {
      const d = r.p.play("m", "مرحبا.");
      r.pending[0].resolve(new Blob(["a"])); await flush();
      r.el.emit("playing");
      if (end === "ended") r.el.emit("ended"); else { r.el.error = { code: 3 }; r.el.emit("error"); }
      await d;
    };
    vi.setSystemTime(new Date(1_800_000_000_000));
    await playOnce(rig(), "ended");
    const s1 = voiceAvailability.get();
    expect(s1).toMatchObject({ speak: "yes", speakAt: 1_800_000_000_000, fail: null });
    vi.setSystemTime(new Date(1_800_000_010_000));
    await playOnce(rig(), "error");
    const s2 = voiceAvailability.get();
    expect(s2).not.toBe(s1);
    expect(s2.speak, "an earlier success is still on record").toBe("yes");
    expect(s2.fail).toMatchObject({ kind: "decode", at: 1_800_000_010_000 });
    expect(level()).toBe("degraded");
    vi.setSystemTime(new Date(1_800_000_020_000));
    await playOnce(rig(), "ended");
    const s3 = voiceAvailability.get();
    expect(s3).not.toBe(s2);
    expect(s3).toMatchObject({ fail: null, speakAt: 1_800_000_020_000 });
    expect(level()).toBe("tested_ok");
    vi.setSystemTime(new Date(1_800_000_030_000));
    await playOnce(rig(), "ended"); // a repeated success refreshes the displayed check time
    expect(voiceAvailability.get()).not.toBe(s3);
    expect(voiceAvailability.get().speakAt).toBe(1_800_000_030_000);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen).size, "every notification carries a distinct snapshot object").toBe(seen.length);
    off();
  });
  it.each(["provider_error", "link_down"] as const)("success, then a transient %s request failure: degraded, never tested_ok; «استمع» stays; a newer success returns to tested_ok", async (reason) => {
    vi.setSystemTime(new Date(1_800_000_000_000));
    const ok = rig();
    const d = ok.p.play("m", "مرحبا.");
    ok.pending[0].resolve(new Blob(["a"])); await flush(); ok.el.emit("playing"); ok.el.emit("ended"); await d;
    expect(level()).toBe("tested_ok");
    vi.setSystemTime(new Date(1_800_000_005_000));
    const bad = rig();
    const d2 = bad.p.play("m", "مرحبا.");
    bad.pending[0].reject(new BashtError("voice_unavailable", reason));
    expect(await d2).toBe("error");
    expect(voiceAvailability.get().speak, "a transient failure is not a missing voice").toBe("yes");
    expect(voiceAvailability.get().fail).toMatchObject({ kind: "unavailable", reason, at: 1_800_000_005_000 });
    expect(readVoice(null, learnedNow())).toMatchObject({ level: "degraded", checkedAt: 1_800_000_005_000 });
    vi.setSystemTime(new Date(1_800_000_009_000));
    const again = rig();
    const d3 = again.p.play("m", "مرحبا.");
    again.pending[0].resolve(new Blob(["a"])); await flush(); again.el.emit("playing"); again.el.emit("ended"); await d3;
    expect(readVoice(null, learnedNow())).toMatchObject({ level: "tested_ok", checkedAt: 1_800_000_009_000 });
  });
  it("a transient engine failure with no earlier success is degraded too, and a durable one is still «no» (down)", async () => {
    const bad = rig();
    const d = bad.p.play("m", "مرحبا.");
    bad.pending[0].reject(new BashtError("voice_unavailable", "provider_error"));
    await d;
    expect(level()).toBe("degraded");
    const cfg = rig();
    const d2 = cfg.p.play("m", "مرحبا.");
    cfg.pending[0].reject(new BashtError("voice_unavailable", "no_tts_config"));
    await d2;
    expect(voiceAvailability.get()).toMatchObject({ speak: "no", fail: null });
    expect(level()).toBe("down");
  });
  it("an engine configuration failure still wins and clears a playback failure", async () => {
    voiceAvailability.setFailure("decode");
    voiceAvailability.set("speak", "no", "identity_mismatch");
    expect(voiceAvailability.playbackFailure()).toBeNull();
    expect(level()).toBe("down");
  });
});
