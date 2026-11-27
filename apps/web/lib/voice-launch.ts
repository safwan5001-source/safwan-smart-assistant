"use client";
/**
 * Opening the voice conversation from a gesture elsewhere (long-press on the BASHT tab, Shift+Enter on it).
 *
 * The gesture itself does what iOS only allows inside a gesture — the voice audio session, the playback unlock, the input probe —
 * and leaves a short-lived marker. The voice screen starts listening on its own ONLY when that marker is fresh: a reload or a
 * bookmarked `?autostart=1` never records without a new press; it shows the «ابدأ المحادثة» button instead.
 */
import { enterVoiceSession } from "./audio";
import { primeAudioInput, voicePlayer } from "./basht-voice";

export const OPEN_VOICE_EVENT = "safwan:open-voice";
export const VOICE_AUTOSTART_MS = 10_000;
export const VOICE_URL = "/chat?voice=1&autostart=1";
/** Spoken on the BASHT tab: the long-press (and its keyboard equivalent) that opens the voice conversation. */
export const TAB_VOICE_HINT = "اضغط مطولًا لبدء محادثة صوتية بالتناوب، أو Shift+Enter من لوحة المفاتيح";

let pressedAt = 0;

export type GestureDeps = { enter: () => void; unlock: () => void; prime: () => void; now?: () => number };
const browserDeps = (): GestureDeps => ({ enter: () => { enterVoiceSession("play-and-record"); }, unlock: () => voicePlayer().unlock(), prime: primeAudioInput });

/** Call SYNCHRONOUSLY inside the activating gesture (pointerup / keydown), before navigating. Never throws. */
export function primeVoiceFromGesture(d: GestureDeps = browserDeps()) {
  for (const step of [d.enter, d.unlock, d.prime]) { try { step(); } catch { /* best effort: the screen falls back to its start button */ } }
  pressedAt = (d.now ?? Date.now)();
}
/** True once per fresh gesture (≤ 10 s old): the voice screen may start listening by itself. */
export function takeVoiceAutostart(now: number = Date.now()): boolean {
  const ok = pressedAt > 0 && now - pressedAt >= 0 && now - pressedAt <= VOICE_AUTOSTART_MS;
  pressedAt = 0;
  return ok;
}
/** Peek without consuming (the screen is not ready to start yet). */
export const voiceAutostartPending = (now: number = Date.now()) => pressedAt > 0 && now - pressedAt <= VOICE_AUTOSTART_MS;
