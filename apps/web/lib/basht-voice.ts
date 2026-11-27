"use client";
/**
 * BASHT's voice in the ONE conversation (V2 listen · V3 voice notes · V4 live turns). No voice system of the app's own:
 *
 * - Speaking: the engine's `tts` agent tool (agents.entries.main.tts — the owner's voice, model and pronunciation/dialect
 *   instructions) through /api/basht/speak. A reply is split on sentence boundaries into chunks of ≤ 1500 characters and played in
 *   order; the first chunk starts as soon as it arrives, the next one is fetched while the current one plays. One playback at a time.
 * - Listening: a voice note recorded here (MediaRecorder, ≤ 3 minutes) is transcribed by the engine with its own audio config
 *   (/api/basht/transcribe) and sent to BASHT as the owner's message, marked as a voice note. Browser dictation stays the fallback.
 * - Honest states: a voice the engine does not offer is remembered for this page session and said plainly; nothing pretends.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bashtClient, BashtError, bashtErrorText } from "./basht-client";

export const MAX_SPEAK_CHARS = 1500;
export const MAX_NOTE_MS = 3 * 60_000;
/** How a voice note is marked in the conversation (BASHT sees it too: the text is a transcript and may contain mishearings). */
export const VOICE_NOTE_PREFIX = "[رسالة صوتية] ";

export const voiceNoteText = (transcript: string) => VOICE_NOTE_PREFIX + transcript.trim();
export function parseVoiceNote(text: string): { voice: boolean; text: string } {
  return text.startsWith(VOICE_NOTE_PREFIX) ? { voice: true, text: text.slice(VOICE_NOTE_PREFIX.length) } : { voice: false, text };
}

/** m:ss for the recording timer. */
export const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ── chunking ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const SENTENCE_END = /(?<=[.!?؟…。\n])\s+/u;
const CLAUSE_END = /(?<=[،؛,;:])\s+/u;

/** Pieces of `s` no longer than `max`: by clause, then by word, then (a single overlong word) by length. */
function pieces(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  for (const level of [CLAUSE_END, /\s+/u]) {
    const parts = s.split(level).filter(Boolean);
    if (parts.length > 1) { for (const p of pack(parts, max, " ")) out.push(...pieces(p, max)); return out; }
  }
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}
function pack(parts: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (!cur) cur = p;
    else if (cur.length + sep.length + p.length <= max) cur += sep + p;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

/** A reply as speakable chunks of ≤ `max` characters, cut on sentence boundaries (then clauses, then words). Order preserved. */
export function splitForSpeech(text: string, max = MAX_SPEAK_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const sentences = clean.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean).flatMap((s) => pieces(s, max));
  return pack(sentences, max, " ").map((c) => c.trim()).filter(Boolean);
}

// ── recording format ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The first container the browser can record that the engine accepts (Safari: mp4/AAC; Chrome/Firefox: webm or ogg Opus). */
export const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
export function pickRecorderType(isSupported: (t: string) => boolean): string | null {
  for (const t of RECORDER_TYPES) { try { if (isSupported(t)) return t; } catch { /* keep looking */ } }
  return null;
}

/** Hands-free end of turn: stop after `silenceMs` of quiet once speech was heard; give up if nothing is said for `noSpeechMs`. */
export function createSilenceGate({ threshold = 0.02, silenceMs = 1400, noSpeechMs = 12_000 } = {}) {
  let start = -1, heard = 0, loud = 0;
  return (level: number, now: number): "wait" | "stop" | "no_speech" => {
    if (start < 0) start = now;
    if (level >= threshold) { heard ||= now; loud = now; return "wait"; }
    if (heard && now - loud >= silenceMs) return "stop";
    if (!heard && now - start >= noSpeechMs) return "no_speech";
    return "wait";
  };
}

