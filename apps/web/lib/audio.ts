/**
 * In-app audio. Plays the four tones with HTMLAudioElement.
 *  - Respects the iPhone silent switch: `navigator.audioSession.type = "ambient"` (Safari 16.4+) makes
 *    page audio obey the ringer switch and mix with other audio. Where unsupported, we say so honestly.
 *  - Never forces sound: if the platform's autoplay policy blocks `play()` (no user interaction yet) the
 *    result is "blocked" and the UI falls back to a visible alert plus a "tap to enable sound" prompt.
 *  - Muted (settings) → "muted" and nothing is played. Quiet hours are decided by the caller.
 *  Everything is injectable so it can be unit-tested without a browser.
 */
import { soundDef, type SoundId } from "./sounds";

export type PlayResult = "played" | "blocked" | "error" | "muted" | "unsupported";
export type AudioLike = {
  src: string; volume: number; preload: string; currentTime: number;
  play: () => Promise<void> | void; pause: () => void;
  addEventListener?: (t: string, cb: () => void, o?: unknown) => void;
};
export type AudioDeps = {
  create?: (src: string) => AudioLike;
  session?: { type: string } | null;
  userActivated?: () => boolean;
  emit?: (id: SoundId, result: PlayResult) => void;
};

export function createAudioPlayer(deps: AudioDeps = {}) {
  const create = deps.create ?? ((src: string) => {
    const a = new Audio(src); a.preload = "auto"; return a as unknown as AudioLike;
  });
  const session = () => (deps.session !== undefined ? deps.session : (typeof navigator !== "undefined" ? (navigator as unknown as { audioSession?: { type: string } }).audioSession ?? null : null));
  const activated = deps.userActivated ?? (() => typeof navigator === "undefined" ? false : ((navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true));
  const emit = deps.emit ?? ((id, result) => { if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") window.dispatchEvent(new CustomEvent("safwan:sound", { detail: { id, result } })); });
  const cache = new Map<SoundId, AudioLike>();
  let current: AudioLike | null = null;
  let sessionSet = false;

  const ensureSession = () => {
    const s = session();
    if (!s || sessionSet) return !!s;
    try { s.type = "ambient"; sessionSet = true; } catch { /* unsupported value */ }
    return sessionSet;
  };

  return {
    /** true when the browser can route page audio through the silent switch */
    respectsSilentSwitch: () => { try { return ensureSession(); } catch { return false; } },
    canAutoplay: () => activated(),
    preload(ids: SoundId[]) { for (const id of ids) if (!cache.has(id)) { try { cache.set(id, create(soundDef(id).file)); } catch { /* ignore */ } } },
    stop() { try { current?.pause(); if (current) current.currentTime = 0; } catch { /* ignore */ } current = null; },
    async play(id: SoundId, opts: { volume: number; muted?: boolean }): Promise<PlayResult> {
      const done = (r: PlayResult) => { emit(id, r); return r; };
      if (opts.muted) return done("muted");
      if (opts.volume <= 0) return done("muted");
      let a = cache.get(id);
      try {
        ensureSession();
        if (!a) { a = create(soundDef(id).file); cache.set(id, a); }
        this.stop();
        a.currentTime = 0; a.volume = Math.min(1, Math.max(0, opts.volume));
        current = a;
        await a.play();
        return done("played");
      } catch (e) {
        const name = (e as { name?: string })?.name;
        return done(name === "NotAllowedError" ? "blocked" : name === "NotSupportedError" ? "unsupported" : "error");
      }
    },
  };
}
export type AudioPlayer = ReturnType<typeof createAudioPlayer>;
let shared: AudioPlayer | null = null;
export const audioPlayer = (): AudioPlayer => (shared ??= createAudioPlayer());
