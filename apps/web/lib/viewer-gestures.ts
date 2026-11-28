/**
 * Touch / mouse gestures of the full-screen image viewer, without a library: Pointer Events in, a CSS transform out. Pure (no DOM):
 * the component feeds it pointer events (coordinates relative to the stage's top-left) and renders `view`.
 *
 * - two fingers: pinch-zoom around the midpoint (and pan with the midpoint); lifting one finger carries on as a pan
 * - one finger while zoomed: pan, clamped so the picture never leaves the stage; never past the picture's own edge
 * - one finger at scale 1: a mostly vertical downward drag follows the finger and, past a distance (or fast enough), closes;
 *   a mostly horizontal drag moves to the next / previous picture (RTL-aware: dragging to the right shows the next one)
 * - double tap / double click: zoom in at that point, or back to 1; ctrl/meta + wheel (trackpad pinch) zooms at the cursor, a plain
 *   wheel / two-finger scroll pans the zoomed picture
 * Scale is kept within [1, maxScale]; a result near 1 snaps to exactly 1 and centres.
 */
export type Bounds = { vw: number; vh: number; cw: number; ch: number };
export type GestureView = { scale: number; x: number; y: number; dismissDy: number; navDx: number; active: boolean };
export type PointerIn = { id: number; x: number; y: number; t?: number };
export type GestureOptions = {
  /** Stage size (vw, vh) and the picture's displayed size at scale 1 (cw, ch). */
  bounds: () => Bounds;
  onView: (v: GestureView) => void;
  onClose: () => void;
  /** +1 = next picture, -1 = previous. Called only when `canNav()` allows. */
  onNav?: (dir: 1 | -1) => void;
  canNav?: () => boolean;
  rtl?: boolean;
  maxScale?: number;
  doubleTapScale?: number;
};

