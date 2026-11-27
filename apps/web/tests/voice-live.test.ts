import { afterEach, describe, expect, it, vi } from "vitest";
import { BashtError } from "@/lib/basht-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import VoicePanel, { liveText, panelView, TURN_NOTE } from "@/features/calls/calls-screen";
import { CONTEXT_CALL_MS, resumeAudioContext, suspendAudioContext } from "@/lib/audio-context";
import { AFTER_CAPTURE_MS, BACKGROUND_GRACE_MS, BACKGROUND_TEXT, createLiveSession, watchBackground, settleAfterCapture, type LiveDeps, type LivePhase, type LiveStep, type PlayerPhase, type PlayResult, type RecordResult } from "@/lib/basht-voice";
import { deferred, flush } from "./voice-fakes";

const audio: RecordResult = { audio: new Blob([new Uint8Array(2000)]), ended: "silence", ms: 1500 };
const quiet: RecordResult = { audio: null, ended: "no_speech", ms: 12_000 };

/** A live session on fakes the test drives step by step. */
function rig(over: Partial<LiveDeps> = {}) {
  const records: { d: ReturnType<typeof deferred<RecordResult>>; started: (handsFree: boolean) => void }[] = [];
  const transcripts: ReturnType<typeof deferred<string>>[] = [];
  const replies: ReturnType<typeof deferred<string>>[] = [];
  const plays: { text: string; onPlayer: (p: PlayerPhase) => void; d: ReturnType<typeof deferred<PlayResult>> }[] = [];
  const log: string[] = [];
  const seen: { phase: LivePhase; step: LiveStep }[] = [];
  const errors: string[] = [];
  const d: LiveDeps = {
    record: (onStarted) => { const x = deferred<RecordResult>(); records.push({ d: x, started: onStarted }); log.push("record"); return x.promise; },
    cancelRecord: vi.fn(() => log.push("cancelRecord")),
    transcribe: () => { const x = deferred<string>(); transcripts.push(x); log.push("transcribe"); return x.promise; },
    ask: () => { const x = deferred<string>(); replies.push(x); log.push("ask"); return x.promise; },
    play: (text, onPlayer) => { const x = deferred<PlayResult>(); plays.push({ text, onPlayer, d: x }); log.push("play"); return x.promise; },
    stopPlay: vi.fn(() => log.push("stopPlay")),
    playError: () => "تعذّر تشغيل الصوت.", recordError: () => "",
    afterCapture: vi.fn(async () => { log.push("afterCapture"); }),
    beforeCapture: vi.fn(() => { log.push("beforeCapture"); }),
    onPhase: (phase, step) => seen.push({ phase, step }),
    onHeard: vi.fn(), onReply: vi.fn(), onError: (m) => { if (m) errors.push(m); }, onEnd: vi.fn(),
    ...over,
  };
  const s = createLiveSession(d);
  const last = () => seen.at(-1)!;
  return { s, d, records, transcripts, replies, plays, log, seen, errors, last };
}
/** One full turn up to BASHT's reply being handed to the player. */
async function toPlay(t: ReturnType<typeof rig>, n = 0) {
  await flush(); t.records[n].started(true); t.records[n].d.resolve(audio); await flush();
  t.transcripts[n].resolve("سؤال"); await flush();
  t.replies[n].resolve("الرد"); await flush();
}

afterEach(() => vi.useRealTimers());

