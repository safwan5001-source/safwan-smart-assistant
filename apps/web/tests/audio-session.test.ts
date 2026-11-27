import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAudioPlayer, createAudioSession, enterVoiceSession, leaveVoiceSession, withToneSession } from "@/lib/audio";

const WEB = resolve(__dirname, "..");

describe("audio session: tones are ambient only while they play", () => {
  it("withTone sets ambient for the tone, then restores the previous type", async () => {
    const api = { type: "auto" };
    const s = createAudioSession(() => api);
    const seen = await s.withTone(() => api.type);
    expect(seen).toBe("ambient");
    expect(api.type).toBe("auto");
    api.type = "playback";
    await s.withTone(() => undefined);
    expect(api.type, "whatever was there before comes back").toBe("playback");
  });
  it("overlapping tones restore once, after the last one", async () => {
    const api = { type: "auto" };
    const s = createAudioSession(() => api);
    const a = s.beginTone(), b = s.beginTone();
    a(); expect(api.type).toBe("ambient");
    a(); // idempotent
    b(); expect(api.type).toBe("auto");
  });
  it("a tone during BASHT's voice never changes the voice session; a voice started during a tone is not clobbered", () => {
    const api = { type: "auto" };
    const s = createAudioSession(() => api);
    s.enterVoice("playback");
    const r = s.beginTone(); expect(api.type).toBe("playback"); r(); expect(api.type).toBe("playback");
    s.leaveVoice(); expect(api.type).toBe("auto");
    const t = s.beginTone(); expect(api.type).toBe("ambient");
    s.enterVoice("play-and-record"); expect(api.type).toBe("play-and-record");
    t(); expect(api.type, "the tone ending does not undo the voice").toBe("play-and-record");
    s.leaveVoice(); expect(api.type).toBe("auto");
    s.leaveVoice(); expect(api.type).toBe("auto");
  });
  it("never throws where the API is missing or refuses a value", async () => {
    const none = createAudioSession(() => null);
    expect(none.supported()).toBe(false);
    expect(none.enterVoice()).toBe(false);
    expect(await none.withTone(() => 1)).toBe(1);
    expect(() => none.leaveVoice()).not.toThrow();
    const boom = createAudioSession(() => { throw new Error("no"); });
    expect(boom.supported()).toBe(false);
    expect(() => boom.beginTone()()).not.toThrow();
    const strict = { get type() { return "auto"; }, set type(_v: string) { throw new TypeError("unsupported"); } };
    const s = createAudioSession(() => strict);
    expect(s.enterVoice("playback")).toBe(false);
    expect(() => s.leaveVoice()).not.toThrow();
  });
});

describe("the page-wide helpers (navigator.audioSession)", () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  beforeEach(() => { Object.defineProperty(nav, "audioSession", { value: { type: "auto" }, configurable: true, writable: true }); });
  afterEach(() => { leaveVoiceSession(); delete nav.audioSession; });
  it("enterVoiceSession / leaveVoiceSession set and restore it; withToneSession leaves the page in auto", async () => {
    const api = nav.audioSession as { type: string };
    expect(enterVoiceSession("playback")).toBe(true); expect(api.type).toBe("playback");
    leaveVoiceSession(); expect(api.type).toBe("auto");
    expect(await withToneSession(() => api.type)).toBe("ambient");
    expect(api.type).toBe("auto");
  });
  it("without the API they are no-ops", () => {
    delete nav.audioSession;
    expect(enterVoiceSession()).toBe(false);
    expect(() => leaveVoiceSession()).not.toThrow();
  });
});

describe("notification tones never leave the page muted by the silent switch", () => {
  afterEach(() => vi.useRealTimers());
  const el = (result: "ok" | "blocked" = "ok") => {
    const ls = new Map<string, () => void>();
    const a = {
      src: "", volume: 1, preload: "", currentTime: 0, pause: vi.fn(),
      async play() { if (result === "blocked") throw Object.assign(new Error("x"), { name: "NotAllowedError" }); },
      addEventListener: (t: string, cb: () => void) => { ls.set(t, cb); }, removeEventListener: (t: string) => { ls.delete(t); },
      fire: (t: string) => ls.get(t)?.(),
    };
    return a;
  };
  it("ambient while the tone plays, the previous type once it ends", async () => {
    const session = { type: "auto" }; const a = el();
    const p = createAudioPlayer({ create: () => a, session, emit: () => {} });
    expect(await p.play("reminder-bell", { volume: 1 })).toBe("played");
    expect(session.type).toBe("ambient");
    a.fire("ended");
    expect(session.type).toBe("auto");
  });
  it("restored at the latest after holdMs if `ended` never comes; immediately when blocked", async () => {
    vi.useFakeTimers();
    const session = { type: "auto" };
    const p = createAudioPlayer({ create: () => ({ src: "", volume: 1, preload: "", currentTime: 0, pause() {}, async play() {} }), session, emit: () => {}, holdMs: 3000 });
    await p.play("success-tone", { volume: 1 });
    expect(session.type).toBe("ambient");
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.type).toBe("auto");
    const b = createAudioPlayer({ create: () => el("blocked"), session, emit: () => {} });
    expect(await b.play("success-tone", { volume: 1 })).toBe("blocked");
    expect(session.type).toBe("auto");
  });
  it("stop() releases the tone session at once", async () => {
    const session = { type: "auto" };
    const p = createAudioPlayer({ create: () => el(), session, emit: () => {} });
    await p.play("notification-soft", { volume: 1 });
    p.stop();
    expect(session.type).toBe("auto");
  });
  it("no code path sets a permanent ambient session any more", () => {
    const src = readFileSync(join(WEB, "lib/audio.ts"), "utf8");
    expect(src.match(/setType\("ambient"\)/g)).toHaveLength(2); // beginTone + leaveVoice-while-a-tone-plays, nothing else
    expect(src).not.toMatch(/\.type = "ambient"|sessionSet/);
  });
});
