"use client";
/**
 * Opening the voice conversation from a gesture elsewhere (long-press on the BASHT tab, Shift+Enter on it, the wave button).
 *
 * The gesture itself does what iOS only allows inside a gesture — the voice audio session, the playback unlock, the input probe —
 * and leaves a short-lived PRESS (its audio-session owner token + a deadline). The voice screen starts listening on its own ONLY
 * by claiming a fresh press: a reload or a bookmarked `?autostart=1` never records without a new press; it shows the «ابدأ
 * المحادثة» button instead. A press nobody claims by the deadline (a redirect to sign-in, the screen never mounted, the dictation
 * fallback shown instead) is released: the audio session goes back to "auto" and the probe's context is closed.
 */
import { enterVoiceSession, leaveVoiceSession, type VoiceToken } from "./audio";
import { closeAudioContext } from "./audio-context";
import { primeAudioInput, voicePlayer } from "./basht-voice";

export const OPEN_VOICE_EVENT = "safwan:open-voice";
export const VOICE_AUTOSTART_MS = 10_000;
export const VOICE_URL = "/chat?voice=1&autostart=1";
/** Spoken on the BASHT tab: the long-press (and its keyboard equivalent) that opens the voice conversation. */
export const TAB_VOICE_HINT = "اضغط مطولًا لبدء محادثة صوتية بالتناوب، أو Shift+Enter من لوحة المفاتيح";

export type GestureDeps = {
  enter: () => VoiceToken | void; unlock: () => void; prime: () => void;
  /** what an unclaimed press gives back at its deadline */
  leave?: (t: VoiceToken | null) => void; close?: () => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void;
};
const browserDeps = (): GestureDeps => ({
  enter: () => enterVoiceSession("play-and-record"), unlock: () => voicePlayer().unlock(), prime: primeAudioInput,
  leave: (t) => leaveVoiceSession(t), close: () => { void closeAudioContext(); },
});

type Press = { at: number; token: VoiceToken | null; timer: unknown; clear: (h: unknown) => void; release: () => void };
let press: Press | null = null;

/** Call SYNCHRONOUSLY inside the activating gesture (pointerup / keydown / click), before navigating. Never throws. */
export function primeVoiceFromGesture(d: GestureDeps = browserDeps()) {
  releaseVoicePress(); // an older unclaimed press is over
  let token: VoiceToken | null = null;
  try { token = d.enter() || null; } catch { /* best effort */ }
  for (const step of [d.unlock, d.prime]) { try { step(); } catch { /* best effort: the screen falls back to its start button */ } }
  const now = (d.now ?? Date.now)();
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clear = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const p: Press = {
    at: now, token, clear, timer: null,
    release: () => { try { d.leave?.(token); } catch { /* ignore */ } try { d.close?.(); } catch { /* ignore */ } },
  };
  p.timer = setTimer(() => { if (press === p) { press = null; p.release(); } }, VOICE_AUTOSTART_MS);
  press = p;
}
/**
 * Claims a fresh press (≤ 10 s old): the voice screen may start listening by itself and now owns the press's audio-session
 * token. Returns null when there is no fresh press (nothing is released then: that is the screen's own business).
 */
export function takeVoiceAutostart(now: number = Date.now()): { token: VoiceToken | null } | null {
  const p = press;
  if (!p) return null;
  press = null;
  p.clear(p.timer);
  if (now - p.at < 0 || now - p.at > VOICE_AUTOSTART_MS) { p.release(); return null; }
  return { token: p.token };
}
/** Gives back an unclaimed press now (the voice screen showed the dictation fallback, or closed). */
export function releaseVoicePress() {
  const p = press;
  if (!p) return;
  press = null;
  p.clear(p.timer);
  p.release();
}
/** Peek without claiming. */
export const voiceAutostartPending = (now: number = Date.now()) => !!press && now - press.at <= VOICE_AUTOSTART_MS;
/** When the current press expires (ms since epoch), or 0. One deadline for the whole screen (connecting → fallback). */
export const voiceAutostartDeadline = () => (press ? press.at + VOICE_AUTOSTART_MS : 0);

/** The BASHT tab's long-press (runs inside the gesture): prime, then open the voice screen here or by navigation. */
export function launchVoice(d: { pathname: string; push: (url: string) => void; dispatch: (e: Event) => void; prime?: () => void }) {
  (d.prime ?? primeVoiceFromGesture)();
  if (d.pathname === "/chat") d.dispatch(new CustomEvent(OPEN_VOICE_EVENT, { detail: { autostart: true } }));
  else d.push(VOICE_URL);
}
