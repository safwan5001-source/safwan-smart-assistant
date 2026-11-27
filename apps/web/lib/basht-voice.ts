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

/** Records one voice note / one live turn. `silence: true` ends the turn by itself after a pause (hands-free). */
export function useVoiceRecorder() {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(false);
  const rec = useRef<Rec | null>(null);
  useEffect(() => { setSupported(recorderSupported()); return () => rec.current?.cancel(); }, []);

  const record = useCallback(async ({ maxMs = MAX_NOTE_MS, silence = false }: { maxMs?: number; silence?: boolean } = {}): Promise<RecordResult> => {
    if (rec.current) return { audio: null, ended: "error", ms: 0 };
    setError(""); setPhase("starting"); setElapsed(0);
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } // the browser's own voice processing defaults
    catch (e) { setPhase("idle"); setError(micError(e)); return { audio: null, ended: "error", ms: 0 }; }
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported?.(t) ?? false);
    let mr: MediaRecorder;
    try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch { stream.getTracks().forEach((t) => t.stop()); setPhase("idle"); setError("هذا المتصفح لا يدعم تسجيل الصوت."); return { audio: null, ended: "error", ms: 0 }; }

    return new Promise<RecordResult>((resolve) => {
      const chunks: Blob[] = [];
      const started = Date.now();
      let ended: RecordEnd = "stop";
      const end = (why: RecordEnd) => { ended = why; if (mr.state !== "inactive") try { mr.stop(); } catch { /* already stopping */ } };
      const tick = setInterval(() => { const ms = Date.now() - started; setElapsed(ms); if (ms >= maxMs) end("limit"); }, 200);
      // hands-free: the input level decides when the owner has finished speaking
      let probe: ReturnType<typeof setInterval> | null = null, source: MediaStreamAudioSourceNode | null = null;
      if (silence && ctx && ctx.state === "running") {
        try {
          source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const gate = createSilenceGate();
          probe = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0; for (const x of buf) sum += x * x;
            const v = gate(Math.sqrt(sum / buf.length), Date.now());
            if (v === "stop") end("silence"); else if (v === "no_speech") end("no_speech");
          }, 100);
        } catch { /* tap to end instead */ }
      }
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        clearInterval(tick); if (probe) clearInterval(probe); try { source?.disconnect(); } catch { /* gone */ }
        stream.getTracks().forEach((t) => t.stop()); // the mic is released between turns (iOS plays BASHT's voice at full volume then)
        rec.current = null; setPhase("idle"); setElapsed(0);
        const ms = Date.now() - started;
        const keep = ended !== "cancel" && ended !== "no_speech" && ended !== "error" && chunks.length > 0;
        resolve({ audio: keep ? new Blob(chunks, { type: mr.mimeType || type || "audio/webm" }) : null, ended, ms });
      };
      rec.current = { stop: () => end("stop"), cancel: () => end("cancel") };
      try { mr.start(1000); setPhase("recording"); }
      catch { rec.current = null; clearInterval(tick); if (probe) clearInterval(probe); stream.getTracks().forEach((t) => t.stop()); setPhase("idle"); setError("تعذّر بدء التسجيل."); resolve({ audio: null, ended: "error", ms: 0 }); }
    });
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => rec.current?.cancel(), []);
  return { supported, phase, recording: phase !== "idle", elapsed, error, clearError: () => setError(""), record, stop, cancel };
}
