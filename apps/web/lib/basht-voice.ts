"use client";
/**
 * BASHT's voice in the ONE conversation (V2 listen · V3 voice notes · V4 live turns). No voice system of the app's own:
 *
 * - Speaking: the engine's `tts` agent tool (agents.entries.main.tts — the owner's voice, model and pronunciation/dialect
 *   instructions) through /api/basht/speak. A reply is cleaned for speech (lib/speakable: no MEDIA markers, paths, URLs or markdown),
 *   split on sentence boundaries into chunks of ≤ 1500 characters and played in order; the first chunk starts as soon as it arrives,
 *   the next one is fetched while it plays. One playback at a time. Phases come from the media element's own events (honest).
 * - Listening: a voice note recorded here (MediaRecorder, ≤ 3 minutes) is transcribed by the engine with its own audio config
 *   (/api/basht/transcribe) and sent to BASHT as the owner's message, marked as a voice note. Browser dictation stays the fallback.
 * - Honest states: a voice the engine does not offer is remembered for this page session and said plainly; nothing pretends.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bashtClient, BashtError, bashtErrorText, voiceReasonText, type VoiceReason } from "./basht-client";
import { enterVoiceSession, type VoiceToken } from "./audio";
import { audioContext, closeAudioContext, primeAudioContext, resumeAudioContext, suspendAudioContext } from "./audio-context";
import { speakableText } from "./speakable";
import { isDurableVoiceFailure } from "./voice-status";

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
export type VoiceAvail = { speak: Avail; transcribe: Avail; reason: VoiceReason | "" };
let avail: VoiceAvail = { speak: "unknown", transcribe: "unknown", reason: "" };
const availSubs = new Set<() => void>();
export const voiceAvailability = {
  get: () => avail,
  /** `reason`: why the engine voice is unavailable (with "no"), shown by the voice sheet and the dictation fallback. */
  set(kind: "speak" | "transcribe", v: Avail, reason?: VoiceReason) {
    const r = v === "no" ? reason ?? avail.reason : avail.reason;
    if (avail[kind] !== v || avail.reason !== r) { avail = { ...avail, [kind]: v, reason: r }; availSubs.forEach((f) => f()); }
  },
  subscribe(f: () => void) { availSubs.add(f); return () => { availSubs.delete(f); }; },
  reset() { avail = { speak: "unknown", transcribe: "unknown", reason: "" }; availSubs.forEach((f) => f()); },
};
const SERVER_AVAIL: VoiceAvail = { speak: "unknown", transcribe: "unknown", reason: "" };
export const useVoiceAvailability = () => useSyncExternalStore(voiceAvailability.subscribe, voiceAvailability.get, () => SERVER_AVAIL);

// ── playback: one at a time, phases from the media element's own events ──────────────────────────────────────────────────
/**
 * idle → preparing (fetching BASHT's voice) → playing (ONLY once the element fired `playing`) → idle, or → error.
 * Every path ends in idle or error: a load that never starts and a playback whose clock stops are both caught by watchdogs.
 */
export type PlayerPhase = "idle" | "preparing" | "playing" | "error";
export type PlayerErrorKind = "unavailable" | "playback_blocked" | "network" | "stalled" | "decode" | "interrupted" | "unauthorized" | "other";
export type PlayerState = {
  id: string | null; phase: PlayerPhase;
  /** Arabic message (empty unless phase is "error") */
  error: string;
  /** machine code: voice_unavailable · playback_blocked · network · stalled · decode · interrupted · unauthorized · <engine code> */
  code: string;
  errorKind: PlayerErrorKind | "";
  /** why the engine voice is unavailable (allowlisted reason), when it said so */
  errorReason: VoiceReason | "";
  /** the same audio can continue with a fresh tap (blocked autoplay, an OS interruption) — no new /speak request */
  canResume: boolean;
};
export type PlayResult = "done" | "stopped" | "error";
/** The part of HTMLAudioElement the player uses (a fake in tests). */
export type MediaLike = {
  src: string; currentTime: number; muted: boolean; ended?: boolean; duration?: number;
  error?: { code: number } | null;
  play: () => Promise<void> | void; pause: () => void;
  addEventListener: (type: string, cb: () => void) => void;
};
type PlayerDeps = {
  speak: (text: string, signal: AbortSignal) => Promise<Blob>;
  audio: () => MediaLike;
  url?: { create: (b: Blob) => string; revoke: (u: string) => void };
  /** after `playing`, the clock must advance within this time (default 4 s) */
  stallMs?: number;
  /** after the source is set, `playing` must arrive within this time (default 15 s) */
  startMs?: number;
  /** a `pause` not followed by `ended` within this time is an interruption by the OS (default 300 ms) */
  pauseGraceMs?: number;
};
export const PLAYER_EVENTS = ["loadstart", "canplay", "playing", "timeupdate", "stalled", "waiting", "pause", "ended", "error", "emptied"] as const;

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

/** `p`, or a rejection as soon as `signal` aborts (a stopped reply never waits for a fetch that ignores its signal). */
const untilAborted = <T,>(p: Promise<T>, signal: AbortSignal): Promise<T> => signal.aborted ? Promise.reject(new DOMException("stopped", "AbortError"))
  : new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("stopped", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });

