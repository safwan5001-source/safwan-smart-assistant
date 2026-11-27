import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BashtError } from "@/lib/basht-client";
import { FakeEl } from "./voice-fakes";
import { clock, createLiveSession, createVoiceNotes, createSilenceGate, createVoicePlayer, MAX_SPEAK_CHARS, parseVoiceNote, pickRecorderType, splitForSpeech, startRecording, voiceAvailability, voiceNoteText, type LiveDeps, type RecordResult, type RecorderEnv } from "@/lib/basht-voice";

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

function rig(speak: (t: string, s: AbortSignal) => Promise<Blob>) {
  const el = new FakeEl();
  const made: string[] = [], revoked: string[] = [];
  const p = createVoicePlayer({ speak, audio: () => el, url: { create: () => { const u = "blob:" + made.length; made.push(u); return u; }, revoke: (u) => revoked.push(u) } });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { p, el, made, revoked, tick };
}
const reply = Array.from({ length: 3 }, (_, i) => `فقرة ${i} ` + "س".repeat(1300) + ".").join(" ");

describe("the voice player (one playback at a time)", () => {
  it("plays chunk 1 as soon as it arrives, says «playing» only on the element's `playing`, and asks for chunk 2 only then", async () => {
    const asked: string[] = [];
    const resolvers: ((b: Blob) => void)[] = [];
    const { p, el, tick } = rig((t) => { asked.push(t); return new Promise<Blob>((r) => resolvers.push(r)); });
    const done = p.play("m1", reply);
    await tick();
    expect(asked).toHaveLength(1);
    expect(p.getSnapshot()).toMatchObject({ id: "m1", phase: "preparing" });
    resolvers[0](new Blob(["a"]));
    await tick();
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(el.src).toBe("blob:0");
    expect(p.getSnapshot().phase, "play() was called, but nothing is audible yet").toBe("preparing");
    expect(asked).toHaveLength(1); // nothing more is requested (or billed) before the first chunk really plays
    el.emit("playing");
    expect(p.getSnapshot().phase).toBe("playing");
    expect(asked).toHaveLength(2); // the next chunk is fetched while the first plays
    resolvers[1](new Blob(["b"]));
    el.emit("pause"); el.emit("ended"); await tick(); // the browser's own pause-before-ended is not an interruption
    expect(el.src).toBe("blob:1");
    expect(p.getSnapshot().phase).toBe("preparing");
    el.emit("playing");
    resolvers[2](new Blob(["c"]));
    el.emit("ended"); await tick();
    el.emit("playing"); el.emit("ended");
    expect(await done).toBe("done");
    expect(asked.map((t) => t.length)).toEqual(splitForSpeech(reply).map((t) => t.length));
    expect(p.getSnapshot()).toMatchObject({ id: null, phase: "idle", error: "" });
  });

  it("starting another reply stops the first (aborts its fetch); stop() is immediate and frees the audio", async () => {
    const signals: AbortSignal[] = [];
    const { p, el, revoked, tick } = rig((_t, s) => { signals.push(s); return Promise.resolve(new Blob(["a"])); });
    const first = p.play("m1", "أولى.");
    await tick(); el.emit("playing");
    expect(p.getSnapshot()).toMatchObject({ id: "m1", phase: "playing" });
    const second = p.play("m2", "ثانية.");
    expect(await first).toBe("stopped");
    expect(signals[0].aborted).toBe(true);
    expect(el.pause).toHaveBeenCalled();
    await tick(); el.emit("playing");
    expect(p.getSnapshot()).toMatchObject({ id: "m2", phase: "playing" });
    p.stop();
    expect(await second).toBe("stopped");
    expect(p.getSnapshot()).toMatchObject({ id: null, phase: "idle" });
    expect(revoked.length).toBe(2);
  });

  it("an engine without voice is said plainly and remembered; a blocked autoplay asks for a tap that continues the SAME audio", async () => {
    voiceAvailability.reset();
    const { p } = rig(() => Promise.reject(new BashtError("voice_unavailable")));
    expect(await p.play("m1", "نص.")).toBe("error");
    expect(p.getSnapshot()).toMatchObject({ id: "m1", phase: "error", code: "voice_unavailable", errorKind: "unavailable", canResume: false });
    expect(p.getSnapshot().error).toMatch(/غير مفعّل في المحرك/);
    expect(voiceAvailability.get().speak).toBe("no");
    voiceAvailability.reset();
    const asked: string[] = [];
    const blocked = rig((t) => { asked.push(t); return Promise.resolve(new Blob(["a"])); });
    blocked.el.play.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    expect(await blocked.p.play("m1", "نص.")).toBe("error");
    expect(blocked.p.getSnapshot()).toMatchObject({ code: "playback_blocked", phase: "error", canResume: true });
    expect(voiceAvailability.get().speak, "the engine voice works; only this browser blocked playing it").toBe("yes");
    const again = blocked.p.resume(); // the owner's next tap
    expect(blocked.el.play).toHaveBeenCalledTimes(2); // synchronously, inside that tap
    expect(asked).toHaveLength(1); // no second /speak (it may be billed)
    blocked.el.emit("playing"); blocked.el.emit("ended");
    expect(await again).toBe("done");
  });
});

