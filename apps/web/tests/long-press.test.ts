import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLongPress, LONG_PRESS_MS } from "@/lib/long-press";
import { primeVoiceFromGesture, takeVoiceAutostart, voiceAutostartPending, VOICE_AUTOSTART_MS } from "@/lib/voice-launch";

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
    onActivate: () => { primeVoiceFromGesture({ enter: () => order.push("enterVoiceSession"), unlock: () => order.push("unlock"), prime: () => order.push("primeAudioInput") }); order.push("open"); },
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

describe("autostart needs a fresh press", () => {
  it("is granted once within 10 s of the gesture, never after a reload or a stale link", () => {
    const steps: string[] = [];
    primeVoiceFromGesture({ enter: () => steps.push("e"), unlock: () => { throw new Error("blocked"); }, prime: () => steps.push("p"), now: () => 1000 });
    expect(steps, "one failing step never skips the others").toEqual(["e", "p"]);
    expect(voiceAutostartPending(5000)).toBe(true);
    expect(takeVoiceAutostart(5000)).toBe(true);
    expect(takeVoiceAutostart(5001)).toBe(false); // consumed
    primeVoiceFromGesture({ enter() {}, unlock() {}, prime() {}, now: () => 0 });
    expect(takeVoiceAutostart(VOICE_AUTOSTART_MS + 1)).toBe(false); // too old
    expect(takeVoiceAutostart(1)).toBe(false); // no press at all
  });
});

describe("wiring (the component and the shell)", () => {
  const link = src("components/long-press-link.tsx");
  const shell = src("components/app-shell.tsx");
  const css = src("app/globals.css");
  it("activation happens in onPointerUp; the context menu and the following click are suppressed; Shift+Enter is the keyboard path", () => {
    expect(link).toMatch(/onPointerUp=\{up\}/);
    expect(link).toMatch(/if \(ctl\.current\?\.up\(e\.pointerId\) === "activate"\) e\.preventDefault\(\);/);
    expect(link).toMatch(/onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/);
    expect(link).toMatch(/onClick=\{\(e\) => \{ if \(ctl\.current\?\.click\(\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \} \}\}/);
    expect(link).toMatch(/e\.key === "Enter" && e\.shiftKey/);
    expect(link).toMatch(/aria-description=\{hint\}/);
    expect(link).toMatch(/navigator\.vibrate\?\.\(/); // only where supported
    expect(link).toMatch(/onPointerCancel=\{\(\) => ctl\.current\?\.cancel\(\)\} onPointerLeave=\{\(\) => ctl\.current\?\.cancel\(\)\}/);
  });
  it("the BASHT tab is the long-press link; a tap still goes to /chat; the press opens the voice with autostart", () => {
    expect(shell).toMatch(/<LongPressLink key=\{n\.href\} href=\{n\.href\} className="tab-agent"[\s\S]*?onLongPress=\{launchVoice\}/);
    expect(shell).toMatch(/const launchVoice = \(\) => \{\s*primeVoiceFromGesture\(\);/);
    expect(shell).toMatch(/router\.push\(VOICE_URL\)/);
    expect(src("lib/voice-launch.ts")).toMatch(/VOICE_URL = "\/chat\?voice=1&autostart=1"/);
  });
  it("no callout, link preview, selection or drag on the press; the ring respects reduced motion", () => {
    expect(css).toMatch(/\.long-press \{[^}]*-webkit-touch-callout: none;[^}]*user-select: none;[^}]*touch-action: manipulation;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tab-agent\[data-hold="holding"\] \.hold-ring \{ animation: none !important;/);
  });
});