class PlaybackFailure extends Error { constructor(public kind: PlayerErrorKind) { super(kind); } }
const playFailure = (e: unknown): PlaybackFailure => {
  const n = (e as { name?: string })?.name;
  return new PlaybackFailure(n === "NotAllowedError" ? "playback_blocked" : n === "NotSupportedError" ? "decode" : n === "AbortError" ? "interrupted" : "other");
};
export const PLAYER_ERRORS: Record<string, string> = {
  voice_unavailable: "صوت باشت غير مفعّل في المحرك الآن؛ الرد مكتوب في المحادثة.",
  playback_blocked: "منع المتصفح تشغيل الصوت. اضغط «شغّل الصوت» للمتابعة.",
  interrupted: "توقّف الصوت (مكالمة أو تغيير في مخرج الصوت). اضغط «تابِع» للاستئناف.",
  stalled: "توقّف الصوت ولم يتقدّم. اضغط «أعد المحاولة».",
  decode: "تعذّر تشغيل ملف الصوت على هذا الجهاز.",
  network: "انقطع الاتصال أثناء تجهيز الصوت. اضغط «أعد المحاولة».",
  timeout: "تأخّر تجهيز صوت باشت طويلًا فأُوقف الطلب. اضغط «أعد المحاولة».",
  playback: "توقّف تشغيل الصوت على هذا الجهاز.",
};
const IDLE: PlayerState = { id: null, phase: "idle", error: "", code: "", errorKind: "", errorReason: "", canResume: false };

type Job = { id: string; chunks: string[]; ctl: AbortController; index: number; url: string; onPhase?: (p: PlayerPhase) => void };
type Suspended = { job: Job; next: Promise<Blob> | null };

