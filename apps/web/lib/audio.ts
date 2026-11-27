/**
 * In-app audio: the four notification tones (HTMLAudioElement) and the page's iOS audio-session policy.
 *
 * Audio-session policy (navigator.audioSession, Safari 16.4+; feature-detected, never throws):
 *  - Tones are short, optional cues: ONLY while one plays the session is "ambient" (they follow the silent switch and mix with
 *    other audio), then the previous type is restored. The page is never left in "ambient": that made BASHT's voice obey the
 *    silent switch — play() resolved and `ended` fired while nothing was audible.
 *  - BASHT's voice (listen, live session, long-press) calls `enterVoiceSession()` inside the user's gesture: "playback" while it
 *    speaks (loud, through the speaker, regardless of the silent switch — the owner asked for it), "play-and-record" while the
 *    microphone is in use. `leaveVoiceSession()` restores "auto". A tone during a voice session plays under the voice session
 *    and never changes it.
 *  - Tones never force sound: if the platform's autoplay policy blocks `play()` (no user interaction yet) the result is
 *    "blocked" and the UI falls back to a visible alert plus a "tap to enable sound" prompt. Muted → "muted", nothing played.
 *  Everything is injectable so it can be unit-tested without a browser.
 */
import { soundDef, type SoundId } from "./sounds";

// ── the audio session ─────────────────────────────────────────────────────────────────────────────────────────────────
export type SessionLike = { type: string };
export type VoiceSessionKind = "playback" | "play-and-record";

const browserSession = (): SessionLike | null => {
  try { return typeof navigator !== "undefined" ? (navigator as unknown as { audioSession?: SessionLike }).audioSession ?? null : null; }
  catch { return null; }
};

/**
 * Who holds BASHT's voice session. Each `enterVoice()` without a token makes a NEW owner (the previous one is superseded);
 * passing the owner's own token only changes the kind. `leaveVoice(token)` acts only for the current owner, so a «استمع» reply
 * ending after the live session took over can never drop the live session's "play-and-record".
 */
export type VoiceToken = { readonly id: number; readonly ok: boolean };

/** One owner of the page's audio-session type. `get` returns the platform object (null where the API does not exist). */
export function createAudioSession(get: () => SessionLike | null = browserSession) {
  let tones = 0;
  let saved: string | null = null;
  let voice: VoiceSessionKind | null = null;
  let owner = 0, seq = 0;
  const api = () => { try { return get(); } catch { return null; } };
  const setType = (t: string): boolean => {
    const s = api();
    if (!s) return false;
    try { if (s.type !== t) s.type = t; return s.type === t; } catch { return false; }
  };
  const beginTone = (): (() => void) => {
    const s = api();
    if (!s || voice) return () => {}; // no API, or the voice session owns it: the tone plays under it
    if (tones++ === 0) { try { saved = s.type; } catch { saved = "auto"; } setType("ambient"); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      tones = Math.max(0, tones - 1);
      if (tones === 0) { if (!voice) setType(saved ?? "auto"); saved = null; }
    };
  };
  return {
    /** true when the browser exposes the audio-session API (tones then follow the silent switch). */
    supported: () => api() !== null,
    current: (): string | null => { try { return api()?.type ?? null; } catch { return null; } },
    voiceKind: () => voice,
    /** true while some voice experience owns the session (alert tones stay quiet then) */
    voiceActive: () => voice !== null,
    isOwner: (t: VoiceToken | null | undefined) => !!t && t.id === owner && voice !== null,
    /** "ambient" for one tone; the returned function restores the previous type (idempotent). */
    beginTone,
    async withTone<T>(fn: () => Promise<T> | T): Promise<T> { const release = beginTone(); try { return await fn(); } finally { release(); } },
    /**
     * BASHT's voice: "playback" (speaker, loud) or "play-and-record" (microphone). Without `token`: a new owner. With the current
     * owner's token: the kind changes. With a superseded/released token: nothing changes (`ok: false`).
     */
    enterVoice(kind: VoiceSessionKind = "playback", token?: VoiceToken | null): VoiceToken {
      if (token) {
        if (token.id !== owner || voice === null) return { id: token.id, ok: false };
        voice = kind;
        return { id: owner, ok: setType(kind) };
      }
      owner = ++seq; voice = kind;
      return { id: owner, ok: setType(kind) };
    },
    /** Ends the voice session — only for its current owner: back to "auto" (or "ambient" if a tone is still playing). */
    leaveVoice(token: VoiceToken | null | undefined): void {
      if (!token || token.id !== owner || !voice) return;
      voice = null; owner = 0;
      if (tones > 0) setType("ambient"); else setType("auto");
    },
  };
}
export type AudioSession = ReturnType<typeof createAudioSession>;
let sharedSession: AudioSession | null = null;
export const audioSession = (): AudioSession => (sharedSession ??= createAudioSession());

