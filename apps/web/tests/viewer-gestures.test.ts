import { describe, expect, it, vi } from "vitest";
import { createGestures, DISMISS_DISTANCE, NAV_DISTANCE, type GestureView } from "@/lib/viewer-gestures";

/** Stage 400×800, picture 400×300 at scale 1 (centred). */
function setup(over: { rtl?: boolean; canNav?: boolean; maxScale?: number } = {}) {
  const views: GestureView[] = [];
  const onClose = vi.fn(); const onNav = vi.fn();
  const bounds = { vw: 400, vh: 800, cw: 400, ch: 300 };
  const g = createGestures({ bounds: () => bounds, onView: (v) => views.push(v), onClose, onNav, canNav: () => over.canNav ?? true, rtl: over.rtl ?? true, maxScale: over.maxScale });
  const last = () => g.view;
  return { g, last, onClose, onNav, bounds, views };
}
const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

describe("pinch zoom (two pointers)", () => {
  it("spreading two fingers zooms in around the midpoint; the picture point under the fingers stays under them", () => {
    const { g, last } = setup();
    g.pointerDown({ id: 1, x: 150, y: 400, t: 0 }); g.pointerDown({ id: 2, x: 250, y: 400, t: 0 });
    g.pointerMove({ id: 1, x: 100, y: 400 }); g.pointerMove({ id: 2, x: 300, y: 400 });
    near(last().scale, 2); near(last().x, 0); near(last().y, 0);
    expect(last().active).toBe(true);
    // pinch around an off-centre point (centre-based (100, 0)): that picture point must stay put
    const h = setup();
    h.g.pointerDown({ id: 1, x: 250, y: 400 }); h.g.pointerDown({ id: 2, x: 350, y: 400 }); // midpoint (300,400) → centre-based (100,0)
    h.g.pointerMove({ id: 1, x: 200, y: 400 }); h.g.pointerMove({ id: 2, x: 400, y: 400 }); // dist 100 → 200, midpoint now (300,400)
    near(h.last().scale, 2);
    // picture point under the start midpoint: (100 - 0)/1 = 100 from centre; at scale 2 it sits at x + 2*100 = midpoint 100 → x = -100
    near(h.last().x, -100);
  });
  it("scale is clamped to [1, max]: pinching in past 1 stays 1 (centred), pinching out past max stays max", () => {
    const { g, last } = setup({ maxScale: 4 });
    g.pointerDown({ id: 1, x: 190, y: 400 }); g.pointerDown({ id: 2, x: 210, y: 400 });
    g.pointerMove({ id: 1, x: 0, y: 400 }); g.pointerMove({ id: 2, x: 400, y: 400 });
    near(last().scale, 4);
    g.pointerMove({ id: 1, x: 199, y: 400 }); g.pointerMove({ id: 2, x: 201, y: 400 });
    expect(last()).toMatchObject({ scale: 1, x: 0, y: 0 });
  });
  it("lifting one finger carries on as a pan with the other (no jump), at scale > 1", () => {
    const { g, last } = setup();
    g.pointerDown({ id: 1, x: 150, y: 400 }); g.pointerDown({ id: 2, x: 250, y: 400 });
    g.pointerMove({ id: 1, x: 100, y: 400 }); g.pointerMove({ id: 2, x: 300, y: 400 });
    const before = { ...last() };
    g.pointerUp({ id: 1, x: 100, y: 400 });
    expect(last().x).toBe(before.x); expect(last().scale).toBe(before.scale);
    g.pointerMove({ id: 2, x: 250, y: 400 }); // 50 px left
    near(last().x, before.x - 50);
  });
});