export function createVoicePlayer(deps: PlayerDeps) {
  const url = deps.url ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
  const stallMs = deps.stallMs ?? 4000, startMs = deps.startMs ?? 15_000, pauseGraceMs = deps.pauseGraceMs ?? 300;
  let state: PlayerState = IDLE;
  const subs = new Set<() => void>();
  let job: Job | null = null;
  const set = (s: Partial<PlayerState>) => {
    const before = state.phase;
    state = { ...state, ...s };
    if (job && state.phase !== before && (state.id === job.id)) job.onPhase?.(state.phase);
    subs.forEach((f) => f());
  };
  // playback progress (0..1 over the whole reply): its own tiny store, so the many «استمع» buttons do not re-render 4× a second
  let progress = 0;
  const progSubs = new Set<() => void>();
  const setProgress = (p: number) => { if (p !== progress) { progress = p; progSubs.forEach((f) => f()); } };

  let gen = 0, el: MediaLike | null = null, urls: string[] = [], muted = false;
  let suspended: Suspended | null = null;
  /** the current chunk's event handler (one at a time); events of any other source are ignored */
  let handler: ((type: string) => void) | null = null;
  const element = () => {
    if (!el) {
      const a = deps.audio();
      for (const t of PLAYER_EVENTS) a.addEventListener(t, () => handler?.(t));
      try { a.muted = muted; } catch { /* read-only in some fakes */ }
      el = a;
    }
    return el;
  };
  const cleanup = () => {
    job?.ctl.abort(); job = null; suspended = null;
    handler?.("__stop"); handler = null; // the pending chunk settles quietly (its generation is stale)
    if (el) { try { el.pause(); } catch { /* not playing */ } }
    urls.forEach((u) => url.revoke(u)); urls = [];
    setProgress(0);
  };

  /** Plays one source to its end. Resolves on `ended` (or quietly when stopped); rejects with a PlaybackFailure. */
  const playOne = (a: MediaLike, u: string, my: number, j: Job, onPlaying: () => void) => new Promise<void>((resolve, reject) => {
    let started = false, last = -1;
    let stall: ReturnType<typeof setTimeout> | null = null, pauseT: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { if (stall) clearTimeout(stall); if (pauseT) clearTimeout(pauseT); clearTimeout(startT); stall = pauseT = null; };
    const finish = (err?: PlaybackFailure) => {
      if (handler !== h) return;
      handler = null; clear();
      if (err) reject(err); else resolve();
    };
    const armStall = () => { if (stall) clearTimeout(stall); stall = setTimeout(() => finish(new PlaybackFailure("stalled")), stallMs); };
    const h = (type: string) => {
      if (my !== gen || type === "__stop") return finish();
      if (a.src !== u) return; // the unlock sound, or an earlier source still reporting
      switch (type) {
        case "playing":
          if (pauseT) { clearTimeout(pauseT); pauseT = null; }
          if (!started) { started = true; clearTimeout(startT); last = a.currentTime; onPlaying(); }
          armStall();
          break;
        case "timeupdate":
          if (started && a.currentTime !== last) {
            last = a.currentTime; armStall();
            const d = a.duration && Number.isFinite(a.duration) ? Math.min(1, a.currentTime / a.duration) : 0;
            setProgress((j.index + d) / j.chunks.length);
          }
          break;
        case "pause":
          if (!started || a.ended) break; // the pause that precedes `ended` is not an interruption
          if (stall) { clearTimeout(stall); stall = null; }
          if (pauseT) clearTimeout(pauseT);
          pauseT = setTimeout(() => { if (!a.ended) finish(new PlaybackFailure("interrupted")); }, pauseGraceMs);
          break;
        case "ended": finish(); break;
        case "emptied": if (started) finish(new PlaybackFailure("other")); break; // the source was taken away mid-playback
        case "error": finish(new PlaybackFailure(a.error?.code === 2 ? "network" : "decode")); break;
        default: break; // loadstart/canplay/stalled/waiting: the watchdogs decide
      }
    };
    const startT = setTimeout(() => finish(new PlaybackFailure("stalled")), startMs);
    handler = h;
    try {
      if (a.src !== u) a.src = u;
      const r = a.play();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e: unknown) => { if (handler === h) finish(playFailure(e)); });
    } catch (e) { finish(playFailure(e)); }
  });

  const fetchChunk = (j: Job, i: number) => { const p = deps.speak(j.chunks[i], j.ctl.signal); p.catch(() => {}); return p; };

  /** Plays `j` from chunk `from`: `first` is its audio (a URL already made, or the pending fetch); `next` the prefetch, if any. */
  const run = async (my: number, j: Job, from: number, first: Promise<Blob> | string, nextIn: Promise<Blob> | null = null): Promise<PlayResult> => {
    const a = element();
    let next: Promise<Blob> | null = nextIn;
    try {
      for (let i = from; i < j.chunks.length; i++) {
        let u: string;
        if (i === from && typeof first === "string") u = first;
        else {
          const pending = i === from ? (first as Promise<Blob>) : next ?? fetchChunk(j, i);
          next = null;
          const blob = await untilAborted(pending, j.ctl.signal);
          if (my !== gen) return "stopped";
          voiceAvailability.set("speak", "yes");
          u = url.create(blob); urls.push(u);
        }
        j.index = i; j.url = u;
        const prefetch = () => { if (!next && i + 1 < j.chunks.length) next = fetchChunk(j, i + 1); };
        await playOne(a, u, my, j, () => { if (my !== gen) return; set({ phase: "playing" }); prefetch(); }); // the next chunk is asked for while this one plays
        if (my !== gen) return "stopped";
        url.revoke(u); urls = urls.filter((x) => x !== u);
        if (i + 1 < j.chunks.length) { prefetch(); set({ phase: "preparing" }); }
      }
      job = null;
      setProgress(0);
      set({ ...IDLE });
      return "done";
    } catch (e) {
      if (my !== gen) return "stopped";
      const f = classify(e);
      const resumable = f.kind === "playback_blocked" || f.kind === "interrupted";
      if (resumable) suspended = { job: j, next }; // keep the audio (and the prefetch): a fresh tap continues without a new request
      else { j.ctl.abort(); urls.forEach((x) => url.revoke(x)); urls = []; job = null; setProgress(0); }
      if (f.kind === "unavailable") { if (isDurableVoiceFailure(f.reason)) voiceAvailability.set("speak", "no", f.reason); }
      const message = f.kind === "unavailable"
        ? (f.reason ? `صوت باشت غير متاح الآن. ${voiceReasonText(f.reason)}` : PLAYER_ERRORS.voice_unavailable)
        : PLAYER_ERRORS[f.code] ?? bashtErrorText(f.code);
      set({ id: j.id, phase: "error", error: message, code: f.code, errorKind: f.kind, errorReason: f.reason ?? "", canResume: resumable });
      return "error";
    }
  };

  return {
    getSnapshot: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    /** 0..1 through the reply being played (from the element's clock). */
    getProgress: () => progress,
    subscribeProgress(f: () => void) { progSubs.add(f); return () => { progSubs.delete(f); }; },
    /**
     * Call synchronously inside the tap that starts playback (listen, live start, long-press): a silent sound on the shared element
     * unlocks it on iOS for BASHT's voice later. Never interrupts a playback in progress (that element is already unlocked).
     */
    unlock() {
      try {
        const a = element();
        if (handler || state.phase === "playing") return;
        a.src = silentWav();
        const r = a.play();
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
      } catch { /* best effort */ }
    },
    /** Mutes BASHT's voice output (the reply still plays its course silently; the live session skips speaking instead). */
    setMuted(m: boolean) { muted = m; try { if (el) el.muted = m; } catch { /* ignore */ } },
    isMuted: () => muted,
    stop() { gen++; cleanup(); if (state.id || state.phase !== "idle") set({ ...IDLE }); },
    clearError() { if (state.phase === "error") { if (suspended) cleanup(); set({ ...IDLE }); } },
    /** Speaks `text` in BASHT's voice, chunk by chunk. `id` names what is playing (a reply bubble, or the live session). */
    play(id: string, text: string, opts: { onPhase?: (p: PlayerPhase) => void } = {}): Promise<PlayResult> {
      gen++; cleanup();
      const my = gen;
      const chunks = splitForSpeech(speakableText(text));
      if (!chunks.length) { set({ ...IDLE }); return Promise.resolve("done"); }
      const j: Job = { id, chunks, ctl: new AbortController(), index: 0, url: "", onPhase: opts.onPhase };
      job = j;
      set({ ...IDLE, id, phase: "preparing" });
      return run(my, j, 0, fetchChunk(j, 0));
    },
    /**
     * Continues a blocked/interrupted playback with the SAME audio (call inside the new tap). Never asks /speak again. Returns
     * "error" when there is nothing to continue.
     */
    resume(opts: { onPhase?: (p: PlayerPhase) => void } = {}): Promise<PlayResult> {
      const s = suspended;
      if (!s || state.phase !== "error") return Promise.resolve("error");
      suspended = null;
      gen++;
      const my = gen;
      if (opts.onPhase) s.job.onPhase = opts.onPhase;
      job = s.job;
      set({ ...IDLE, id: s.job.id, phase: "preparing" });
      return run(my, s.job, s.job.index, s.job.url, s.next);
    },
  };
}

function classify(e: unknown): { kind: PlayerErrorKind; code: string; reason?: VoiceReason } {
  if (e instanceof PlaybackFailure) return { kind: e.kind, code: e.kind === "other" ? "playback" : e.kind };
  if (e instanceof BashtError) {
    if (e.code === "voice_unavailable") return { kind: "unavailable", code: "voice_unavailable", reason: e.reason };
    if (e.code === "network") return { kind: "network", code: "network" };
    if (e.code === "timeout") return { kind: "network", code: "timeout" };
    if (e.code === "unauthorized") return { kind: "unauthorized", code: "unauthorized" };
    return { kind: "other", code: e.code };
  }
  return { kind: "other", code: "playback" };
}

