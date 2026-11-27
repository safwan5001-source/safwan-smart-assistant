import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLongPress, longPressHandlers, LONG_PRESS_MS } from "@/lib/long-press";
import { launchVoice, OPEN_VOICE_EVENT, primeVoiceFromGesture, releaseVoicePress, takeVoiceAutostart, voiceAutostartPending, VOICE_AUTOSTART_MS, VOICE_URL } from "@/lib/voice-launch";

const WEB = resolve(__dirname, "..");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function rig() {
  const order: string[] = [];
  const holds: string[] = [];
  const lp = createLongPress({
    onHold: (h) => holds.push(h),
    // what the BASHT tab does on activation: the gesture-only steps, then open the voice screen
    onActivate: () => { primeVoiceFromGesture({ enter: () => { order.push("enterVoiceSession"); }, unlock: () => order.push("unlock"), prime: () => order.push("primeAudioInput"), leave() {}, close() {} }); releaseVoicePress(); order.push("open"); },
  });
  return { lp, order, holds };
}

describe("long-press on the BASHT tab", () => {
  it("a short tap navigates exactly as before (no activation, the click is not touched)", () => {
    const { lp, order } = rig();
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(200);
    expect(lp.up(1)).toBe("tap");
    expect(order).toEqual([]);
    expect(lp.click()).toBe(false);
  });
  it("the hold timer only arms; activation runs inside pointerup, once, with the gesture-only steps in order", () => {
    const { lp, order, holds } = rig();
    lp.down(7, 50, 50);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(holds).toEqual(["holding", "armed"]);
    expect(order, "nothing happens in the timer (iOS would not treat it as a user gesture)").toEqual([]);
    expect(lp.up(7)).toBe("activate");
    // synchronous: by the time the pointerup handler returns, the audio session, unlock and probe already ran
    expect(order).toEqual(["enterVoiceSession", "unlock", "primeAudioInput", "open"]);
    expect(lp.click(), "the click after a long press is swallowed").toBe(true);
    expect(lp.click()).toBe(false);
    expect(lp.up(7), "no double activation").toBe("none");
    expect(order.filter((x) => x === "open")).toHaveLength(1);
  });
  it("moving more than 10 px, pointercancel, leaving or scrolling aborts; small jitter does not", () => {
    const a = rig();
    a.lp.down(1, 0, 0); a.lp.move(1, 6, 6); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(a.lp.up(1)).toBe("activate");
    const b = rig();
    b.lp.down(1, 0, 0); b.lp.move(1, 9, 9); // 12.7 px
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(b.lp.up(1)).toBe("none"); expect(b.order).toEqual([]);
    expect(b.holds.at(-1)).toBe("idle");
    const c = rig();
    c.lp.down(1, 0, 0); vi.advanceTimersByTime(LONG_PRESS_MS); c.lp.cancel();
    expect(c.lp.up(1)).toBe("none"); expect(c.order).toEqual([]);
  });
  it("another pointer's events never complete this press; a new press resets the click flag", () => {
    const { lp, order } = rig();
    lp.down(1, 0, 0); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(lp.up(2)).toBe("none");
    lp.move(2, 500, 500);
    expect(lp.up(1)).toBe("activate");
    lp.down(3, 0, 0); // the click after the long press never came (iOS): the next tap navigates normally
    expect(lp.click()).toBe(false);
    expect(order.filter((x) => x === "open")).toHaveLength(1);
  });
});

