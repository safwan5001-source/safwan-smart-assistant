import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BashtError } from "@/lib/basht-client";
import { clock, createSilenceGate, createVoicePlayer, MAX_SPEAK_CHARS, parseVoiceNote, pickRecorderType, splitForSpeech, voiceAvailability, voiceNoteText } from "@/lib/basht-voice";

const WEB = resolve(__dirname, "..");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");

describe("speech chunks (≤ 1500 chars, sentence boundaries)", () => {
  it("keeps a short reply whole and drops empty text", () => {
    expect(splitForSpeech("مرحبا يا صفوان.")).toEqual(["مرحبا يا صفوان."]);
    expect(splitForSpeech("   \n ")).toEqual([]);
  });
  it("cuts long replies on sentence ends (Arabic and Latin), never inside a sentence, in order", () => {
    const s = (n: number) => "جملة رقم " + n + " " + "ك".repeat(180) + (n % 2 ? "؟" : ".");
    const text = Array.from({ length: 20 }, (_, i) => s(i)).join(" ");
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) { expect(c.length).toBeLessThanOrEqual(MAX_SPEAK_CHARS); expect(c).toMatch(/[.؟]$/); }
    expect(chunks.join(" ")).toBe(text);
  });
  it("a sentence longer than the cap falls back to clauses, then words, then length", () => {
    const clauses = Array.from({ length: 30 }, () => "ب".repeat(90)).join("، ");
    for (const c of splitForSpeech(clauses)) expect(c.length).toBeLessThanOrEqual(1500);
    const words = Array.from({ length: 400 }, () => "كلمة").join(" ");
    const w = splitForSpeech(words);
    expect(w.length).toBe(2); expect(w.join(" ")).toBe(words);
    const blob = "x".repeat(4000);
    expect(splitForSpeech(blob).map((c) => c.length)).toEqual([1500, 1500, 1000]);
  });
});

describe("voice notes in the conversation", () => {
  it("are marked so every device shows them as voice, and BASHT knows the text is a transcript", () => {
    const t = voiceNoteText("  ذكرني بالاجتماع  ");
    expect(t).toBe("[رسالة صوتية] ذكرني بالاجتماع");
    expect(parseVoiceNote(t)).toEqual({ voice: true, text: "ذكرني بالاجتماع" });
    expect(parseVoiceNote("نص عادي")).toEqual({ voice: false, text: "نص عادي" });
  });
  it("record in a format the engine accepts (Safari mp4, Chrome webm, Firefox ogg)", () => {
    expect(pickRecorderType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderType((t) => t === "audio/ogg")).toBe("audio/ogg");
    expect(pickRecorderType(() => false)).toBeNull();
    expect(pickRecorderType(() => { throw new Error("x"); })).toBeNull();
    expect(clock(0)).toBe("0:00"); expect(clock(65_400)).toBe("1:05"); expect(clock(180_000)).toBe("3:00");
  });
  it("the hands-free turn ends after a pause once speech was heard, or gives up when nothing is said", () => {
    const g = createSilenceGate({ threshold: 0.02, silenceMs: 1400, noSpeechMs: 12_000 });
    expect(g(0.001, 0)).toBe("wait");
    expect(g(0.1, 500)).toBe("wait");
    expect(g(0.001, 1000)).toBe("wait");
    expect(g(0.1, 1500)).toBe("wait"); // speaking again resets the pause
    expect(g(0.001, 2800)).toBe("wait");
    expect(g(0.001, 2900)).toBe("stop");
    const quiet = createSilenceGate();
    expect(quiet(0, 0)).toBe("wait");
    expect(quiet(0.001, 11_999)).toBe("wait");
    expect(quiet(0.001, 12_000)).toBe("no_speech");
  });
});

type FakeAudio = { src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; onended: (() => void) | null; onerror: (() => void) | null };
function rig(speak: (t: string, s: AbortSignal) => Promise<Blob>) {
  const el: FakeAudio = { src: "", play: vi.fn(async () => {}), pause: vi.fn(), onended: null, onerror: null };
  const made: string[] = [], revoked: string[] = [];
  const p = createVoicePlayer({ speak, audio: () => el, url: { create: () => { const u = "blob:" + made.length; made.push(u); return u; }, revoke: (u) => revoked.push(u) } });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { p, el, made, revoked, tick };
}
const reply = Array.from({ length: 3 }, (_, i) => `فقرة ${i} ` + "س".repeat(1300) + ".").join(" ");