export type VoicePlayer = ReturnType<typeof createVoicePlayer>;
let shared: VoicePlayer | null = null;
/** The ONE player of the app (one playback at a time, everywhere). Leaving the page stops it. */
export function voicePlayer(): VoicePlayer {
  if (shared) return shared;
  shared = createVoicePlayer({
    speak: (t, s) => bashtClient.speak(t, s),
    audio: () => { const a = new Audio(); a.preload = "auto"; return a as unknown as MediaLike; },
  });
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => shared?.stop());
  return shared;
}
export function usePlayer(): PlayerState {
  const p = voicePlayer();
  return useSyncExternalStore(p.subscribe, p.getSnapshot, () => IDLE);
}
export function usePlayerProgress(): number {
  const p = voicePlayer();
  return useSyncExternalStore(p.subscribeProgress, p.getProgress, () => 0);
}

// ── recording ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type RecordEnd = "stop" | "cancel" | "silence" | "no_speech" | "limit" | "error";
/** `handsFree`: the input level ended the turn by itself; false: the owner has to tap (no level probe). */
export type RecordResult = { audio: Blob | null; ended: RecordEnd; ms: number; handsFree?: boolean };
/** A turn the owner has to end with a tap (no level probe) is capped much lower than a voice note. */
export const MANUAL_TURN_MS = 60_000;
/** How long a stopped recorder may take to deliver `onstop` before the turn is ended without it. */
export const STOP_GUARD_MS = 2000;
type Rec = { stop: () => void; cancel: () => void };

/** The microphone's input level (0..~0.5 RMS) while a hands-free turn records — its own store, read by the level indicator only. */
let level = 0;
const levelSubs = new Set<() => void>();
export const inputLevel = {
  get: () => level,
  set(v: number) { const n = Math.max(0, Math.min(1, v)); if (Math.abs(n - level) > 0.002 || (n === 0 && level !== 0)) { level = n; levelSubs.forEach((f) => f()); } },
  subscribe(f: () => void) { levelSubs.add(f); return () => { levelSubs.delete(f); }; },
};
export const useInputLevel = () => useSyncExternalStore(inputLevel.subscribe, inputLevel.get, () => 0);

/** Creates/resumes the page's ONE audio context inside a tap (iOS keeps it suspended otherwise): the input-level probe. */
export const primeAudioInput = () => { primeAudioContext(); };
/** Drops the probe's audio context (the voice session ended). */
export const releaseAudioInput = () => { void closeAudioContext(); };

/**
 * After a microphone turn, before BASHT speaks (iOS): let the "stop" earcon finish and the OS leave the record route
 * ("play-and-record" plays quietly through the earpiece), park the probe graph, then ask for the "playback" session — for the
 * session's own token only, and only while that session is still live (`live()`): a session that ended (or moved on to the next
 * recording) is never switched to "playback" afterwards. A tested step of the live loop.
 */
export const AFTER_CAPTURE_MS = 350;
/**
 * `park: false` after a MANUAL turn: the owner's «أنهِ دورك» tap just (re)started the context inside a gesture; suspending it
 * here would undo that, and iOS may refuse to resume it outside a gesture — the next turn would lose its level probe again.
 */
export type SettleDeps = { suspend: () => Promise<void>; wait: (ms: number) => Promise<void>; enter: () => void; live?: () => boolean; park?: boolean };
export async function settleAfterCapture(d: SettleDeps): Promise<void> {
  const live = d.live ?? (() => true);
  await d.wait(AFTER_CAPTURE_MS);
  if (!live()) return;
  if (d.park !== false) { try { await d.suspend(); } catch { /* best effort (bounded: never waits forever) */ } }
  if (!live()) return;
  try { d.enter(); } catch { /* best effort */ }
}
/** The browser's settle step for the owner `token`. */
export const browserSettle = (token: () => VoiceToken | null, live: () => boolean, park = true) => settleAfterCapture({
  suspend: () => suspendAudioContext(), wait: (ms) => new Promise((r) => setTimeout(r, ms)), live, park,
  enter: () => { const t = token(); if (t) enterVoiceSession("playback", t); },
});
/** Before a microphone turn: the record-capable session (owner `token` only) and the probe's context running again (best effort). */
export async function prepareCapture(token: VoiceToken | null, live: () => boolean = () => true): Promise<void> {
  if (!live()) return;
  if (token) enterVoiceSession("play-and-record", token);
  await resumeAudioContext();
}

const micError = (e: unknown) => {
  const n = (e as { name?: string })?.name;
  return n === "NotAllowedError" || n === "SecurityError" ? "لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح."
    : n === "NotFoundError" || n === "OverconstrainedError" ? "لا يوجد ميكروفون متاح على هذا الجهاز."
      : n === "NotReadableError" ? "الميكروفون مشغول بتطبيق آخر (مكالمة؟). أغلقه ثم حاول." : "تعذّر بدء التسجيل.";
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
  onLevel?: (level: number) => void;
  now?: () => number;
};
export type RecordOpts = { maxMs?: number; silence?: boolean; onStart?: (handsFree: boolean) => void };
const failed = (ended: RecordEnd = "error"): RecordResult => ({ audio: null, ended, ms: 0 });
/** The ONE microphone owner of the app: a new recording (composer voice note or live session) cancels the one in progress, so two
 *  recordings never run at once and a hidden one can never capture (and later send) the live conversation. */
