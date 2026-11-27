import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BashtError } from "@/lib/basht-client";
import { AFTER_CAPTURE_MS, createLiveSession, settleAfterCapture, type LiveDeps, type LivePhase, type LiveStep, type PlayerPhase, type PlayResult, type RecordResult } from "@/lib/basht-voice";
import { deferred, flush } from "./voice-fakes";

const audio: RecordResult = { audio: new Blob([new Uint8Array(2000)]), ended: "silence", ms: 1500 };
const quiet: RecordResult = { audio: null, ended: "no_speech", ms: 12_000 };

/** A live session on fakes the test drives step by step. */
function rig(over: Partial<LiveDeps> = {}) {
  const records: { d: ReturnType<typeof deferred<RecordResult>>; started: () => void }[] = [];
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
  await flush(); t.records[n].started(); t.records[n].d.resolve(audio); await flush();
  t.transcripts[n].resolve("سؤال"); await flush();
  t.replies[n].resolve("الرد"); await flush();
}

afterEach(() => vi.useRealTimers());

describe("live session: phases only reflect real activity", () => {
  it("listening only once the recorder started; thinking while transcribing, waiting and fetching the voice; speaking only on `playing`", async () => {
    const t = rig();
    t.s.start(); await flush();
    expect(t.last()).toEqual({ phase: "starting", step: "" }); // the mic is opening: not "listening" yet
    t.records[0].started();
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

  it("settleAfterCapture: park the probe graph, wait ~300 ms, then enter the playback session", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const p = settleAfterCapture({ suspend: async () => { order.push("suspend"); }, wait: (ms) => new Promise((r) => setTimeout(() => { order.push("wait:" + ms); r(); }, ms)), enter: () => order.push("enter") });
    await flush();
    expect(order).toEqual(["suspend"]);
    await vi.advanceTimersByTimeAsync(AFTER_CAPTURE_MS);
    await p;
    expect(order).toEqual(["suspend", "wait:300", "enter"]);
    // a failing suspend never blocks the reply
    const o2: string[] = [];
    await settleAfterCapture({ suspend: async () => { throw new Error("x"); }, wait: async () => { o2.push("wait"); }, enter: () => o2.push("enter") });
    expect(o2).toEqual(["wait", "enter"]);
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
    t.s.start(); await flush(); t.records[0].started();
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
    t.s.start(); await flush(); t.records[0].started(); t.records[0].d.resolve(audio); await flush();
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
    t.s.start(); await flush(); t.records[0].started(); t.records[0].d.resolve(audio); await flush();
    t.transcripts[0].resolve("سؤال"); await flush();
    t.replies[0].reject(new BashtError("network")); await flush();
    expect(t.errors).toEqual(["انقطع الاتصال بالخادم."]);
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

describe("the voice screen wires the honest loop", () => {
  const panel = readFileSync(join(resolve(__dirname, ".."), "features/calls/calls-screen.tsx"), "utf8");
  it("labels it a turn-by-turn conversation, never a real-time call", () => {
    expect(panel).toContain("محادثة صوتية بالتناوب — ليست مكالمة لحظية");
    const shown = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // what the owner can read (no comments)
    expect(shown).not.toMatch(/full[- ]duplex|realtime|real-time|مكالمة فورية/i);
  });
  it("record → onStart, settle after capture, and a tap-only start (autostart only with a fresh press)", () => {
    expect(panel).toMatch(/record: \(onStarted\) => latest\.current\.rec\.record\(\{ maxMs: MAX_NOTE_MS, silence: true, onStart: onStarted \}\)/);
    expect(panel).toMatch(/afterCapture: \(\) => settleAfterCapture\(\)/);
    expect(panel).toMatch(/if \(autostart && takeVoiceAutostart\(\)\) session\.current\?\.start\(\)/);
    expect(panel).toMatch(/const start = \(\) => \{\s*enterVoiceSession\("play-and-record"\); voicePlayer\(\)\.unlock\(\); primeAudioInput\(\);/);
  });
  it("the dictation fallback says it is the browser's, not BASHT's voice", () => {
    expect(panel).toContain("إملاء المتصفح — ليس صوت باشت");
    expect(panel).toMatch(/badge="ليس صوت باشت"/);
  });
});