describe("one conversation, one mic", () => {
  const chat = src("features/chat/chat-screen.tsx");
  it("the composer has ONE mic: a voice note with the engine's voice, browser dictation otherwise", () => {
    expect(chat).toMatch(/\{noteMode\s*\? <button[\s\S]*?recordNote\(\)[\s\S]*?: <button[\s\S]*?dictation\.start\(draft, setDraft\)/);
    expect(chat).toMatch(/const noteMode = voiceOn && recorder\.supported && voiceAvail\.transcribe !== "no";/);
  });
  it("a voice note goes through the same send path, is marked, and is never claimed as sent when it was not", () => {
    expect(chat).toMatch(/send: async \(text\) => \{ try \{ await noteDeps\.current\.basht\.send\(text\); \}/); // the same send path
    expect(chat).toMatch(/canSend: \(\) => sendable\.current/);
    expect(chat).toMatch(/notes\.current\?\.cancel\(\); setDraft\(""\)/); // a composer reset cancels the note in flight
    const lib = src("lib/basht-voice.ts");
    expect(lib).toMatch(/await d\.send\(voiceNoteText\(text\)\)/);
    expect(lib).toMatch(/if \(!d\.canSend\(\)\) \{ d\.setDraft\(text\);/);
  });
  it("«استمع» is on BASHT's replies only, and the live session speaks in the same conversation", () => {
    // the stable engine row id (a reply being played keeps its state when earlier rows load above it)
    expect(chat).toMatch(/\{m\.role === "assistant" && <ListenButton id=\{m\.id \|\| key\} text=\{m\.text\} \/>\}/);
    expect(chat).toMatch(/engineBubble\(it\.m, it\.m\.id \? `e-\$\{it\.m\.id\}` : `e-\$\{it\.i\}-\$\{it\.at\}`\)/);
    // self-contained: the button reads the shared player and the engine's availability itself (safe inside a memoized timeline)
    const btn = src("features/chat/listen-button.tsx");
    expect(btn).toMatch(/usePlayer\(\)/); expect(btn).toMatch(/speakGate\(avail, status\)\.show/);
    expect(chat).toMatch(/const id = await basht\.send\(text\);\s*const end = await basht\.waitRun\(id\);/);
    const panel = src("features/calls/calls-screen.tsx");
    expect(panel).toMatch(/ask: \(text\) => latest\.current\.live\.ask\(text\)/);
    expect(panel).toMatch(/play: \(text, onPlayer\) => voicePlayer\(\)\.play\("live", text, \{ onPhase: onPlayer \}\)/);
    expect(src("lib/basht-voice.ts")).toMatch(/await d\.ask\(voiceNoteText\(text\)\)/);
    expect(panel).not.toMatch(/RTCPeerConnection|talk\.client|getVoices/); // no parallel voice system (no WebRTC, no browser TTS)
  });
  it("no provider key or voice choice lives in the app", () => {
    for (const f of ["lib/basht-voice.ts", "server/basht-chat.ts", "features/calls/calls-screen.tsx"]) expect(src(f)).not.toMatch(/OPENAI|ELEVENLABS|apiKey|speakerVoice|voiceId/);
  });
});


// ── regressions (review): no recording after a cancel during the permission prompt; no stale live session after a restart ──
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fakeMic() {
  const perm = deferred<{ getTracks: () => { stop: () => void }[] }>();
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const recorders: { start: ReturnType<typeof vi.fn> }[] = [];
  const env: RecorderEnv = {
    getUserMedia: () => perm.promise, pickType: () => "audio/webm",
    createRecorder: () => {
      const r = { state: "inactive", mimeType: "audio/webm", ondataavailable: null as null | ((e: { data: Blob }) => void), onstop: null as null | (() => void),
        start: vi.fn(() => { r.state = "recording"; }), stop: vi.fn(() => { r.state = "inactive"; r.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) }); r.onstop?.(); }) };
      recorders.push(r); return r;
    },
    onPhase: vi.fn(), onElapsed: vi.fn(), onError: vi.fn(),
  };
  return { env, grant: () => perm.resolve(stream), track, recorders };
}