let activeRecording: Rec | null = null;
export const cancelActiveRecording = () => activeRecording?.cancel();

/**
 * One recording. The handle exists BEFORE the microphone permission is asked: a cancel (or stop, or unmount) while the permission
 * prompt is still open is remembered, and once the browser hands over the stream its tracks are stopped at once — nothing is
 * recorded, nothing is sent, the mic never stays on behind a closed screen. `onStart` fires only once MediaRecorder really started.
 */
export function startRecording(env: RecorderEnv, { maxMs = MAX_NOTE_MS, silence = false, onStart }: RecordOpts = {}): { handle: Rec; result: Promise<RecordResult> } {
  const now = env.now ?? Date.now;
  let early = false; // stop/cancel before recording started: nothing to keep
  let endNow: ((why: RecordEnd) => void) | null = null;
  const handle: Rec = { stop: () => (endNow ? endNow("stop") : (early = true)), cancel: () => (endNow ? endNow("cancel") : (early = true)) };
  activeRecording?.cancel();
  activeRecording = handle;
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

    return new Promise<RecordResult>((resolveOuter) => {
      const chunks: Blob[] = [];
      const started = now();
      let ended: RecordEnd = "stop";
      let done = false, guard: ReturnType<typeof setTimeout> | null = null;
      const resolve = (r: RecordResult) => { if (done) return; done = true; if (guard) clearTimeout(guard); resolveOuter(r); };
      // a recorder whose `onstop` never arrives must not keep the microphone (or the 60 s cap) hanging: after STOP_GUARD_MS the
      // tracks are released and the turn ends with nothing kept
      const end = (why: RecordEnd) => {
        ended = why;
        if (mr.state !== "inactive") try { mr.stop(); } catch { /* already stopping */ }
        guard ??= setTimeout(() => { if (done) return; finish(); env.onPhase("idle"); env.onElapsed(0); resolve({ audio: null, ended, ms: now() - started, handsFree }); }, STOP_GUARD_MS);
      };
      // hands-free: the input level decides when the owner has finished speaking (and drives the level indicator). Without a
      // level (no running audio context) the turn is a manual one: the owner taps, and it is capped at MANUAL_TURN_MS
      let probe: ReturnType<typeof setInterval> | null = null;
      const lvl = silence ? env.levelProbe?.(stream) ?? null : null;
      const handsFree = !!lvl;
      const cap = silence && !lvl ? Math.min(maxMs, MANUAL_TURN_MS) : maxMs;
      const tick = setInterval(() => { const ms = now() - started; env.onElapsed(ms); if (ms >= cap) end("limit"); }, 200);
      if (lvl) {
        const gate = createSilenceGate();
        probe = setInterval(() => { const v = lvl.read(); env.onLevel?.(v); const g = gate(v, now()); if (g === "stop") end("silence"); else if (g === "no_speech") end("no_speech"); }, 100);
      }
      const finish = () => { clearInterval(tick); if (probe) clearInterval(probe); try { lvl?.close(); } catch { /* gone */ } env.onLevel?.(0); release(); };
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        if (done) return;
        finish(); // the mic is released between turns (iOS plays BASHT's voice at full volume then)
        env.onPhase("idle"); env.onElapsed(0);
        const keep = ended !== "cancel" && ended !== "no_speech" && ended !== "error" && chunks.length > 0;
        resolve({ audio: keep ? new Blob(chunks, { type: mr.mimeType || type || "audio/webm" }) : null, ended, ms: now() - started, handsFree });
      };
      endNow = end;
      try { mr.start(1000); env.onPhase("recording"); onStart?.(handsFree); }
      catch { endNow = null; finish(); env.onPhase("idle"); env.onError("تعذّر بدء التسجيل."); resolve(failed()); }
    });
  })();
  void result.finally(() => { if (activeRecording === handle) activeRecording = null; });
  return { handle, result };
}

