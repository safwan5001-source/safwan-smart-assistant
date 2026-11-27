/**
 * Long-press on a link (the bottom BASHT tab): hold ≥ 450 ms to start a voice conversation, a short tap still navigates.
 *
 * iOS only treats the gesture's own events (pointerup/touchend/click) as user activation for audio and the microphone, so the
 * hold timer never activates anything: it only ARMS the press (visible progress done). The activation runs inside `up()`, i.e.
 * synchronously in the pointerup handler, after the hold elapsed. Moving > 10 px, pointercancel, leaving or scrolling cancels.
 * The click that follows a long press is swallowed (no navigation on top of the voice), and one press activates at most once.
 */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_PX = 10;

export type LongPressDeps = {
  /** runs synchronously inside the pointerup handler (the user gesture) */
  onActivate: () => void;
  /** the hold started / ended (visual progress ring) */
  onHold?: (state: "idle" | "holding" | "armed") => void;
  holdMs?: number;
  moveTolerance?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

export function createLongPress(d: LongPressDeps) {
  const holdMs = d.holdMs ?? LONG_PRESS_MS, tol = d.moveTolerance ?? LONG_PRESS_MOVE_PX;
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let press: { id: number; x: number; y: number; armed: boolean; timer: unknown } | null = null;
  let swallowClick = false;
  const hold = (s: "idle" | "holding" | "armed") => d.onHold?.(s);
  const cancel = () => {
    if (!press) return;
    clearTimer(press.timer);
    press = null;
    hold("idle");
  };
  return {
    /** pointerdown (primary button / touch / pen) */
    down(id: number, x: number, y: number) {
      cancel();
      swallowClick = false;
      const p = { id, x, y, armed: false, timer: null as unknown };
      p.timer = setTimer(() => { if (press === p) { p.armed = true; hold("armed"); } }, holdMs);
      press = p;
      hold("holding");
    },
    move(id: number, x: number, y: number) {
      if (!press || press.id !== id) return;
      if (Math.hypot(x - press.x, y - press.y) > tol) cancel();
    },
    /** pointerup: "activate" (long press — onActivate already ran), "tap" (let the link navigate) or "none" */
    up(id: number): "activate" | "tap" | "none" {
      if (!press || press.id !== id) return "none";
      const armed = press.armed;
      clearTimer(press.timer);
      press = null;
      hold("idle");
      if (!armed) return "tap";
      swallowClick = true; // the click that follows must not navigate as well
      d.onActivate();
      return "activate";
    },
    /** pointercancel / pointerleave / scroll */
    cancel,
    /** click: true when it must be prevented (it follows a long press). Consumes the flag. */
    click(): boolean { const s = swallowClick; swallowClick = false; return s; },
    holding: () => press !== null,
    armed: () => press?.armed ?? false,
  };
}
export type LongPress = ReturnType<typeof createLongPress>;