describe("recording lifecycle (permission prompt)", () => {
  it.each(["cancel", "stop"] as const)("%s while the permission prompt is open: the mic is released at once and nothing is recorded or sent", async (how) => {
    const m = fakeMic();
    const { handle, result } = startRecording(m.env);
    handle[how](); // the panel closed / the owner cancelled before allowing the microphone
    m.grant();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.recorders).toHaveLength(0); // no MediaRecorder was ever started
    expect(m.track.stop).toHaveBeenCalled();
    expect(await result).toMatchObject({ audio: null, ended: "cancel" });
    expect(m.env.onPhase).toHaveBeenLastCalledWith("idle");
  });
  it("a normal recording still records, and releases the mic when stopped", async () => {
    const m = fakeMic();
    const { handle, result } = startRecording(m.env);
    m.grant();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.recorders[0].start).toHaveBeenCalled();
    handle.stop();
    const r = await result;
    expect(r.ended).toBe("stop"); expect(r.audio?.size).toBe(2000);
    expect(m.track.stop).toHaveBeenCalled();
  });
});

describe("live voice session (restart race)", () => {
  function rig() {
    const records: ReturnType<typeof deferred<RecordResult>>[] = [];
    const transcripts: ReturnType<typeof deferred<string>>[] = [];
    const replies: ReturnType<typeof deferred<string>>[] = [];
    const calls = { ask: [] as string[], play: [] as string[], errors: [] as string[], phases: [] as string[] };
    const d: LiveDeps = {
      record: (onStarted) => { const x = deferred<RecordResult>(); records.push(x); onStarted(); return x.promise; },
      cancelRecord: vi.fn(), stopPlay: vi.fn(),
      transcribe: () => { const x = deferred<string>(); transcripts.push(x); return x.promise; },
      ask: (t) => { calls.ask.push(t); const x = deferred<string>(); replies.push(x); return x.promise; },
      play: async (t) => { calls.play.push(t); return "done"; },
      playError: () => "", recordError: () => "",
      onPhase: (p) => calls.phases.push(p), onHeard: () => {}, onError: (m) => { if (m) calls.errors.push(m); },
    };
    return { s: createLiveSession(d), d, records, transcripts, replies, calls };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const audio = { audio: new Blob([new Uint8Array(2000)]), ended: "silence" as const, ms: 1500 };

  it("an ended session whose transcription finishes after a restart sends nothing and starts no second recorder", async () => {
    const t = rig();
    t.s.start(); await tick();
    t.records[0].resolve(audio); await tick(); // session 1 is transcribing
    t.s.end(); t.s.start(); await tick();      // the owner ends it and starts again at once: session 2 is listening
    expect(t.records).toHaveLength(2);
    t.transcripts[0].resolve("النص القديم"); await tick();
    expect(t.calls.ask).toEqual([]);            // the old transcript is never sent
    expect(t.records).toHaveLength(2);          // and the old loop does not start a competing recorder
    expect(t.calls.phases.at(-1)).toBe("listening");
  });

  it("an old reply arriving after a restart is never spoken over the new session", async () => {
    const t = rig();
    t.s.start(); await tick();
    t.records[0].resolve(audio); await tick();
    t.transcripts[0].resolve("سؤال"); await tick();
    expect(t.calls.ask).toEqual(["[رسالة صوتية] سؤال"]);
    t.s.end(); t.s.start(); await tick();
    t.replies[0].resolve("الرد القديم"); await tick();
    expect(t.calls.play).toEqual([]);
    expect(t.records).toHaveLength(2);
  });

  it("an old session's failure after a restart is not reported into (and does not end) the new one", async () => {
    const t = rig();
    t.s.start(); await tick();
    t.records[0].resolve(audio); await tick();
    t.s.start(); await tick(); // start again directly (no explicit end)
    t.transcripts[0].reject(new Error("تعذّر")); await tick();
    expect(t.calls.errors).toEqual([]);
    expect(t.calls.phases.at(-1)).toBe("listening");
    // the new session still works end to end
    t.records[1].resolve(audio); await tick();
    t.transcripts[1].resolve("جديد"); await tick();
    t.replies[0].resolve("رد"); await tick(); await tick();
    expect(t.calls.ask).toEqual(["[رسالة صوتية] جديد"]);
    expect(t.calls.play).toEqual(["رد"]);
  });
});


describe("one microphone owner (composer note vs live panel)", () => {
  it("a new recording cancels the one in progress: a hidden voice note never keeps recording (or sends) behind the voice panel", async () => {
    const note = fakeMic(), live = fakeMic();
    const a = startRecording(note.env); note.grant(); await new Promise((r) => setTimeout(r, 0));
    expect(note.recorders[0].start).toHaveBeenCalled();  // the composer's voice note is recording
    const b = startRecording(live.env);                   // the live session takes the microphone
    expect(note.track.stop).toHaveBeenCalled();           // the hidden note's mic is released at once
    const ra = await a.result;
    expect(ra).toMatchObject({ audio: null, ended: "cancel" }); // nothing kept, so nothing is transcribed or sent
    expect(note.track.stop).toHaveBeenCalled();
    live.grant(); await new Promise((r) => setTimeout(r, 0));
    expect(live.recorders[0].start).toHaveBeenCalled();
    b.handle.stop();
    expect((await b.result).audio?.size).toBe(2000);
  });
  it("opening the voice panel cancels a composer recording", () => {
    const chat = src("features/chat/chat-screen.tsx");
    expect(chat).toMatch(/const openVoice = \(autostart = false\) => \{ recorder\.cancel\(\); setVoiceAuto\(autostart\); setVoice\(true\); \};/);
    expect(chat).not.toMatch(/setVoice\(true\)(?!; \};)/);
  });
});