// ── what the engine offers (learned from its answers, kept for this page session) ───────────────────────────────────────
export type Avail = "unknown" | "yes" | "no";
export type VoiceAvail = { speak: Avail; transcribe: Avail };
let avail: VoiceAvail = { speak: "unknown", transcribe: "unknown" };
const availSubs = new Set<() => void>();
export const voiceAvailability = {
  get: () => avail,
  set(kind: keyof VoiceAvail, v: Avail) { if (avail[kind] !== v) { avail = { ...avail, [kind]: v }; availSubs.forEach((f) => f()); } },
  subscribe(f: () => void) { availSubs.add(f); return () => { availSubs.delete(f); }; },
  reset() { avail = { speak: "unknown", transcribe: "unknown" }; availSubs.forEach((f) => f()); },
};
const SERVER_AVAIL: VoiceAvail = { speak: "unknown", transcribe: "unknown" };
export const useVoiceAvailability = () => useSyncExternalStore(voiceAvailability.subscribe, voiceAvailability.get, () => SERVER_AVAIL);

// ── playback: one at a time ─────────────────────────────────────────────────────────────────────────────────────────────
export type PlayerPhase = "idle" | "loading" | "playing";
export type PlayerState = { id: string | null; phase: PlayerPhase; error: string; code: string };
export type PlayResult = "done" | "stopped" | "error";
type AudioLike = { src: string; play: () => Promise<void>; pause: () => void; onended: (() => void) | null; onerror: (() => void) | null };
type PlayerDeps = {
  speak: (text: string, signal: AbortSignal) => Promise<Blob>;
  audio: () => AudioLike;
  url?: { create: (b: Blob) => string; revoke: (u: string) => void };
};

/** A 20 ms silent WAV: played inside the tap so iOS lets the same element play BASHT's voice once it has arrived. */
function silentWav(): string {
  const n = 160, b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, n, true);
  b.fill(128, 44);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return "data:audio/wav;base64," + btoa(s);
}

export function createVoicePlayer(deps: PlayerDeps) {
  const url = deps.url ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
  let state: PlayerState = { id: null, phase: "idle", error: "", code: "" };
  const subs = new Set<() => void>();
  const set = (s: Partial<PlayerState>) => { state = { ...state, ...s }; subs.forEach((f) => f()); };
  let gen = 0, ctl: AbortController | null = null, el: AudioLike | null = null, urls: string[] = [];
  const element = () => (el ??= deps.audio());
  const cleanup = () => {
    ctl?.abort(); ctl = null;
    if (el) { el.onended = null; el.onerror = null; try { el.pause(); } catch { /* not playing */ } }
    urls.forEach((u) => url.revoke(u)); urls = [];
  };

  /** Plays one blob URL to its end. Resolves early (quietly) when the playback is stopped. */
  const playOne = (a: AudioLike, u: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    a.onended = () => resolve();
    a.onerror = () => reject(new BashtError("playback"));
    a.src = u;
    set({ phase: "playing" });
    a.play().catch((e: unknown) => reject(new BashtError((e as { name?: string })?.name === "NotAllowedError" ? "playback_blocked" : "playback")));
  });

  return {
    getSnapshot: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    /** Call synchronously from the tap that starts playback (or the live session): unlocks audio output on iOS. */
    unlock() { try { const a = element(); a.src = silentWav(); void a.play().catch(() => {}); } catch { /* best effort */ } },
    stop() { gen++; cleanup(); if (state.id || state.phase !== "idle") set({ id: null, phase: "idle" }); },
    clearError() { if (state.error) set({ error: "", code: "" }); },
    /** Speaks `text` in BASHT's voice, chunk by chunk. `id` names what is playing (a reply bubble, or the live session). */
    async play(id: string, text: string): Promise<PlayResult> {
      gen++; cleanup();
      const my = gen;
      const chunks = splitForSpeech(text);
      if (!chunks.length) { set({ id: null, phase: "idle" }); return "done"; }
      const c = new AbortController(); ctl = c;
      const a = element();
      set({ id, phase: "loading", error: "", code: "" });
      const fetchChunk = (i: number) => { const p = deps.speak(chunks[i], c.signal); p.catch(() => {}); return p; };
      let next: Promise<Blob> | null = fetchChunk(0);
      try {
        for (let i = 0; next; i++) {
          const blob = await next;
          if (my !== gen) return "stopped";
          voiceAvailability.set("speak", "yes");
          next = i + 1 < chunks.length ? fetchChunk(i + 1) : null; // sequential: the next chunk is asked for while this one plays
          const u = url.create(blob); urls.push(u);
          await playOne(a, u, c.signal);
          if (my !== gen) return "stopped";
          url.revoke(u); urls = urls.filter((x) => x !== u);
          if (next) set({ phase: "loading" });
        }
        ctl = null;
        set({ id: null, phase: "idle" });
        return "done";
      } catch (e) {
        if (my !== gen) return "stopped";
        const code = e instanceof BashtError ? e.code : "unavailable";
        if (code === "voice_unavailable") voiceAvailability.set("speak", "no");
        cleanup();
        set({ id: null, phase: "idle", error: PLAYER_ERRORS[code] ?? bashtErrorText(code), code });
        return "error";
      }
    },
  };
}
const PLAYER_ERRORS: Record<string, string> = {
  voice_unavailable: "صوت باشت غير مفعّل في المحرك الآن؛ الرد مكتوب في المحادثة.",
  playback_blocked: "منع المتصفح تشغيل الصوت. اضغط «استمع» مرة أخرى.",
  playback: "تعذّر تشغيل الصوت على هذا الجهاز.",
};