describe("pan when zoomed (clamped)", () => {
  const zoomed = () => {
    const s = setup();
    s.g.pointerDown({ id: 1, x: 150, y: 400 }); s.g.pointerDown({ id: 2, x: 250, y: 400 });
    s.g.pointerMove({ id: 1, x: 100, y: 400 }); s.g.pointerMove({ id: 2, x: 300, y: 400 }); // scale 2 → picture 800×600
    s.g.pointerUp({ id: 2, x: 300, y: 400 }); s.g.pointerUp({ id: 1, x: 100, y: 400 });
    return s;
  };
  it("one finger pans the zoomed picture, never past its own edge (x ≤ (800−400)/2; the picture is shorter than the stage so y stays 0)", () => {
    const { g, last } = zoomed();
    expect(last().scale).toBeCloseTo(2);
    g.pointerDown({ id: 5, x: 200, y: 400, t: 1000 });
    g.pointerMove({ id: 5, x: 260, y: 460 });
    near(last().x, 60); near(last().y, 0);
    g.pointerMove({ id: 5, x: 900, y: 700 }); // far past the edge
    near(last().x, 200); near(last().y, 0);
    g.pointerMove({ id: 5, x: -900, y: 100 });
    near(last().x, -200);
    g.pointerUp({ id: 5, x: -900, y: 100, t: 1500 });
    near(last().x, -200);
  });
  it("a taller picture also pans vertically, clamped", () => {
    const g = createGestures({ bounds: () => ({ vw: 400, vh: 400, cw: 300, ch: 400 }), onView: () => {}, onClose: () => {} });
    g.zoomBy(3); // 900×1200 on a 400×400 stage → max x 250, max y 400
    g.pointerDown({ id: 1, x: 200, y: 200, t: 0 });
    g.pointerMove({ id: 1, x: 600, y: 900 });
    near(g.view.x, 250); near(g.view.y, 400);
  });
  it("at scale 1 a drag does not pan (the picture stays centred)", () => {
    const { g, last } = setup();
    g.pointerDown({ id: 1, x: 200, y: 400, t: 0 }); g.pointerMove({ id: 1, x: 260, y: 405 });
    expect(last()).toMatchObject({ scale: 1, x: 0, y: 0 });
  });
});

describe("double tap / double click", () => {
  it("two quick taps zoom in at the tapped point, a third double-tap goes back to 1", () => {
    const { g, last } = setup();
    const tap = (t: number, x: number, y: number) => { g.pointerDown({ id: 1, x, y, t }); g.pointerUp({ id: 1, x, y, t: t + 40 }); };
    tap(0, 300, 400); expect(last().scale).toBe(1); // a single tap does nothing
    tap(150, 302, 402);
    near(last().scale, 2.5);
    expect(last().x).toBeLessThan(0); // zoomed towards the right half: the picture moved left
    tap(1000, 200, 400); tap(1150, 200, 400);
    expect(last()).toMatchObject({ scale: 1, x: 0, y: 0 });
  });
  it("taps too far apart in time or space are not a double tap", () => {
    const { g, last } = setup();
    const tap = (t: number, x: number) => { g.pointerDown({ id: 1, x, y: 400, t }); g.pointerUp({ id: 1, x, y: 400, t: t + 30 }); };
    tap(0, 100); tap(700, 100);
    expect(last().scale).toBe(1);
    tap(5000, 100); tap(5100, 300);
    expect(last().scale).toBe(1);
  });
  it("a drag is not a tap", () => {
    const { g, last } = setup();
    g.pointerDown({ id: 1, x: 100, y: 400, t: 0 }); g.pointerMove({ id: 1, x: 130, y: 400 }); g.pointerUp({ id: 1, x: 130, y: 400, t: 60 });
    g.pointerDown({ id: 1, x: 130, y: 400, t: 120 }); g.pointerUp({ id: 1, x: 130, y: 400, t: 160 });
    expect(last().scale).toBe(1);
  });
  it("the zoomed picture from a double tap near a corner stays inside the bounds", () => {
    const { g, last } = setup();
    g.pointerDown({ id: 1, x: 399, y: 5, t: 0 }); g.pointerUp({ id: 1, x: 399, y: 5, t: 30 });
    g.pointerDown({ id: 1, x: 399, y: 5, t: 100 }); g.pointerUp({ id: 1, x: 399, y: 5, t: 130 });
    near(last().scale, 2.5); expect(Math.abs(last().x)).toBeLessThanOrEqual((400 * 2.5 - 400) / 2 + 1e-9); expect(last().x).toBeLessThan(-250); expect(last().y).toBe(0);
  });
});