describe("live session: phases only reflect real activity", () => {
  it("listening only once the recorder started; thinking while transcribing, waiting and fetching the voice; speaking only on `playing`", async () => {
    const t = rig();
    t.s.start(); await flush();
    expect(t.last()).toEqual({ phase: "starting", step: "" }); // the mic is opening: not "listening" yet
    t.records[0].started(true);
    expect(t.last().phase).toBe("listening");
    t.records[0].d.resolve(audio); await flush();
    expect(t.last()).toEqual({ phase: "thinking", step: "transcribing" });
    t.transcripts[0].resolve("سؤال"); await flush();
    expect(t.last()).toEqual({ phase: "thinking", step: "waiting" });
    t.replies[0].resolve("الرد"); await flush();
    expect(t.plays).toHaveLength(1);
    expect(t.last()).toEqual({ phase: "thinking", step: "voice" }); // «يجهّز الصوت…»
    t.plays[0].onPlayer("preparing");
    expect(t.last().phase).toBe("thinking");
    t.plays[0].onPlayer("playing");
    expect(t.last().phase).toBe("speaking");
    t.plays[0].d.resolve("done"); await flush();
    expect(t.records).toHaveLength(2); // listening again (a new turn)
    expect(t.d.onReply).toHaveBeenCalledWith("الرد");
    expect(t.d.onHeard).toHaveBeenCalledWith("سؤال");
  });

  it("after the microphone turn the route is settled (afterCapture) BEFORE BASHT speaks; before each turn the capture session is set", async () => {
    const t = rig();
    t.s.start(); await toPlay(t);
    const i = t.log.indexOf("afterCapture");
    expect(i).toBeGreaterThan(t.log.indexOf("record"));
    expect(i).toBeLessThan(t.log.indexOf("play"));
    expect(t.log.indexOf("beforeCapture")).toBeLessThan(t.log.indexOf("record"));
  });

  it("settleAfterCapture: let the stop earcon end (~350 ms), park the probe graph, then enter the playback session", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const p = settleAfterCapture({ suspend: async () => { order.push("suspend"); }, wait: (ms) => new Promise((r) => setTimeout(() => { order.push("wait:" + ms); r(); }, ms)), enter: () => order.push("enter") });
    await flush();
    expect(order).toEqual([]); // the earcon is still playing: nothing is suspended under it
    await vi.advanceTimersByTimeAsync(AFTER_CAPTURE_MS);
    await p;
    expect(order).toEqual(["wait:350", "suspend", "enter"]);
    // a failing suspend never blocks the reply
    const o2: string[] = [];
    await settleAfterCapture({ suspend: async () => { throw new Error("x"); }, wait: async () => { o2.push("wait"); }, enter: () => o2.push("enter") });
    expect(o2).toEqual(["wait", "enter"]);
  });

  it("a STALE settle (session ended, or the next recording began) never switches the page to playback afterwards", async () => {
    let live = true;
    const o: string[] = [];
    const w = deferred<void>();
    const p = settleAfterCapture({ suspend: async () => { o.push("suspend"); }, wait: () => w.promise, enter: () => o.push("enter"), live: () => live });
    live = false; w.resolve(); await p;
    expect(o).toEqual([]);
    // in the loop: the session's own staleness check is what it gets
    const seenLive: (() => boolean)[] = [];
    const t = rig({ afterCapture: async (l) => { seenLive.push(l); } });
    t.s.start(); await flush(); t.records[0].started(true); t.records[0].d.resolve(audio); await flush();
    expect(seenLive[0]()).toBe(true);
    t.s.end();
    expect(seenLive[0]()).toBe(false);
  });

  it("the previous turn's settle is awaited before the next turn asks for the microphone", async () => {
    const settle = deferred<void>();
    const t = rig({ afterCapture: () => settle.promise });
    t.s.setSpeakerMuted(true); // reply stays text: the loop goes straight back to listening
    t.s.start(); await toPlay(t);
    expect(t.records).toHaveLength(1);
    expect(t.log.filter((x) => x === "beforeCapture")).toHaveLength(1);
    settle.resolve(); await flush();
    expect(t.log.filter((x) => x === "beforeCapture")).toHaveLength(2);
    expect(t.records).toHaveLength(2);
  });

  it("the start earcon plays before the microphone opens (never into the recording)", async () => {
    const w = deferred<void>();
    const t = rig({ cue: (k) => { t.log.push("cue:" + k); return true; }, wait: () => w.promise });
    t.s.start(); await flush();
    expect(t.log.slice(-1)).toEqual(["cue:start"]);
    expect(t.records).toHaveLength(0);
    w.resolve(); await flush();
    expect(t.records).toHaveLength(1);
    expect(t.log.indexOf("cue:start")).toBeLessThan(t.log.indexOf("record"));
  });

  it("without an input level the turn is manual: the UI says so, and a turn nobody ended (60 s limit) ends the session unsent", async () => {
    const t = rig();
    t.s.start(); await flush();
    t.records[0].started(false);
    expect(t.last()).toEqual({ phase: "listening", step: "manual" });
    t.records[0].d.resolve({ audio: new Blob([new Uint8Array(9)]), ended: "limit", ms: 60_000, handsFree: false }); await flush();
    expect(t.log).not.toContain("transcribe");
    expect(t.errors[0]).toMatch(/60 ثانية/);
    expect(t.last().phase).toBe("idle");
  });

  it("transcription is aborted when the session ends", async () => {
    let signal: AbortSignal | null = null;
    const t = rig({ transcribe: (_a, s) => { signal = s; return new Promise<string>(() => {}); } });
    t.s.start(); await flush(); t.records[0].started(true); t.records[0].d.resolve(audio); await flush();
    expect(signal!.aborted).toBe(false);
    t.s.end();
    expect(signal!.aborted).toBe(true);
  });

  it("a tap interrupts BASHT (stop) and the loop listens again", async () => {
    const t = rig();
    t.s.start(); await toPlay(t);
    t.plays[0].onPlayer("playing");
    t.s.interrupt();
    expect(t.d.stopPlay).toHaveBeenCalled();
    t.plays[0].d.resolve("stopped"); await flush();
    expect(t.records).toHaveLength(2);
    expect(t.errors).toEqual([]);
  });
});