export type VoicePlayer = ReturnType<typeof createVoicePlayer>;
let shared: VoicePlayer | null = null;
/** The ONE player of the app (one playback at a time, everywhere). */
export function voicePlayer(): VoicePlayer {
  return (shared ??= createVoicePlayer({ speak: (t, s) => bashtClient.speak(t, s), audio: () => new Audio() as unknown as AudioLike }));
}
const IDLE: PlayerState = { id: null, phase: "idle", error: "", code: "" };
export function usePlayer(): PlayerState {
  const p = voicePlayer();
  return useSyncExternalStore(p.subscribe, p.getSnapshot, () => IDLE);
}

// ── recording ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type RecordEnd = "stop" | "cancel" | "silence" | "no_speech" | "limit" | "error";
export type RecordResult = { audio: Blob | null; ended: RecordEnd; ms: number };
type Rec = { stop: () => void; cancel: () => void };

let ctx: AudioContext | null = null;
/** One AudioContext for silence detection, created/resumed inside a tap (iOS keeps it suspended otherwise). */
export function primeAudioInput() {
  try {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return;
    ctx ??= new C();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch { /* no silence detection: the owner taps to end the turn */ }
}

const micError = (e: unknown) => {
  const n = (e as { name?: string })?.name;
  return n === "NotAllowedError" || n === "SecurityError" ? "لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح."
    : n === "NotFoundError" ? "لا يوجد ميكروفون متاح على هذا الجهاز." : "تعذّر بدء التسجيل.";
};

export const recorderSupported = () => typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined"
  && !!navigator.mediaDevices?.getUserMedia && pickRecorderType((t) => window.MediaRecorder.isTypeSupported?.(t) ?? false) !== null;

type TrackLike = { stop: () => void };
type StreamLike = { getTracks: () => TrackLike[] };
type RecorderLike = {
  state: string; mimeType: string; start: (timeslice?: number) => void; stop: () => void;
  ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null;
};
/** What one recording needs from the browser (injected, so the lifecycle is testable without a DOM). */
export type RecorderEnv = {
  getUserMedia: () => Promise<StreamLike>;
  pickType: () => string | null;
  createRecorder: (stream: StreamLike, type: string | null) => RecorderLike;
  /** Input level reader for hands-free end of turn (null: the owner taps to end). */
  levelProbe?: (stream: StreamLike) => { read: () => number; close: () => void } | null;
  onPhase: (p: "idle" | "starting" | "recording") => void;
  onElapsed: (ms: number) => void;
  onError: (msg: string) => void;
  now?: () => number;
};
const failed = (ended: RecordEnd = "error"): RecordResult => ({ audio: null, ended, ms: 0 });

/**
 * One recording. The handle exists BEFORE the microphone permission is asked: a cancel (or stop, or unmount) while the permission
 * prompt is still open is remembered, and once the browser hands over the stream its tracks are stopped at once — nothing is
 * recorded, nothing is sent, the mic never stays on behind a closed screen.
 */
export function startRecording(env: RecorderEnv, { maxMs = MAX_NOTE_MS, silence = false }: { maxMs?: number; silence?: boolean } = {}): { handle: Rec; result: Promise<RecordResult> } {
  const now = env.now ?? Date.now;
  let early = false; // stop/cancel before recording started: nothing to keep
  let endNow: ((why: RecordEnd) => void) | null = null;
  const handle: Rec = { stop: () => (endNow ? endNow("stop") : (early = true)), cancel: () => (endNow ? endNow("cancel") : (early = true)) };
  const result = (async (): Promise<RecordResult> => {
    env.onError(""); env.onPhase("starting"); env.onElapsed(0);
    let stream: StreamLike;
    try { stream = await env.getUserMedia(); }
    catch (e) { env.onPhase("idle"); if (early) return failed("cancel"); env.onError(micError(e)); return failed(); }
    const release = () => stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
    if (early) { release(); env.onPhase("idle"); return failed("cancel"); }
    const type = env.pickType();
    let mr: RecorderLike;
    try { mr = env.createRecorder(stream, type); }
    catch { release(); env.onPhase("idle"); env.onError("هذا المتصفح لا يدعم تسجيل الصوت."); return failed(); }

    return new Promise<RecordResult>((resolve) => {
      const chunks: Blob[] = [];
      const started = now();
      let ended: RecordEnd = "stop";
      const end = (why: RecordEnd) => { ended = why; if (mr.state !== "inactive") try { mr.stop(); } catch { /* already stopping */ } };
      const tick = setInterval(() => { const ms = now() - started; env.onElapsed(ms); if (ms >= maxMs) end("limit"); }, 200);
      // hands-free: the input level decides when the owner has finished speaking
      let probe: ReturnType<typeof setInterval> | null = null;
      const level = silence ? env.levelProbe?.(stream) ?? null : null;
      if (level) {
        const gate = createSilenceGate();
        probe = setInterval(() => { const v = gate(level.read(), now()); if (v === "stop") end("silence"); else if (v === "no_speech") end("no_speech"); }, 100);
      }
      const finish = () => { clearInterval(tick); if (probe) clearInterval(probe); try { level?.close(); } catch { /* gone */ } release(); };
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        finish(); // the mic is released between turns (iOS plays BASHT's voice at full volume then)
        env.onPhase("idle"); env.onElapsed(0);
        const keep = ended !== "cancel" && ended !== "no_speech" && ended !== "error" && chunks.length > 0;
        resolve({ audio: keep ? new Blob(chunks, { type: mr.mimeType || type || "audio/webm" }) : null, ended, ms: now() - started });
      };
      endNow = end;
      try { mr.start(1000); env.onPhase("recording"); }
      catch { endNow = null; finish(); env.onPhase("idle"); env.onError("تعذّر بدء التسجيل."); resolve(failed()); }
    });
  })();
  return { handle, result };
}