describe("wheel zoom (desktop)", () => {
  it("wheel up zooms in at the cursor, wheel down zooms out and snaps back to centre at 1; ctrl+wheel (trackpad pinch) is faster", () => {
    const { g, last } = setup();
    g.wheel({ x: 300, y: 400, deltaY: -300 });
    expect(last().scale).toBeGreaterThan(1.4);
    expect(last().x).toBeLessThan(0);
    g.wheel({ x: 300, y: 400, deltaY: 100000 });
    expect(last()).toMatchObject({ scale: 1, x: 0, y: 0 });
    const a = setup(), b = setup();
    a.g.wheel({ x: 200, y: 400, deltaY: -10 }); b.g.wheel({ x: 200, y: 400, deltaY: -10, ctrl: true });
    expect(b.last().scale).toBeGreaterThan(a.last().scale);
  });
  it("clamped to the maximum", () => {
    const { g, last } = setup({ maxScale: 3 });
    for (let i = 0; i < 40; i++) g.wheel({ x: 10, y: 10, deltaY: -400 });
    expect(last().scale).toBe(3);
    expect(Math.abs(last().x)).toBeLessThanOrEqual(400 * 3 / 2 - 200 + 1e-9);
  });
  it("zoomBy (keyboard +/−) zooms about the centre; reset returns to 1", () => {
    const { g, last } = setup();
    g.zoomBy(2); near(last().scale, 2); near(last().x, 0);
    g.reset(); expect(last()).toMatchObject({ scale: 1, x: 0, y: 0, active: false });
  });
});