describe("voice note operation (switching conversations)", () => {
  function noteRig(canSend = true) {
    const tr = deferred<string>();
    let signal: AbortSignal | null = null;
    const calls = { send: [] as string[], draft: [] as string[], notice: [] as string[], busy: [] as boolean[] };
    let sendable = canSend;
    const n = createVoiceNotes({
      transcribe: (_a, s) => { signal = s; return tr.promise; },
      canSend: () => sendable,
      send: async (t) => { calls.send.push(t); },
      setDraft: (t) => calls.draft.push(t), setNotice: (m) => calls.notice.push(m), setBusy: (b) => calls.busy.push(b),
    });
    return { n, tr, calls, signal: () => signal, setSendable: (v: boolean) => { sendable = v; } };
  }
  const blob = new Blob([new Uint8Array(2000)]);

  it("a transcript that arrives after the composer was reset is never sent, and writes no draft or notice", async () => {
    const t = noteRig();
    const done = t.n.run(blob);
    t.n.cancel();                              // the owner switched conversations while it was transcribing
    expect(t.signal()?.aborted).toBe(true);    // the upload is aborted
    t.tr.resolve("ملاحظة قديمة");
    expect(await done).toBe("cancelled");
    expect(t.calls).toMatchObject({ send: [], draft: [], notice: [] });
    expect(t.calls.busy.at(-1)).toBe(false);
  });
  it("a failure after the reset never overwrites the new draft", async () => {
    const t = noteRig();
    const done = t.n.run(blob);
    t.n.cancel();
    t.tr.reject(new BashtError("unavailable"));
    expect(await done).toBe("cancelled");
    expect(t.calls).toMatchObject({ draft: [], notice: [] });
  });
  it("whether BASHT can take it is decided when the transcript is back, not when the note started", async () => {
    const t = noteRig(true);
    const done = t.n.run(blob);
    t.setSendable(false);                      // BASHT went busy/offline meanwhile
    t.tr.resolve("نص");
    expect(await done).toBe("kept");
    expect(t.calls.send).toEqual([]); expect(t.calls.draft).toEqual(["نص"]);
    const ok = noteRig(true); const d2 = ok.n.run(blob); ok.tr.resolve("نص"); expect(await d2).toBe("sent");
    expect(ok.calls.send).toEqual(["[رسالة صوتية] نص"]);
  });
});