export const DISMISS_DISTANCE = 110;
export const NAV_DISTANCE = 70;
export const TAP_SLOP = 10;
export const TAP_MS = 300;
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP = 32;
const SNAP = 1.03;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createGestures(opts: GestureOptions) {
  const max = opts.maxScale ?? 5;
  const dtScale = opts.doubleTapScale ?? 2.5;
  let scale = 1, x = 0, y = 0, dismissDy = 0, navDx = 0;
  const ptrs = new Map<number, { x: number; y: number }>();
  type Mode = "idle" | "pan" | "swipe" | "dismiss" | "nav" | "pinch";
  let mode: Mode = "idle";
  let start = { x: 0, y: 0, vx: 0, vy: 0, t: 0, moved: false };
  let pinch = { dist: 1, scale: 1, mx: 0, my: 0, vx: 0, vy: 0 };
  let lastTap: { t: number; x: number; y: number } | null = null;

  const emit = () => opts.onView({ scale, x, y, dismissDy, navDx, active: ptrs.size > 0 });
  const limit = (s: number) => { const b = opts.bounds(); return { mx: Math.max(0, (b.cw * s - b.vw) / 2), my: Math.max(0, (b.ch * s - b.vh) / 2) }; };
  const fix = () => {
    if (scale < SNAP) { scale = 1; x = 0; y = 0; return; }
    const l = limit(scale); x = clamp(x, -l.mx, l.mx); y = clamp(y, -l.my, l.my);
  };
  /** Centre-based coordinates of a stage point. */
  const centre = (px: number, py: number) => { const b = opts.bounds(); return { x: px - b.vw / 2, y: py - b.vh / 2 }; };
  /** Zooms to `s`, keeping the picture point under the (centre-based) point `p` under it. */
  const zoomAt = (s: number, p: { x: number; y: number }) => {
    const ns = clamp(s, 1, max);
    const k = ns / scale;
    x = p.x - (p.x - x) * k; y = p.y - (p.y - y) * k; scale = ns; fix();
  };
  const only = () => { const [id, p] = [...ptrs][0]; return { id, ...p }; };
  const beginSingle = (p: { x: number; y: number }, t: number) => {
    start = { x: p.x, y: p.y, vx: x, vy: y, t, moved: false };
    mode = scale > SNAP ? "pan" : "swipe"; dismissDy = 0; navDx = 0;
  };

  return {
    get view(): GestureView { return { scale, x, y, dismissDy, navDx, active: ptrs.size > 0 }; },
    pointerDown(e: PointerIn) {
      ptrs.set(e.id, { x: e.x, y: e.y });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const m = centre((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale, mx: m.x, my: m.y, vx: x, vy: y };
        mode = "pinch"; dismissDy = 0; navDx = 0;
      } else if (ptrs.size === 1) beginSingle(e, e.t ?? 0);
      else mode = "idle";
      emit();
    },
    pointerMove(e: PointerIn) {
      const p = ptrs.get(e.id);
      if (!p) return;
      p.x = e.x; p.y = e.y;
      if (mode === "pinch" && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const m = centre((a.x + b.x) / 2, (a.y + b.y) / 2);
        const ns = clamp(pinch.scale * dist / pinch.dist, 1, max);
        // the picture point that was under the start midpoint follows the current midpoint
        x = m.x - ns * (pinch.mx - pinch.vx) / pinch.scale;
        y = m.y - ns * (pinch.my - pinch.vy) / pinch.scale;
        scale = ns; fix();
      } else if (ptrs.size === 1) {
        const dx = e.x - start.x, dy = e.y - start.y;
        if (!start.moved && Math.hypot(dx, dy) > TAP_SLOP) start.moved = true;
        if (mode === "pan") { x = start.vx + dx; y = start.vy + dy; fix(); }
        else if (mode === "swipe" && start.moved) {
          if (Math.abs(dy) > Math.abs(dx)) { if (dy > 0) mode = "dismiss"; }
          else if (opts.canNav?.() ?? !!opts.onNav) mode = "nav";
        }
        if (mode === "dismiss") dismissDy = Math.max(0, dy);
        if (mode === "nav") navDx = dx;
      }
      emit();
    },
    pointerUp(e: PointerIn, cancelled = false) {
      if (!ptrs.has(e.id)) return;
      const t = e.t ?? 0;
      const p = ptrs.get(e.id)!; p.x = e.x; p.y = e.y;
      const wasMode = mode;
      ptrs.delete(e.id);
      if (ptrs.size > 0) {
        // a finger lifted off a pinch: carry on panning with the remaining one (no jump)
        if (wasMode === "pinch" && ptrs.size === 1) { const r = only(); beginSingle(r, t); start.moved = true; if (scale <= SNAP) { scale = 1; x = 0; y = 0; mode = "idle"; } }
        emit(); return;
      }
      const dt = Math.max(1, t - start.t);
      if (!cancelled && wasMode === "dismiss") {
        const speed = dismissDy / dt;
        const close = dismissDy > DISMISS_DISTANCE || (dismissDy > 40 && speed > 0.7);
        dismissDy = 0; navDx = 0; mode = "idle"; emit();
        if (close) opts.onClose();
        return;
      }
      if (!cancelled && wasMode === "nav") {
        const speed = Math.abs(navDx) / dt;
        const go = Math.abs(navDx) > NAV_DISTANCE || (Math.abs(navDx) > 30 && speed > 0.6);
        const dir: 1 | -1 = (opts.rtl ? navDx > 0 : navDx < 0) ? 1 : -1;
        navDx = 0; dismissDy = 0; mode = "idle"; emit();
        if (go) opts.onNav?.(dir);
        return;
      }
      if (!cancelled && (wasMode === "swipe" || wasMode === "pan") && !start.moved && t - start.t <= TAP_MS) {
        if (lastTap && t - lastTap.t <= DOUBLE_TAP_MS && Math.hypot(e.x - lastTap.x, e.y - lastTap.y) <= DOUBLE_TAP_SLOP) {
          lastTap = null;
          if (scale > SNAP) { scale = 1; x = 0; y = 0; } else zoomAt(dtScale, centre(e.x, e.y));
        } else lastTap = { t, x: e.x, y: e.y };
      } else lastTap = null;
      dismissDy = 0; navDx = 0; mode = "idle";
      fix(); emit();
    },
    pointerCancel(e: PointerIn) { this.pointerUp(e, true); },
    /**
     * Wheel at a stage point. Zoom ONLY with ctrl/meta (a trackpad pinch arrives as ctrl+wheel, a mouse wheel with the key held);
     * a plain wheel / two-finger scroll pans the zoomed picture (clamped) and does nothing at scale 1.
     */
    wheel(e: { x: number; y: number; deltaX?: number; deltaY: number; ctrl?: boolean; meta?: boolean }) {
      if (ptrs.size) return;
      if (e.ctrl || e.meta) { zoomAt(scale * Math.exp(-e.deltaY * (e.ctrl ? 0.01 : 0.0015)), centre(e.x, e.y)); emit(); return; }
      if (scale <= SNAP) return;
      x -= e.deltaX ?? 0; y -= e.deltaY; fix(); emit();
    },
    /** Toolbar / keyboard zoom, around the stage centre. */
    zoomBy(factor: number) { zoomAt(scale * factor, { x: 0, y: 0 }); emit(); },
    /** The stage or the picture changed size (rotation, a new picture): keep it inside the new bounds. */
    refit() { fix(); emit(); },
    reset() { scale = 1; x = 0; y = 0; dismissDy = 0; navDx = 0; ptrs.clear(); mode = "idle"; lastTap = null; emit(); },
  };
}
export type Gestures = ReturnType<typeof createGestures>;