describe("a press is claimed by the voice screen, or given back", () => {
  const deps = () => {
    const log: string[] = [];
    const timers: { f: () => void; ms: number; cleared: boolean }[] = [];
    const token = { id: 42, ok: true };
    return { log, timers, token, d: {
      enter: () => { log.push("enter"); return token; }, unlock: () => log.push("unlock"), prime: () => log.push("prime"),
      leave: (t: unknown) => log.push("leave:" + (t === token ? "press" : String(t))), close: () => log.push("close"), now: () => 1000,
      setTimer: (f: () => void, ms: number) => { const t = { f, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (h: unknown) => { (h as { cleared: boolean }).cleared = true; },
    } };
  };
  it("claimed within 10 s: the screen owns the press's audio-session token; nothing is released", () => {
    const x = deps();
    primeVoiceFromGesture(x.d);
    expect(x.log).toEqual(["enter", "unlock", "prime"]);
    expect(voiceAutostartPending(5000)).toBe(true);
    expect(takeVoiceAutostart(5000)).toEqual({ token: x.token });
    expect(takeVoiceAutostart(5001)).toBeNull(); // consumed
    expect(x.timers[0].cleared).toBe(true);
    expect(x.log).not.toContain("close");
  });
  it("never claimed (redirect to sign-in, the screen never mounted): at the deadline the session goes back and the context closes", () => {
    const x = deps();
    primeVoiceFromGesture(x.d);
    expect(x.timers[0].ms).toBe(VOICE_AUTOSTART_MS);
    x.timers[0].f();
    expect(x.log.slice(-2)).toEqual(["leave:press", "close"]);
    expect(takeVoiceAutostart(2000)).toBeNull();
  });
  it("too old when claimed, a newer press, or the dictation fallback shown: given back too", () => {
    const x = deps();
    primeVoiceFromGesture(x.d);
    expect(takeVoiceAutostart(1000 + VOICE_AUTOSTART_MS + 1)).toBeNull();
    expect(x.log.slice(-2)).toEqual(["leave:press", "close"]);
    const y = deps();
    primeVoiceFromGesture(y.d); primeVoiceFromGesture(y.d); // the older press is released by the newer one
    expect(y.log.filter((l) => l === "close")).toHaveLength(1);
    releaseVoicePress();
    expect(y.log.filter((l) => l === "close")).toHaveLength(2);
    expect(takeVoiceAutostart(1500)).toBeNull();
  });
  it("one failing step never skips the others", () => {
    const steps: string[] = [];
    primeVoiceFromGesture({ enter: () => { steps.push("e"); }, unlock: () => { throw new Error("blocked"); }, prime: () => steps.push("p"), now: () => 1000 });
    expect(steps).toEqual(["e", "p"]);
    releaseVoicePress();
  });
});

describe("the link's handlers (what LongPressLink binds)", () => {
  const ev = (o: Record<string, unknown> = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10, key: "", shiftKey: false, ...o });
  const make = () => { const acted = vi.fn(); const lp = createLongPress({ onActivate: acted }); return { acted, h: longPressHandlers(lp, acted) }; };
  it("hold then pointerup activates INSIDE that handler and prevents the default; the following click is swallowed", () => {
    const { acted, h } = make();
    h.onPointerDown(ev()); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(acted).not.toHaveBeenCalled();
    const up = ev(); h.onPointerUp(up);
    expect(acted).toHaveBeenCalledTimes(1); expect(up.preventDefault).toHaveBeenCalled();
    const click = ev(); h.onClick(click);
    expect(click.preventDefault).toHaveBeenCalled(); expect(click.stopPropagation).toHaveBeenCalled();
  });
  it("a short tap's click navigates (not prevented); the context menu is always suppressed; a right click never starts a hold", () => {
    const { acted, h } = make();
    h.onPointerDown(ev()); vi.advanceTimersByTime(100); h.onPointerUp(ev());
    const click = ev(); h.onClick(click);
    expect(click.preventDefault).not.toHaveBeenCalled(); expect(acted).not.toHaveBeenCalled();
    const menu = ev(); h.onContextMenu(menu); expect(menu.preventDefault).toHaveBeenCalled();
    h.onPointerDown(ev({ pointerType: "mouse", button: 2 })); vi.advanceTimersByTime(LONG_PRESS_MS); h.onPointerUp(ev({ pointerType: "mouse", button: 2 }));
    expect(acted).not.toHaveBeenCalled();
  });
  it("moving away or leaving cancels; Shift+Enter is the keyboard path, plain Enter navigates", () => {
    const { acted, h } = make();
    h.onPointerDown(ev()); h.onPointerMove(ev({ clientX: 30 })); vi.advanceTimersByTime(LONG_PRESS_MS); h.onPointerUp(ev());
    h.onPointerDown(ev()); h.onPointerLeave(); vi.advanceTimersByTime(LONG_PRESS_MS); h.onPointerUp(ev());
    h.onPointerDown(ev()); h.onPointerCancel(); vi.advanceTimersByTime(LONG_PRESS_MS); h.onPointerUp(ev());
    expect(acted).not.toHaveBeenCalled();
    const enter = ev({ key: "Enter" }); h.onKeyDown(enter); expect(enter.preventDefault).not.toHaveBeenCalled(); expect(acted).not.toHaveBeenCalled();
    const shift = ev({ key: "Enter", shiftKey: true }); h.onKeyDown(shift); expect(shift.preventDefault).toHaveBeenCalled(); expect(acted).toHaveBeenCalledTimes(1);
  });
  it("launchVoice primes first, then opens the voice screen (in place on /chat, by navigation elsewhere)", () => {
    const order: string[] = [];
    launchVoice({ pathname: "/tasks", prime: () => order.push("prime"), push: (u) => order.push("push " + u), dispatch: () => order.push("dispatch") });
    expect(order).toEqual(["prime", "push " + VOICE_URL]);
    const seen: Event[] = [];
    launchVoice({ pathname: "/chat", prime: () => {}, push: () => { throw new Error("no"); }, dispatch: (e) => seen.push(e) });
    expect(seen[0].type).toBe(OPEN_VOICE_EVENT);
    expect((seen[0] as CustomEvent).detail).toEqual({ autostart: true });
    expect(VOICE_URL).toBe("/chat?voice=1&autostart=1");
  });
  it("CSS: no callout, link preview, selection or drag on the press; the ring respects reduced motion", () => {
    const css = src("app/globals.css");
    expect(css).toMatch(/\.long-press \{[^}]*-webkit-touch-callout: none;[^}]*user-select: none;[^}]*touch-action: manipulation;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tab-agent\[data-hold="holding"\] \.hold-ring \{ animation: none !important;/);
  });
});
