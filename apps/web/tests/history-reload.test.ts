import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reloadCurrentView } from "@/lib/history-reload";
import { rowsAfterLoad } from "@/features/chat/use-basht";
import type { BashtMessage } from "@/lib/basht-client";

const row = (id: string, available: boolean): BashtMessage => ({ role: "assistant", text: id, at: 1, id, media: [{ kind: "image", name: id + ".png", ref: "a".repeat(32), available }] });

describe("a picture's retry never leaves the search window (it was a batch-2 addition: there was no retry before)", () => {
  it("in a search window the window around the picked message is re-read, its media refreshed in place, and the newest page is NOT loaded", async () => {
    const loadLatest = vi.fn(); const fetchAround = vi.fn(async () => ({ messages: [row("m1", true), row("m2", true)] }));
    const out = await reloadCurrentView({ windowed: true, anchor: "m2", fetchAround, loadLatest });
    expect(fetchAround).toHaveBeenCalledWith("m2");
    expect(loadLatest).not.toHaveBeenCalled();                       // never navigates back to the latest messages
    expect(out).toEqual({ kind: "window", messages: [row("m1", true), row("m2", true)] }); // media metadata refreshed (available now)
  });
  it("on the newest page it is the ordinary load (what is paged in is kept by it)", async () => {
    const loadLatest = vi.fn(); const fetchAround = vi.fn();
    expect(await reloadCurrentView({ windowed: false, anchor: null, fetchAround, loadLatest })).toEqual({ kind: "latest" });
    expect(loadLatest).toHaveBeenCalledTimes(1); expect(fetchAround).not.toHaveBeenCalled();
    // a stale anchor without a window is also the ordinary path
    await reloadCurrentView({ windowed: false, anchor: "m2", fetchAround, loadLatest }); expect(fetchAround).not.toHaveBeenCalled();
  });
  it("a window without an anchor (should not happen) falls back to the ordinary load rather than guessing", async () => {
    const loadLatest = vi.fn(); const fetchAround = vi.fn();
    await reloadCurrentView({ windowed: true, anchor: null, fetchAround, loadLatest });
    expect(loadLatest).toHaveBeenCalledTimes(1); expect(fetchAround).not.toHaveBeenCalled();
  });
  it("a failed window re-read rejects (the caller shows the error) and loads nothing else", async () => {
    const loadLatest = vi.fn();
    await expect(reloadCurrentView({ windowed: true, anchor: "m2", fetchAround: async () => { throw new Error("net"); }, loadLatest })).rejects.toThrow("net");
    expect(loadLatest).not.toHaveBeenCalled();
  });
  it("why the window path matters: the ordinary latest-page load DOES leave a window (rowsAfterLoad), so it must not be used from one", () => {
    expect(rowsAfterLoad(true, [], null, [row("new", true)]).leftWindow).toBe(true);
    expect(rowsAfterLoad(false, [], null, [row("new", true)]).leftWindow).toBe(false);
  });
  it("wiring (source contract): the hook's reload goes through reloadCurrentView, and the window's anchor is recorded when a hit is opened and cleared when the window is left", () => {
    const src = readFileSync(join(resolve(__dirname, ".."), "features/chat/use-basht.ts"), "utf8");
    expect(src).toMatch(/const reload = useCallback\(async \(\) => \{[\s\S]*?reloadCurrentView\(\{ windowed: windowedRef\.current, anchor: windowAnchor\.current/);
    expect(src).not.toMatch(/const reload = useCallback\(\(\) => \{ if \(keyRef\.current\) void load/);
    expect(src).toContain("windowedRef.current = true; windowAnchor.current = messageId;");
    expect(src).toMatch(/leftWindow\) \{ windowedRef\.current = false; windowAnchor\.current = null;/);
    // a window refresh keeps the focus: nothing in reload touches it
    const body = src.slice(src.indexOf("const reload = useCallback"), src.indexOf("const backToLatest"));
    expect(body).not.toContain("setFocusId"); expect(body).not.toContain("viewGen.current++");
  });
});
