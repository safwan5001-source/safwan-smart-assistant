import { vi } from "vitest";

/** A fake <audio>: records what the player asks and lets the test fire the media events the browser would. */
export class FakeEl {
  src = ""; currentTime = 0; muted = false; ended = false; duration = 2; error: { code: number } | null = null;
  private ls = new Map<string, Set<() => void>>();
  play = vi.fn(async () => {});
  pause = vi.fn(() => {});
  addEventListener(t: string, cb: () => void) { if (!this.ls.has(t)) this.ls.set(t, new Set()); this.ls.get(t)!.add(cb); }
  emit(t: string) { if (t === "ended") this.ended = true; if (t === "loadstart" || t === "playing") this.ended = false; this.ls.get(t)?.forEach((f) => f()); }
}
/** Lets pending promise callbacks run (works with fake timers too). */
export const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
export const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