describe("live session: mute controls", () => {
  it("muting the mic while listening discards the turn and waits; unmuting (a tap) listens again", async () => {
    const t = rig();
    t.s.start(); await flush(); t.records[0].started(true);
    t.s.setMicMuted(true);
    expect(t.d.cancelRecord).toHaveBeenCalled();
    t.records[0].d.resolve({ audio: null, ended: "cancel", ms: 100 }); await flush();
    expect(t.last().phase).toBe("muted");
    expect(t.log.filter((x) => x === "transcribe")).toHaveLength(0); // nothing transcribed or sent
    expect(t.records).toHaveLength(1); // and no new recording while muted
    t.s.setMicMuted(false); await flush();
    expect(t.records).toHaveLength(2);
    expect(t.errors).toEqual([]);
  });
  it("muting BASHT's voice keeps replies as text: no voice is requested", async () => {
    const t = rig();
    t.s.setSpeakerMuted(true);
    t.s.start(); await toPlay(t);
    expect(t.plays).toHaveLength(0);
    expect(t.d.onReply).toHaveBeenCalledWith("الرد");
    expect(t.records).toHaveLength(2);
  });
});

describe("live session: errors end it with a clear message, never a stuck screen", () => {
  it("voice unavailable (with the engine's reason) ends the session and releases the audio session", async () => {
    const t = rig({ play: async () => "error", playError: () => "صوت باشت غير متاح الآن. مزوّد الصوت رفض الطلب." });
    t.s.start(); await toPlay(t);
    expect(t.last().phase).toBe("idle");
    expect(t.errors).toEqual(["صوت باشت غير متاح الآن. مزوّد الصوت رفض الطلب."]);
    expect(t.d.onEnd).toHaveBeenCalledTimes(1);
  });
  it("a transcription refused by the engine says why (reason text)", async () => {
    const t = rig();
    t.s.start(); await flush(); t.records[0].started(true); t.records[0].d.resolve(audio); await flush();
    t.transcripts[0].reject(new BashtError("voice_unavailable", "unconfigured")); await flush();
    expect(t.errors[0]).toMatch(/لم يُضبط صوت باشت/);
    expect(t.last().phase).toBe("idle");
  });
  it("microphone permission denied / no microphone: the recorder's message, then idle", async () => {
    const t = rig({ recordError: () => "لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح." });
    t.s.start(); await flush();
    t.records[0].d.resolve({ audio: null, ended: "error", ms: 0 }); await flush();
    expect(t.errors).toEqual(["لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح."]);
    expect(t.last().phase).toBe("idle");
  });
  it("a network/provider failure while asking BASHT ends with its message", async () => {
    const t = rig();
    t.s.start(); await flush(); t.records[0].started(true); t.records[0].d.resolve(audio); await flush();
    t.transcripts[0].resolve("سؤال"); await flush();
    t.replies[0].reject(new BashtError("network")); await flush();
    expect(t.errors).toEqual(["انقطع الاتصال بالخادم."]);
  });
  it("«no speech» from the engine counts toward the two quiet turns (steady noise never loops billed transcriptions)", async () => {
    const t = rig();
    t.s.start(); await flush();
    t.records[0].started(true); t.records[0].d.resolve(audio); await flush();
    t.transcripts[0].reject(new BashtError("no_speech")); await flush(); await flush();
    expect(t.records).toHaveLength(2);
    t.records[1].started(true); t.records[1].d.resolve(audio); await flush();
    t.transcripts[1].reject(new BashtError("no_speech")); await flush(); await flush();
    expect(t.records).toHaveLength(2);
    expect(t.errors[0]).toMatch(/لم أسمع كلامًا/);
    expect(t.transcripts).toHaveLength(2);
  });
  it("two silent turns still end the session (one is forgiven)", async () => {
    const t = rig();
    t.s.start(); await flush();
    t.records[0].d.resolve(quiet); await flush();
    expect(t.records).toHaveLength(2);
    t.records[1].d.resolve(quiet); await flush();
    expect(t.records).toHaveLength(2);
    expect(t.errors[0]).toMatch(/لم أسمع كلامًا/);
    expect(t.last().phase).toBe("idle");
  });
  it("a blocked playback waits for the owner's tap and continues the same audio (never retried on its own)", async () => {
    const resume = vi.fn(async () => "done" as PlayResult);
    const t = rig({ canResume: () => true, resume });
    t.s.start(); await toPlay(t);
    t.plays[0].d.resolve("error"); await flush();
    expect(t.last().phase).toBe("blocked");
    expect(resume).not.toHaveBeenCalled();
    t.s.resumePlayback();
    expect(resume).toHaveBeenCalledTimes(1);
    await flush();
    expect(t.records).toHaveLength(2); // continued, then listening again
    expect(t.errors).toEqual([]);
  });
  it("ending while blocked or muted leaves nothing waiting", async () => {
    const t = rig({ canResume: () => true, resume: vi.fn(async () => "done" as PlayResult) });
    t.s.start(); await toPlay(t);
    t.plays[0].d.resolve("error"); await flush();
    t.s.end(); await flush();
    expect(t.last().phase).toBe("idle");
    expect(t.records).toHaveLength(1);
    expect(t.d.onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("backgrounding: stop at once, end only if it stays hidden", () => {
  const host = () => { const ls = new Map<string, () => void>(); return { ls, addEventListener: (t: string, f: () => void) => ls.set(t, f), removeEventListener: (t: string) => ls.delete(t) }; };
  const env = () => { const doc = { ...host(), visibilityState: "visible" }, win = host(); return { doc, win, set: (v: string) => { doc.visibilityState = v; doc.ls.get("visibilitychange")!(); } }; };
  it("hidden → onHide at once, onEnd after 3 s; back within 3 s → onShow and the session lives; pagehide ends now", async () => {
    vi.useFakeTimers();
    const e = env(); const h = { onHide: vi.fn(), onShow: vi.fn(), onEnd: vi.fn() };
    const off = watchBackground(h, e);
    e.set("hidden"); expect(h.onHide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); e.set("visible");
    expect(h.onShow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); expect(h.onEnd).not.toHaveBeenCalled(); // a quick app-switcher glance
    e.set("hidden"); await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS); expect(h.onEnd).toHaveBeenCalledTimes(1);
    e.win.ls.get("pagehide")!(); expect(h.onEnd).toHaveBeenCalledTimes(2);
    off(); expect(e.doc.ls.size + e.win.ls.size).toBe(0);
  });
  it("a hidden event while the permission prompt is open (ignoreHide) is ignored", async () => {
    vi.useFakeTimers();
    const e = env(); const h = { onHide: vi.fn(), onShow: vi.fn(), onEnd: vi.fn(), ignoreHide: () => true };
    watchBackground(h, e);
    e.set("hidden"); await vi.advanceTimersByTimeAsync(5000);
    expect(h.onHide).not.toHaveBeenCalled(); expect(h.onEnd).not.toHaveBeenCalled();
  });
  it("hidden while listening: the partial turn is discarded (never transcribed), no new recording while hidden; visible listens again", async () => {
    const t = rig();
    t.s.start(); await flush(); t.records[0].started(true);
    t.s.setHidden(true);
    expect(t.d.cancelRecord).toHaveBeenCalled();
    t.records[0].d.resolve({ audio: null, ended: "cancel", ms: 100 }); await flush();
    expect(t.log).not.toContain("transcribe");
    expect(t.records).toHaveLength(1);
    expect(t.errors).toEqual([]);
    t.s.setHidden(false); await flush();
    expect(t.records).toHaveLength(2);
  });
  it("hidden while BASHT speaks: playback stops at once and nothing records until visible; ending after the grace leaves nothing behind", async () => {
    const t = rig();
    t.s.start(); await toPlay(t); t.plays[0].onPlayer("playing");
    t.s.setHidden(true);
    expect(t.d.stopPlay).toHaveBeenCalled();
    t.plays[0].d.resolve("stopped"); await flush();
    expect(t.records).toHaveLength(1);
    t.s.end(BACKGROUND_TEXT); await flush();
    expect(t.errors).toEqual([BACKGROUND_TEXT]); expect(t.last().phase).toBe("idle");
  });
  it("start() is 'starting' synchronously (a hidden event right after the tap sees a running session)", () => {
    const t = rig();
    t.s.start();
    expect(t.s.phase()).toBe("starting");
  });
});

describe("bounded audio-context calls and the manual-turn context", () => {
  it("a resume() that never settles reports false after 800 ms (the manual-turn fallback runs); a stuck suspend() is given up", async () => {
    vi.useFakeTimers();
    const stuck = { state: "suspended", resume: () => new Promise<void>(() => {}), suspend: () => new Promise<void>(() => {}) };
    const r = resumeAudioContext(stuck);
    await vi.advanceTimersByTimeAsync(CONTEXT_CALL_MS);
    expect(await r).toBe(false);
    const running = { ...stuck, state: "running" };
    const p = suspendAudioContext(running); let done = false; void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(CONTEXT_CALL_MS); await flush();
    expect(done).toBe(true);
  });
  it("after a manual turn the settle step keeps the tap-started context running (no suspend)", async () => {
    const o: string[] = [];
    await settleAfterCapture({ suspend: async () => { o.push("suspend"); }, wait: async () => {}, enter: () => o.push("enter"), park: false });
    expect(o).toEqual(["enter"]);
    const seen: boolean[] = [];
    const t = rig({ afterCapture: async (_l, turn) => { seen.push(turn.handsFree); } });
    t.s.start(); await flush(); t.records[0].started(false);
    t.records[0].d.resolve({ ...audio, ended: "stop", handsFree: false }); await flush();
    t.transcripts[0].resolve("x"); await flush();
    expect(seen).toEqual([false]);
  });
});

describe("the voice screen (rendered / pure)", () => {
  it("labels it a turn-by-turn conversation, never a real-time call", () => {
    expect(TURN_NOTE).toBe("محادثة صوتية بالتناوب — ليست مكالمة لحظية");
    const all = JSON.stringify(["idle", "starting", "listening", "muted", "speaking", "blocked"].map((p) => liveText(p as LivePhase, ""))) + JSON.stringify(liveText("listening", "manual"));
    expect(all).not.toMatch(/realtime|real-time|مكالمة فورية/i);
    expect(liveText("listening", "manual").sub).toMatch(/اضغط «أنهِ دورك»/);
    expect(liveText("listening", "").sub).toMatch(/حين تصمت/);
    expect(liveText("thinking", "voice").title).toBe("يجهّز الصوت…");
  });
  it("one deadline: connecting only while a fresh press is pending; otherwise dictation, never a late autostart behind it", () => {
    expect(panelView({ engineVoice: true, reason: "", autostart: true, pending: false })).toBe("live");
    expect(panelView({ engineVoice: false, reason: "", autostart: true, pending: true })).toBe("connecting");
    expect(panelView({ engineVoice: false, reason: "", autostart: true, pending: false })).toBe("dictation");
    expect(panelView({ engineVoice: false, reason: "معطّل", autostart: true, pending: true })).toBe("dictation");
    expect(panelView({ engineVoice: false, reason: "", autostart: false, pending: true })).toBe("dictation");
  });
  it("the dictation fallback renders as the browser's, not BASHT's voice", () => {
    const html = renderToStaticMarkup(createElement(VoicePanel, { onUse: () => {} }));
    expect(html).toContain("إملاء المتصفح — ليس صوت باشت");
    expect(html).toContain("ليس صوت باشت");
    expect(html).not.toContain("يستمع…");
  });
});

describe("mute during an await never records or speaks (review P1/P2)", () => {
  it("mic muted during the start earcon: the recorder never starts; the loop waits muted, unmute listens", async () => {
    const w = deferred<void>();
    const t = rig({ cue: () => true, wait: () => w.promise });
    t.s.start(); await flush();
    expect(t.last().phase).toBe("starting");
    t.s.setMicMuted(true);               // no recorder exists yet
    w.resolve(); await flush();
    expect(t.records).toHaveLength(0);   // never recorded, so nothing can be transcribed or sent
    expect(t.last().phase).toBe("muted");
    t.s.setMicMuted(false); await flush();
    expect(t.records).toHaveLength(1);   // unmuting (a tap) listens again
  });
  it("mic muted while the capture session is being prepared: no recording", async () => {
    const prep = deferred<void>();
    const t = rig({ beforeCapture: () => prep.promise });
    t.s.start(); await flush();
    t.s.setMicMuted(true);
    prep.resolve(); await flush();
    expect(t.records).toHaveLength(0);
    expect(t.last().phase).toBe("muted");
    expect(t.log).not.toContain("transcribe");
  });
  it("speaker muted while the route is still settling: no voice is requested or played; the reply stays text", async () => {
    const settle = deferred<void>();
    const t = rig({ afterCapture: () => settle.promise });
    t.s.start(); await toPlay(t);        // reply arrived; waiting for the settle step
    expect(t.last()).toEqual({ phase: "thinking", step: "voice" });
    t.s.setSpeakerMuted(true);           // no playback job exists yet
    settle.resolve(); await flush();
    expect(t.plays).toHaveLength(0);
    expect(t.d.onReply).toHaveBeenCalledWith("الرد");
    expect(t.records).toHaveLength(2);   // back to listening
  });
  it("speaker muted while a blocked reply waits for its tap: the wait is dropped and the loop listens again", async () => {
    const resume = vi.fn(async () => "done" as PlayResult);
    const t = rig({ canResume: () => true, resume });
    t.s.start(); await toPlay(t);
    t.plays[0].d.resolve("error"); await flush();
    expect(t.last().phase).toBe("blocked");
    t.s.setSpeakerMuted(true); await flush();
    expect(resume).not.toHaveBeenCalled();
    expect(t.records).toHaveLength(2);
    expect(t.errors).toEqual([]);
  });
});