/** Runs `fn` (a short tone) with the session "ambient", then restores the previous type. Never throws because of the session. */
export const withToneSession = <T,>(fn: () => Promise<T> | T): Promise<T> => audioSession().withTone(fn);
const NO_TOKEN: VoiceToken = { id: -1, ok: false };
/**
 * Call inside the gesture that starts BASHT's voice (listen, live start, long-press), before unlocking playback. Returns the
 * owner token; pass it back to change the kind (`enterVoiceSession(kind, token)`) and to `leaveVoiceSession(token)`.
 */
export const enterVoiceSession = (kind: VoiceSessionKind = "playback", token?: VoiceToken | null): VoiceToken => {
  try { return audioSession().enterVoice(kind, token); } catch { return NO_TOKEN; }
};
/** Call when that voice experience ends. A superseded token does nothing. */
export const leaveVoiceSession = (token: VoiceToken | null | undefined): void => { try { audioSession().leaveVoice(token); } catch { /* best effort */ } };
/** Whether a voice experience owns the audio session right now. */
export const voiceSessionActive = (): boolean => { try { return audioSession().voiceActive(); } catch { return false; } };

// ── notification tones ────────────────────────────────────────────────────────────────────────────────────────────────
export type PlayResult = "played" | "blocked" | "error" | "muted" | "unsupported";
export type AudioLike = {
  src: string; volume: number; preload: string; currentTime: number;
  play: () => Promise<void> | void; pause: () => void;
  addEventListener?: (t: string, cb: () => void, o?: unknown) => void;
  removeEventListener?: (t: string, cb: () => void) => void;
};
export type AudioDeps = {
  create?: (src: string) => AudioLike;
  /** the platform audio-session object (tests); omitted: the page's shared session owner */
  session?: SessionLike | null;
  userActivated?: () => boolean;
  emit?: (id: SoundId, result: PlayResult) => void;
  /** longest a tone may hold the "ambient" session when its `ended` never arrives */
  holdMs?: number;
};

export function createAudioPlayer(deps: AudioDeps = {}) {
  const create = deps.create ?? ((src: string) => {
    const a = new Audio(src); a.preload = "auto"; return a as unknown as AudioLike;
  });
  const sessions = deps.session !== undefined ? createAudioSession(() => deps.session ?? null) : audioSession();
  const activated = deps.userActivated ?? (() => typeof navigator === "undefined" ? false : ((navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true));
  const emit = deps.emit ?? ((id, result) => { if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") window.dispatchEvent(new CustomEvent("safwan:sound", { detail: { id, result } })); });
  const holdMs = deps.holdMs ?? 6000;
  const cache = new Map<SoundId, AudioLike>();
  let current: AudioLike | null = null;
  let releaseCurrent: (() => void) | null = null;

  /** Keeps the tone session until the tone really ends (ended/pause/error), or `holdMs` at most. */
  const holdUntilEnd = (a: AudioLike, release: () => void) => {
    let done = false;
    const events = ["ended", "pause", "error"];
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      for (const t of events) { try { a.removeEventListener?.(t, finish); } catch { /* ignore */ } }
      if (releaseCurrent === finish) releaseCurrent = null;
      release();
    };
    const timer = setTimeout(finish, holdMs);
    for (const t of events) { try { a.addEventListener?.(t, finish, { once: true }); } catch { /* ignore */ } }
    releaseCurrent = finish;
  };

  return {
    /** true when the browser can route these tones through the silent switch (the audio-session API exists). */
    respectsSilentSwitch: () => { try { return sessions.supported(); } catch { return false; } },
    canAutoplay: () => activated(),
    preload(ids: SoundId[]) { for (const id of ids) if (!cache.has(id)) { try { cache.set(id, create(soundDef(id).file)); } catch { /* ignore */ } } },
    stop() { try { current?.pause(); if (current) current.currentTime = 0; } catch { /* ignore */ } current = null; releaseCurrent?.(); },
    async play(id: SoundId, opts: { volume: number; muted?: boolean }): Promise<PlayResult> {
      const done = (r: PlayResult) => { emit(id, r); return r; };
      if (opts.muted) return done("muted");
      if (opts.volume <= 0) return done("muted");
      let a = cache.get(id);
      this.stop();
      const release = sessions.beginTone(); // "ambient" for this tone only
      try {
        if (!a) { a = create(soundDef(id).file); cache.set(id, a); }
        a.currentTime = 0; a.volume = Math.min(1, Math.max(0, opts.volume));
        current = a;
        await a.play();
        holdUntilEnd(a, release);
        return done("played");
      } catch (e) {
        release();
        const name = (e as { name?: string })?.name;
        return done(name === "NotAllowedError" ? "blocked" : name === "NotSupportedError" ? "unsupported" : "error");
      }
    },
  };
}
export type AudioPlayer = ReturnType<typeof createAudioPlayer>;
let shared: AudioPlayer | null = null;
export const audioPlayer = (): AudioPlayer => (shared ??= createAudioPlayer());