/** The browser's side of a recording: the real microphone, MediaRecorder and (when primed in a tap) the level probe. */
function browserRecorderEnv(set: Pick<RecorderEnv, "onPhase" | "onElapsed" | "onError">): RecorderEnv {
  return {
    ...set,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }), // the browser's own voice processing defaults
    pickType: () => pickRecorderType((t) => MediaRecorder.isTypeSupported?.(t) ?? false),
    createRecorder: (stream, type) => new MediaRecorder(stream as MediaStream, type ? { mimeType: type } : undefined) as unknown as RecorderLike,
    levelProbe: (stream) => {
      if (!ctx || ctx.state !== "running") return null;
      try {
        const source = ctx.createMediaStreamSource(stream as MediaStream);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        return {
          read: () => { analyser.getFloatTimeDomainData(buf); let sum = 0; for (const x of buf) sum += x * x; return Math.sqrt(sum / buf.length); },
          close: () => source.disconnect(),
        };
      } catch { return null; }
    },
  };
}

/** Records one voice note / one live turn. `silence: true` ends the turn by itself after a pause (hands-free). */
export function useVoiceRecorder() {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(false);
  const rec = useRef<Rec | null>(null);
  // leaving the screen cancels a recording — also one still waiting for the microphone permission
  useEffect(() => { setSupported(recorderSupported()); return () => rec.current?.cancel(); }, []);

  const record = useCallback(async (opts: { maxMs?: number; silence?: boolean } = {}): Promise<RecordResult> => {
    rec.current?.cancel(); // never two recordings: a newer one replaces (and cancels) an older one
    rec.current = null;
    const mine: { handle: Rec | null } = { handle: null };
    const only = <T,>(f: (v: T) => void) => (v: T) => { if (rec.current === mine.handle) f(v); }; // a cancelled one no longer drives the UI
    const { handle, result } = startRecording(browserRecorderEnv({ onPhase: only(setPhase), onElapsed: only(setElapsed), onError: only(setError) }), opts);
    mine.handle = handle;
    rec.current = handle;
    try { return await result; } finally { if (rec.current === handle) { rec.current = null; setPhase("idle"); } }
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => rec.current?.cancel(), []);
  return { supported, phase, recording: phase !== "idle", elapsed, error, clearError: () => setError(""), record, stop, cancel };
}

// ── the live voice session (V4): listen → transcribe → ask BASHT → speak → listen again ─────────────────────────────────
export type LivePhase = "idle" | "listening" | "thinking" | "speaking";
export type LiveDeps = {
  record: () => Promise<RecordResult>;
  cancelRecord: () => void;
  transcribe: (audio: Blob) => Promise<string>;
  /** sends one owner turn (already marked as a voice note) and resolves with BASHT's finished reply */
  ask: (text: string) => Promise<string>;
  play: (text: string) => Promise<PlayResult>;
  stopPlay: () => void;
  playError: () => string;
  recordError: () => string;
  onPhase: (p: LivePhase) => void;
  onHeard: (text: string) => void;
  onError: (msg: string) => void;
  cue?: (kind: "start" | "stop") => void;
};

/**
 * Each start() opens a NEW session (a generation token). Every await is followed by a check that this session is still the current
 * one, so a session that was ended — even one restarted right away — never sends its old transcript, never speaks its old reply over
 * the new recording, never reports its errors into the new session and never starts another recorder.
 */
export function createLiveSession(d: LiveDeps) {
  let gen = 0;
  const end = (msg = "") => { gen++; d.cancelRecord(); d.stopPlay(); d.onPhase("idle"); if (msg) d.onError(msg); };
  async function run(my: number) {
    const live = () => my === gen;
    const fail = (msg: string) => { if (live()) end(msg); };
    let quiet = 0;
    while (live()) {
      d.onPhase("listening"); d.cue?.("start");
      const r = await d.record();
      if (!live()) return;
      if (!r.audio) {
        if (r.ended === "no_speech" && ++quiet < 2) continue; // one quiet turn is forgiven; two end the session
        return fail(r.ended === "no_speech" ? "لم أسمع كلامًا، فأنهيت الجلسة. اضغط للبدء من جديد." : d.recordError());
      }
      quiet = 0;
      d.cue?.("stop");
      d.onPhase("thinking");
      let text: string;
      try { text = await d.transcribe(r.audio); }
      catch (e) {
        if (!live()) return;
        if (e instanceof BashtError && e.code === "no_speech") continue;
        return fail(e instanceof Error ? e.message : "تعذّر تفريغ الصوت.");
      }
      if (!live()) return;
      d.onHeard(text);
      let reply: string;
      try { reply = await d.ask(voiceNoteText(text)); }
      catch (e) { return fail(e instanceof Error ? e.message : "تعذّر الإرسال إلى باشت."); }
      if (!live()) return;
      d.onPhase("speaking");
      const played = await d.play(reply);
      if (!live()) return;
      if (played === "error") return fail(d.playError());
    }
  }
  return {
    /** Starts a new session (ending any previous one first). */
    start() {
      end(); // a previous session (if any) is over: its recorder and playback stop, its pending awaits are now stale
      d.onError(""); d.onHeard("");
      const my = ++gen;
      void run(my).catch(() => { if (my === gen) end("تعذّر إكمال الجلسة الصوتية."); });
    },
    end,
  };
}