describe("the voice player (one playback at a time)", () => {
  it("plays chunk 1 as soon as it arrives and asks for chunk 2 only then — sequential, in order", async () => {
    const asked: string[] = [];
    const resolvers: ((b: Blob) => void)[] = [];
    const { p, el, tick } = rig((t) => { asked.push(t); return new Promise<Blob>((r) => resolvers.push(r)); });
    const done = p.play("m1", reply);
    await tick();
    expect(asked).toHaveLength(1);
    expect(p.getSnapshot()).toMatchObject({ id: "m1", phase: "loading" });
    resolvers[0](new Blob(["a"]));
    await tick();
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(el.src).toBe("blob:0");
    expect(p.getSnapshot().phase).toBe("playing");
    expect(asked).toHaveLength(2); // the next chunk is fetched while the first plays
    resolvers[1](new Blob(["b"]));
    el.onended?.(); await tick();
    expect(el.src).toBe("blob:1");
    resolvers[2](new Blob(["c"]));
    el.onended?.(); await tick();
    el.onended?.();
    expect(await done).toBe("done");
    expect(asked.map((t) => t.length)).toEqual(splitForSpeech(reply).map((t) => t.length));
    expect(p.getSnapshot()).toMatchObject({ id: null, phase: "idle" });
  });

  it("starting another reply stops the first (aborts its fetch); stop() is immediate and frees the audio", async () => {
    const signals: AbortSignal[] = [];
    const { p, el, revoked, tick } = rig((_t, s) => { signals.push(s); return Promise.resolve(new Blob(["a"])); });
    const first = p.play("m1", "أولى.");
    await tick();
    expect(p.getSnapshot()).toMatchObject({ id: "m1", phase: "playing" });
    const second = p.play("m2", "ثانية.");
    expect(await first).toBe("stopped");
    expect(signals[0].aborted).toBe(true);
    expect(el.pause).toHaveBeenCalled();
    await tick();
    expect(p.getSnapshot()).toMatchObject({ id: "m2", phase: "playing" });
    p.stop();
    expect(await second).toBe("stopped");
    expect(p.getSnapshot()).toMatchObject({ id: null, phase: "idle" });
    expect(revoked.length).toBe(2);
  });

  it("an engine without voice is said plainly and remembered; a blocked autoplay asks for another tap", async () => {
    voiceAvailability.reset();
    const { p } = rig(() => Promise.reject(new BashtError("voice_unavailable")));
    expect(await p.play("m1", "نص.")).toBe("error");
    expect(p.getSnapshot()).toMatchObject({ id: null, phase: "idle", code: "voice_unavailable" });
    expect(p.getSnapshot().error).toMatch(/غير مفعّل في المحرك/);
    expect(voiceAvailability.get().speak).toBe("no");
    voiceAvailability.reset();
    const blocked = rig(() => Promise.resolve(new Blob(["a"])));
    blocked.el.play.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    expect(await blocked.p.play("m1", "نص.")).toBe("error");
    expect(blocked.p.getSnapshot().code).toBe("playback_blocked");
    expect(voiceAvailability.get().speak, "the engine voice works; only this browser blocked playing it").toBe("yes");
  });
});

describe("one conversation, one mic", () => {
  const chat = src("features/chat/chat-screen.tsx");
  it("the composer has ONE mic: a voice note with the engine's voice, browser dictation otherwise", () => {
    expect(chat).toMatch(/\{noteMode\s*\? <button[\s\S]*?recordNote\(\)[\s\S]*?: <button[\s\S]*?dictation\.start\(draft, setDraft\)/);
    expect(chat).toMatch(/const noteMode = voiceOn && recorder\.supported && voiceAvail\.transcribe !== "no";/);
  });
  it("a voice note goes through the same send path, is marked, and is never claimed as sent when it was not", () => {
    expect(chat).toMatch(/await basht\.send\(voiceNoteText\(text\)\)/);
    expect(chat).toMatch(/catch \(e\) \{ setAgentPhase\("reply_failed"\); setDraft\(text\);/);
    expect(chat).toMatch(/if \(!ready \|\| basht\.live\) \{ setDraft\(text\);/);
  });
  it("«استمع» is on BASHT's replies only, and the live session speaks in the same conversation", () => {
    expect(chat).toMatch(/\{m\.role === "assistant" && <ListenButton id=\{key\} text=\{m\.text\} \/>\}/);
    // self-contained: the button reads the shared player and the engine's availability itself (safe inside a memoized timeline)
    const btn = src("features/chat/listen-button.tsx");
    expect(btn).toMatch(/usePlayer\(\)/); expect(btn).toMatch(/avail\.speak === "no"/);
    expect(chat).toMatch(/const id = await basht\.send\(text\);\s*const end = await basht\.waitRun\(id\);/);
    const panel = src("features/calls/calls-screen.tsx");
    expect(panel).toMatch(/live\.ask\(voiceNoteText\(text\)\)/);
    expect(panel).toMatch(/voicePlayer\(\)\.play\("live", reply\)/);
    expect(panel).not.toMatch(/RTCPeerConnection|talk\.client|getVoices/); // no parallel voice system (no WebRTC, no browser TTS)
  });
  it("no provider key or voice choice lives in the app", () => {
    for (const f of ["lib/basht-voice.ts", "server/basht-chat.ts", "features/calls/calls-screen.tsx"]) expect(src(f)).not.toMatch(/OPENAI|ELEVENLABS|apiKey|speakerVoice|voiceId/);
  });
});
