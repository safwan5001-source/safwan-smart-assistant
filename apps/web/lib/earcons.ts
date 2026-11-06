"use client";
/**
 * Optional voice-session earcons (start / stop listening). Off by default; synthesized with WebAudio
 * (no files, no network). Always triggered from a user tap, so iOS allows them; they follow the ringer switch
 * like other page audio. New, separate preference key — no existing key is reused or renamed.
 */
import { createStore } from "./storage";

export const voiceFxStore = createStore<boolean>({ key: "safwan-voice-fx", fallback: false, decode: (r) => r === "true", encode: String });

type AC = typeof AudioContext;
let ctx: AudioContext | null = null;

export function earcon(kind: "start" | "stop") {
  if (typeof window === "undefined") return;
  try {
    const Ctor: AC | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    // two soft sine notes: rising for start, falling for stop
    const notes = kind === "start" ? [523.25, 783.99] : [659.25, 440];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.type = "sine"; o.frequency.value = f;
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.12, s + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
      o.connect(g).connect(ctx!.destination); o.start(s); o.stop(s + 0.24);
    });
  } catch { /* audio is a nicety; never break the session */ }
}
