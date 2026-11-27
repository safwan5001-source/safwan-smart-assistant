"use client";
/**
 * The ONE Web Audio context of the page (microphone level probe + optional voice earcons). iOS keeps a context suspended until it
 * is resumed inside a user gesture, and every extra context competes for the audio route, so there is exactly one:
 *  - `primeAudioContext()` creates/resumes it inside a tap (live start, long-press);
 *  - `suspendAudioContext()` parks it after a microphone turn, so BASHT's voice gets the output route on its own;
 *  - `closeAudioContext()` drops it when the voice session ends (the next session primes a fresh one in its own gesture).
 */
type AC = typeof AudioContext;
let ctx: AudioContext | null = null;

const ctor = (): AC | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
};

/** The current context, or null (never creates one). */
export const audioContext = (): AudioContext | null => (ctx && ctx.state !== "closed" ? ctx : null);

/** Creates (once) and resumes the context. Call synchronously inside a user gesture. Never throws. */
export function primeAudioContext(): AudioContext | null {
  try {
    const C = ctor();
    if (!C) return null;
    if (!ctx || ctx.state === "closed") ctx = new C();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}
/** Resumes a suspended context (best effort; iOS may refuse outside a gesture — callers then work without it). */
export async function resumeAudioContext(): Promise<boolean> {
  const c = audioContext();
  if (!c) return false;
  if (c.state === "running") return true;
  try { await c.resume(); } catch { /* refused */ }
  return (c.state as string) === "running";
}
export async function suspendAudioContext(): Promise<void> {
  const c = audioContext();
  if (!c || c.state !== "running") return;
  try { await c.suspend(); } catch { /* best effort */ }
}
export async function closeAudioContext(): Promise<void> {
  const c = ctx;
  ctx = null;
  if (!c || c.state === "closed") return;
  try { await c.close(); } catch { /* best effort */ }
}
