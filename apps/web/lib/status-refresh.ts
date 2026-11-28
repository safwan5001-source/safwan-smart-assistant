/**
 * When the status indicators re-read, with no polling:
 *  - the public health (the «الخادم» row and the gateway half of «جاهزية باشت») re-reads quietly (no flip to «checking») on the same
 *    focus / visible trigger as the engine's own read, at most every 30 s, so the two halves of one row cannot drift apart for hours;
 *  - the «آخر فحص» label gets a coarse one-minute tick WHILE THE PAGE IS VISIBLE only (it fetches nothing).
 */
export const HEALTH_MIN_MS = 30_000;
export const TICK_MS = 60_000;

type Target = { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
type Doc = Target & { visibilityState: string };

/** When the health was last re-read on a focus/visible trigger: shared by every mounted indicator, so two screens never double the reads. */
let lastAsked = -Infinity;
export const resetHealthThrottle = () => { lastAsked = -Infinity; };

/**
 * Health reads where only the NEWEST request may deliver (an older, slower answer never overwrites a newer one or ends «checking»
 * early), stamped with the moment the request STARTED (the observation time), not when the answer arrived.
 */
export function createLatestReader<T>(fetch: () => Promise<T>, now: () => number = Date.now) {
  let seq = 0;
  return {
    start(deliver: (value: T, startedAt: number) => void): void {
      const mine = ++seq, startedAt = now();
      void fetch().then((v) => { if (mine === seq) deliver(v, startedAt); });
    },
    /** Drops every answer still in flight (unmount). */
    cancel() { seq++; },
  };
}

/** Re-reads the health on focus / when the tab becomes visible, throttled to one read per `minMs`. Returns detach(). */
export function attachHealthRefresh(d: { getCheckedAt: () => number | null; refreshQuiet: () => void; now?: () => number; win?: Target; doc?: Doc; minMs?: number }): () => void {
  const now = d.now ?? Date.now, minMs = d.minMs ?? HEALTH_MIN_MS;
  const win = d.win ?? window, doc = d.doc ?? document;
  const again = () => {
    if (doc.visibilityState === "hidden") return;
    const t = now(), last = d.getCheckedAt();
    if (last === null) return; // a read is already in flight (checking)
    if (t - Math.max(last, lastAsked) < minMs) return;
    lastAsked = t;
    d.refreshQuiet();
  };
  win.addEventListener("focus", again);
  doc.addEventListener("visibilitychange", again);
  return () => { win.removeEventListener("focus", again); doc.removeEventListener("visibilitychange", again); };
}

/** Calls `cb` once a minute while the page is visible and never while it is hidden; no fetch. Returns stop(). */
export function startVisibleTick(cb: () => void, d: { doc?: Doc; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; ms?: number } = {}): () => void {
  const doc = d.doc ?? document, ms = d.ms ?? TICK_MS;
  const set = d.setTimer ?? ((f, m) => setInterval(f, m)), clear = d.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let h: unknown = null;
  const sync = () => {
    if (doc.visibilityState === "hidden") { if (h !== null) { clear(h); h = null; } return; }
    cb(); // back in view: the label catches up at once
    if (h === null) h = set(cb, ms);
  };
  if (doc.visibilityState !== "hidden") h = set(cb, ms);
  doc.addEventListener("visibilitychange", sync);
  return () => { doc.removeEventListener("visibilitychange", sync); if (h !== null) { clear(h); h = null; } };
}

/** «إعادة الفحص»: the health (loud) and the engine's own status, both forced; the push row follows its own store. */
export function recheckAll(d: { refresh: () => void; engineRefresh: (o: { force: boolean }) => unknown }): void {
  d.refresh();
  void d.engineRefresh({ force: true });
}