/** The browser's side of a recording: the real microphone, MediaRecorder and (when primed in a tap) the level probe. */
function browserRecorderEnv(set: Pick<RecorderEnv, "onPhase" | "onElapsed" | "onError">): RecorderEnv {
  return {
    ...set,
    onLevel: (v) => inputLevel.set(v),
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }), // the browser's own voice processing defaults
    pickType: () => pickRecorderType((t) => MediaRecorder.isTypeSupported?.(t) ?? false),
    createRecorder: (stream, type) => new MediaRecorder(stream as MediaStream, type ? { mimeType: type } : undefined) as unknown as RecorderLike,
    levelProbe: (stream) => {
      const ctx = audioContext();
      if (!ctx || ctx.state !== "running") return null;
      try {
        const source = ctx.createMediaStreamSource(stream as MediaStream);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        return {
          read: () => { analyser.getFloatTimeDomainData(buf); let sum = 0; for (const x of buf) sum += x * x; return Math.sqrt(sum / buf.length); },
          close: () => { try { source.disconnect(); } catch { /* gone */ } try { analyser.disconnect(); } catch { /* gone */ } }, // one graph per turn, torn down with it
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
  const lastError = useRef("");
  const setErr = useCallback((m: string) => { lastError.current = m; setError(m); }, []);
  // leaving the screen cancels a recording — also one still waiting for the microphone permission
  useEffect(() => { setSupported(recorderSupported()); return () => rec.current?.cancel(); }, []);

  const record = useCallback(async (opts: RecordOpts = {}): Promise<RecordResult> => {
    rec.current?.cancel(); // never two recordings: a newer one replaces (and cancels) an older one
    rec.current = null;
    const mine: { handle: Rec | null } = { handle: null };
    const only = <T,>(f: (v: T) => void) => (v: T) => { if (rec.current === mine.handle) f(v); }; // a cancelled one no longer drives the UI
    const { handle, result } = startRecording(browserRecorderEnv({ onPhase: only(setPhase), onElapsed: only(setElapsed), onError: only(setErr) }), opts);
    mine.handle = handle;
    rec.current = handle;
    try { return await result; } finally { if (rec.current === handle) { rec.current = null; setPhase("idle"); } }
  }, [setErr]);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => rec.current?.cancel(), []);
  return { supported, phase, recording: phase === "recording", starting: phase === "starting", elapsed, error, clearError: () => setErr(""),
    /** the latest error, read synchronously (React state may not have re-rendered yet when a turn ends) */
    errorNow: () => lastError.current, record, stop, cancel };
}

// ── the live voice session (V4): a SEQUENTIAL turn loop — listen → transcribe → ask BASHT → speak → listen again ────────────
/**
 * Not a real-time call: one side speaks at a time. Every phase reflects real activity —
 *  starting  : the microphone is being opened (no "listening" yet)
 *  listening : MediaRecorder really started
 *  muted     : the owner muted the microphone; the loop waits for unmute (nothing is recorded)
 *  thinking  : transcribing · sending/waiting for BASHT's reply · fetching BASHT's voice ("يجهّز الصوت…")
 *  speaking  : ONLY once the audio element fired `playing`
 *  blocked   : the browser refused to play (or the OS interrupted it): one tap continues the SAME audio (no new /speak request)
 */
export type LivePhase = "idle" | "starting" | "listening" | "muted" | "thinking" | "speaking" | "blocked";
/** listening/"manual": no input level here — the owner ends the turn with «أنهِ دورك» (capped at 60 s) */
export type LiveStep = "" | "transcribing" | "waiting" | "voice" | "manual";
export type LiveDeps = {
  /** records one turn; `onStarted` fires once the recorder really runs (`handsFree`: a pause ends the turn by itself) */
  record: (onStarted: (handsFree: boolean) => void) => Promise<RecordResult>;
  cancelRecord: () => void;
  /** aborted when the session ends (no upload keeps running behind a closed screen) */
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  /** sends one owner turn (already marked as a voice note) and resolves with BASHT's finished reply */
  ask: (text: string) => Promise<string>;
  /** speaks the reply; `onPlayer` reports the player's real phases (preparing / playing) */
  play: (text: string, onPlayer: (p: PlayerPhase) => void) => Promise<PlayResult>;
  stopPlay: () => void;
  /** a failed playback can continue with a fresh tap (blocked autoplay / OS interruption) */
  canResume?: () => boolean;
  /** continues it — called synchronously inside that tap */
  resume?: (onPlayer: (p: PlayerPhase) => void) => Promise<PlayResult>;
  playError: () => string;
  recordError: () => string;
  /** before each microphone turn (record-capable audio session, probe context running); skip when `live()` is false */
  beforeCapture?: (live: () => boolean) => Promise<void> | void;
  /** after a microphone turn, before speaking (settleAfterCapture) — overlaps the transcription; skip when `live()` is false */
  afterCapture?: (live: () => boolean, turn: { handsFree: boolean }) => Promise<void>;
  onPhase: (p: LivePhase, step: LiveStep) => void;
  onHeard: (text: string) => void;
  onReply?: (text: string) => void;
  onError: (msg: string) => void;
  /** the session is over (ended by the owner, an error, or silence) — release the audio session / context */
  onEnd?: () => void;
  /** an earcon; returns true when one was played (the start cue then finishes before the mic opens) */
  cue?: (kind: "start" | "stop") => boolean | void;
  wait?: (ms: number) => Promise<void>;
};
/** How long an earcon lasts (two short notes). */
export const EARCON_MS = 350;
export const MANUAL_LIMIT_TEXT = "انتهى الحد (60 ثانية) دون الضغط على «أنهِ دورك»، فأنهيت الجلسة ولم يُرسل شيء.";
export const NO_SPEECH_TEXT = "لم أسمع كلامًا، فأنهيت الجلسة. اضغط «ابدأ المحادثة» للبدء من جديد.";

const errText = (e: unknown, fallback: string) =>
  e instanceof BashtError && e.code === "voice_unavailable" && e.reason ? `${bashtErrorText(e.code)} ${voiceReasonText(e.reason)}`
    : e instanceof Error && e.message ? e.message : fallback;

/**
 * Each start() opens a NEW session (a generation token). Every await is followed by a check that this session is still the current
 * one, so a session that was ended — even one restarted right away — never sends its old transcript, never speaks its old reply over
 * the new recording, never reports its errors into the new session and never starts another recorder.
 */
export function createLiveSession(d: LiveDeps) {
  let gen = 0;
  let phase: LivePhase = "idle";
  let micMuted = false, speakerMuted = false, muteCancel = false, hidden = false;
  let wake: (() => void) | null = null;
  let resumeReq: ((p: Promise<PlayResult> | null) => void) | null = null;
  let onPlayerNow: ((p: PlayerPhase) => void) | null = null;
  let turn: AbortController | null = null;
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const to = (p: LivePhase, step: LiveStep = "") => { phase = p; d.onPhase(p, step); };
  /** stops everything of the current session (no onEnd: used by start() inside the owner's gesture) */
  const halt = () => {
    gen++; muteCancel = false; d.cancelRecord(); d.stopPlay(); turn?.abort(); turn = null;
    wake?.(); wake = null; resumeReq?.(null); resumeReq = null; onPlayerNow = null;
    if (phase !== "idle") to("idle");
  };
  const end = (msg = "") => { const was = phase !== "idle"; halt(); if (msg) d.onError(msg); if (was || msg) d.onEnd?.(); };

  async function run(my: number) {
    const live = () => my === gen;
    const fail = (msg: string) => { if (live()) end(msg); };
    let quiet = 0;
    let settled: Promise<void> = Promise.resolve();
    while (live()) {
      await settled; // the previous turn's route switch is over before the next one asks for the microphone
      if (!live()) return;
      if (micMuted || hidden) {
        if (micMuted) to("muted"); // (hidden: nobody sees the screen; it waits for visible or ends after the grace period)
        await new Promise<void>((r) => { wake = r; });
        if (!live()) return;
        continue;
      }
      // every await before the microphone opens is re-validated: the session may have ended, or the owner muted the mic meanwhile
      // (a mute before any recorder exists has nothing to cancel — it must stop the recorder from ever starting)
      const mayRecord = () => live() && !micMuted && !hidden;
      await d.beforeCapture?.(live);
      if (!live()) return;
      if (!mayRecord()) { muteCancel = false; continue; }
      to("starting");
      // the start cue plays BEFORE the microphone opens (never into the recording)
      if (d.cue?.("start")) { await wait(EARCON_MS); if (!live()) return; }
      if (!mayRecord()) { muteCancel = false; continue; }
      const r = await d.record((handsFree) => { if (live() && phase === "starting") to("listening", handsFree ? "" : "manual"); });
      if (!live()) return;
      if (r.ended === "limit" && r.handsFree === false) return fail(MANUAL_LIMIT_TEXT); // nobody tapped: never send a minute of noise
      if (!r.audio) {
        if (r.ended === "cancel" && muteCancel) { muteCancel = false; continue; } // muted while listening: nothing kept, wait
        if (r.ended === "no_speech" && ++quiet < 2) continue; // one quiet turn is forgiven; two end the session
        return fail(r.ended === "no_speech" ? NO_SPEECH_TEXT : d.recordError() || "توقّف الاستماع.");
      }
      d.cue?.("stop");
      settled = (d.afterCapture?.(live, { handsFree: r.handsFree !== false }) ?? Promise.resolve()).catch(() => {}); // the route switch overlaps the transcription
      to("thinking", "transcribing");
      let text: string;
      turn = new AbortController();
      try { text = await d.transcribe(r.audio, turn.signal); }
      catch (e) {
        if (!live()) return;
        // the engine heard nothing either: it counts as a quiet turn (steady noise never loops billed transcriptions)
        if (e instanceof BashtError && e.code === "no_speech") { if (++quiet < 2) continue; return fail(NO_SPEECH_TEXT); }
        return fail(errText(e, "تعذّر تفريغ الصوت."));
      }
      quiet = 0;
      if (!live()) return;
      d.onHeard(text);
      to("thinking", "waiting");
      let reply: string;
      try { reply = await d.ask(voiceNoteText(text)); }
      catch (e) { if (!live()) return; return fail(errText(e, "تعذّر الإرسال إلى باشت.")); }
      if (!live()) return;
      d.onReply?.(reply);
      if (speakerMuted) continue; // the owner muted BASHT's voice: the reply stays text, no voice is requested
      to("thinking", "voice");
      await settled;
      if (!live()) return;
      if (speakerMuted || hidden) continue; // muted (or backgrounded) while the route was settling: still no voice is requested (the reply is shown as text)
      const onPlayer = (p: PlayerPhase) => {
        if (!live()) return;
        if (p === "playing") to("speaking");
        else if (p === "preparing" && phase !== "thinking") to("thinking", "voice");
      };
      onPlayerNow = onPlayer;
      let played = await d.play(reply, onPlayer);
      while (live() && played === "error" && d.canResume?.() && d.resume) {
        to("blocked"); // waits for the owner's tap (resumePlayback) — never retried on its own
        const again = await new Promise<Promise<PlayResult> | null>((r) => { resumeReq = r; });
        if (!again || !live()) return;
        played = await again;
      }
      onPlayerNow = null;
      if (!live()) return;
      if (played === "error") return fail(d.playError() || "تعذّر تشغيل صوت باشت.");
      // "stopped": the owner interrupted BASHT — listen again
    }
  }
  return {
    /** Starts a new session (ending any previous one first). Call inside the owner's tap. */
    start() {
      halt(); // a previous session (if any) is over: its recorder and playback stop, its pending awaits are now stale
      d.onError(""); d.onHeard("");
      hidden = false;
      const my = ++gen;
      to("starting"); // synchronously: a hidden event right after the tap already sees a running session
      void run(my).catch(() => { if (my === gen) end("تعذّر إكمال الجلسة الصوتية."); });
    },
    end,
    /** Stop BASHT speaking (or fetching its voice) now and listen again. */
    interrupt() { if (phase === "speaking" || phase === "thinking") d.stopPlay(); },
    /** Mute the microphone: a turn being recorded is discarded and the loop waits; unmuting (a tap) listens again. */
    setMicMuted(m: boolean) {
      micMuted = m;
      if (m && (phase === "listening" || phase === "starting")) { muteCancel = true; d.cancelRecord(); }
      if (!m) { const w = wake; wake = null; w?.(); }
    },
    /** Mute BASHT's voice: replies stay text (no voice requested); a reply being spoken stops. */
    setSpeakerMuted(m: boolean) {
      speakerMuted = m;
      if (!m) return;
      if (phase === "speaking" || phase === "thinking") d.stopPlay();
      if (phase === "blocked" && resumeReq) { const r = resumeReq; resumeReq = null; d.stopPlay(); r(Promise.resolve("stopped")); } // no tap-to-play left waiting
    },
    /**
     * The page went to the background (true) or came back (false). Hidden: the recording in progress is discarded (never sent),
     * BASHT stops speaking, and no new recording starts until visible again. Ending the session is the caller's (after a grace).
     */
    setHidden(h: boolean) {
      hidden = h;
      if (h) {
        if (phase === "listening" || phase === "starting") { muteCancel = true; d.cancelRecord(); }
        if (phase === "speaking" || phase === "thinking") d.stopPlay();
        if (phase === "blocked" && resumeReq) { const r = resumeReq; resumeReq = null; d.stopPlay(); r(Promise.resolve("stopped")); }
      } else { const w = wake; wake = null; w?.(); }
    },
    /** Continues a blocked reply with the same audio. Call synchronously inside the owner's tap. */
    resumePlayback() {
      if (phase !== "blocked" || !resumeReq || !d.resume || !onPlayerNow) return;
      const r = resumeReq; resumeReq = null;
      to("thinking", "voice");
      r(d.resume(onPlayerNow));
    },
    phase: () => phase,
  };
}

/** A target for DOM events (document / window, or fakes in tests). */
type EventHost = { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
export const BACKGROUND_TEXT = "توقّفت المحادثة الصوتية لأن التطبيق بقي في الخلفية. لم يُرسل الدور غير المكتمل.";
export const BACKGROUND_GRACE_MS = 3000;
/**
 * Backgrounding (lock screen, app switch, Control Center): on `hidden` the current recording is discarded and playback stops AT
 * ONCE (`onHide`) — but the session ENDS only if it stays hidden for 3 s (`onEnd`), or on `pagehide`. A glance at the app
 * switcher or Control Center comes back to a live session (`onShow`). `ignoreHide()` true (e.g. the microphone permission prompt
 * is open, phase "starting") ignores a hidden event. Returns the unbind function.
 */
export function watchBackground(h: { onHide: () => void; onShow: () => void; onEnd: () => void; ignoreHide?: () => boolean },
  env: { doc: EventHost & { visibilityState: string }; win: EventHost } | null =
  typeof document !== "undefined" && typeof window !== "undefined" ? { doc: document, win: window } : null,
  graceMs = BACKGROUND_GRACE_MS): () => void {
  if (!env) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null, hidden = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const vis = () => {
    if (env.doc.visibilityState === "hidden") {
      if (hidden || h.ignoreHide?.()) return;
      hidden = true; h.onHide();
      timer = setTimeout(() => { timer = null; h.onEnd(); }, graceMs);
    } else if (hidden) { hidden = false; clear(); h.onShow(); }
  };
  const gone = () => { clear(); hidden = false; h.onEnd(); };
  env.doc.addEventListener("visibilitychange", vis);
  env.win.addEventListener("pagehide", gone);
  return () => { clear(); env.doc.removeEventListener("visibilitychange", vis); env.win.removeEventListener("pagehide", gone); };
}

// ── a voice note from the composer: transcribe → send (or keep the text) ──────────────────────────────────────────────────
export type NoteDeps = {
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  /** read at the moment of sending (never a value captured when the note started) */
  canSend: () => boolean;
  send: (text: string) => Promise<unknown>;
  setDraft: (text: string) => void;
  setNotice: (msg: string) => void;
  setBusy: (busy: boolean) => void;
  onError?: (e: unknown) => void;
  onLimit?: () => void;
};
export type NoteOutcome = "sent" | "kept" | "failed" | "cancelled";

/**
 * Each voice note is one operation with its own token. Resetting the composer (switching conversations) or leaving the screen
 * cancels it: the upload is aborted, and when the transcription comes back anyway nothing is sent, no draft or notice is
 * written into the conversation now on screen.
 */
export function createVoiceNotes(d: NoteDeps) {
  let gen = 0, ctl: AbortController | null = null;
  const cancel = () => { gen++; ctl?.abort(); ctl = null; d.setBusy(false); };
  async function run(audio: Blob, ended: RecordEnd = "stop"): Promise<NoteOutcome> {
    cancel();
    const my = gen, c = new AbortController(); ctl = c;
    const live = () => my === gen;
    d.setBusy(true);
    try {
      let text: string;
      try { text = await d.transcribe(audio, c.signal); }
      catch (e) {
        if (!live()) return "cancelled";
        d.onError?.(e);
        d.setNotice(e instanceof BashtError && e.code === "voice_unavailable"
          ? "تفريغ الصوت غير مفعّل في محرك باشت الآن، فلم تُرسل رسالتك الصوتية. صار زر الميكروفون للإملاء."
          : (e instanceof Error ? e.message : "تعذّر تفريغ الرسالة الصوتية.") + " لم تُرسل رسالتك الصوتية.");
        return "failed";
      }
      if (!live()) return "cancelled";
      if (!d.canSend()) { d.setDraft(text); d.setNotice("باشت غير متاح الآن، فلم تُرسل رسالتك الصوتية. وضعتُ نصها في مربع الكتابة."); return "kept"; }
      try { await d.send(voiceNoteText(text)); if (ended === "limit" && live()) d.onLimit?.(); return "sent"; }
      catch (e) {
        if (!live()) return "cancelled";
        d.onError?.(e);
        d.setDraft(text); d.setNotice((e instanceof Error ? e.message : "تعذّر الإرسال إلى باشت.") + " وضعتُ نص رسالتك الصوتية في مربع الكتابة.");
        return "kept";
      }
    } finally { if (live()) { ctl = null; d.setBusy(false); } }
  }
  return { run, cancel };
}