describe("swipe down closes; swipe sideways moves between pictures", () => {
  it("a long swipe down closes; the picture follows the finger meanwhile (dismissDy)", () => {
    const { g, last, onClose } = setup();
    g.pointerDown({ id: 1, x: 200, y: 300, t: 0 });
    g.pointerMove({ id: 1, x: 203, y: 360 });
    expect(last().dismissDy).toBe(60);
    g.pointerMove({ id: 1, x: 203, y: 300 + DISMISS_DISTANCE + 20 });
    g.pointerUp({ id: 1, x: 203, y: 300 + DISMISS_DISTANCE + 20, t: 900 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(last().dismissDy).toBe(0);
  });
  it("a short slow swipe springs back; a short fast flick closes; swiping UP never closes", () => {
    const a = setup();
    a.g.pointerDown({ id: 1, x: 200, y: 300, t: 0 }); a.g.pointerMove({ id: 1, x: 200, y: 350 }); a.g.pointerUp({ id: 1, x: 200, y: 350, t: 1000 });
    expect(a.onClose).not.toHaveBeenCalled(); expect(a.last().dismissDy).toBe(0);
    const b = setup();
    b.g.pointerDown({ id: 1, x: 200, y: 300, t: 0 }); b.g.pointerMove({ id: 1, x: 200, y: 360 }); b.g.pointerUp({ id: 1, x: 200, y: 360, t: 60 });
    expect(b.onClose).toHaveBeenCalledTimes(1);
    const c = setup();
    c.g.pointerDown({ id: 1, x: 200, y: 600, t: 0 }); c.g.pointerMove({ id: 1, x: 200, y: 200 }); c.g.pointerUp({ id: 1, x: 200, y: 200, t: 100 });
    expect(c.onClose).not.toHaveBeenCalled();
  });
  it("a swipe down while zoomed pans instead of closing", () => {
    const { g, onClose } = setup();
    g.zoomBy(3);
    g.pointerDown({ id: 1, x: 200, y: 100, t: 0 }); g.pointerMove({ id: 1, x: 200, y: 700 }); g.pointerUp({ id: 1, x: 200, y: 700, t: 200 });
    expect(onClose).not.toHaveBeenCalled();
  });
  it("RTL: dragging to the right shows the NEXT picture, to the left the previous; LTR is the mirror", () => {
    const rtl = setup({ rtl: true });
    rtl.g.pointerDown({ id: 1, x: 100, y: 400, t: 0 }); rtl.g.pointerMove({ id: 1, x: 100 + NAV_DISTANCE + 20, y: 405 }); rtl.g.pointerUp({ id: 1, x: 100 + NAV_DISTANCE + 20, y: 405, t: 500 });
    expect(rtl.onNav).toHaveBeenLastCalledWith(1);
    rtl.g.pointerDown({ id: 1, x: 300, y: 400, t: 1000 }); rtl.g.pointerMove({ id: 1, x: 300 - NAV_DISTANCE - 20, y: 405 }); rtl.g.pointerUp({ id: 1, x: 300 - NAV_DISTANCE - 20, y: 405, t: 1500 });
    expect(rtl.onNav).toHaveBeenLastCalledWith(-1);
    const ltr = setup({ rtl: false });
    ltr.g.pointerDown({ id: 1, x: 300, y: 400, t: 0 }); ltr.g.pointerMove({ id: 1, x: 300 - NAV_DISTANCE - 20, y: 405 }); ltr.g.pointerUp({ id: 1, x: 300 - NAV_DISTANCE - 20, y: 405, t: 500 });
    expect(ltr.onNav).toHaveBeenLastCalledWith(1);
  });
  it("a short sideways drag does not navigate; with a single picture (canNav false) nothing moves", () => {
    const a = setup();
    a.g.pointerDown({ id: 1, x: 100, y: 400, t: 0 }); a.g.pointerMove({ id: 1, x: 130, y: 400 }); a.g.pointerUp({ id: 1, x: 130, y: 400, t: 800 });
    expect(a.onNav).not.toHaveBeenCalled(); expect(a.last().navDx).toBe(0);
    const b = setup({ canNav: false });
    b.g.pointerDown({ id: 1, x: 100, y: 400, t: 0 }); b.g.pointerMove({ id: 1, x: 300, y: 400 }); b.g.pointerUp({ id: 1, x: 300, y: 400, t: 500 });
    expect(b.onNav).not.toHaveBeenCalled(); expect(b.last().navDx).toBe(0);
  });
});

describe("cancel and resize", () => {
  it("a cancelled pointer (the system took the touch) never closes or navigates, and clears the drag", () => {
    const { g, last, onClose, onNav } = setup();
    g.pointerDown({ id: 1, x: 200, y: 300, t: 0 }); g.pointerMove({ id: 1, x: 200, y: 600 });
    g.pointerCancel({ id: 1, x: 200, y: 600, t: 100 });
    expect(onClose).not.toHaveBeenCalled(); expect(onNav).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ dismissDy: 0, navDx: 0, active: false });
  });
  it("refit() re-clamps after the stage shrinks (rotation)", () => {
    const b = { vw: 400, vh: 800, cw: 400, ch: 300 };
    const g = createGestures({ bounds: () => b, onView: () => {}, onClose: () => {} });
    g.zoomBy(3);
    g.pointerDown({ id: 1, x: 200, y: 400, t: 0 }); g.pointerMove({ id: 1, x: 900, y: 400 }); g.pointerUp({ id: 1, x: 900, y: 400, t: 900 });
    near(g.view.x, 400);
    Object.assign(b, { vw: 300, cw: 300 }); g.refit();
    near(g.view.x, (300 * 3 - 300) / 2);
  });
  it("events of a pointer that never went down are ignored", () => {
    const { g, last } = setup();
    g.pointerMove({ id: 9, x: 5, y: 5 }); g.pointerUp({ id: 9, x: 5, y: 5, t: 1 });
    expect(last()).toMatchObject({ scale: 1, x: 0, y: 0 });
  });
});
