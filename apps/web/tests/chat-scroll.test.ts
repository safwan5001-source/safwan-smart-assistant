import { describe, expect, it } from "vitest";
import { focusKey, focusTarget, newFocusScroll, nextScroll } from "../lib/chat-scroll";

const all = () => true;

// Review (Codex, integration PR): while a reply streamed after «تحميل الأقدم», every token re-scrolled to the focused row.
describe("chat log scroll: a focus request is honoured once", () => {
  it("scrolls to a new focus once; later renders (a streaming reply) leave the owner where they are", () => {
    const s = newFocusScroll();
    expect(nextScroll(s, "a", all, false)).toEqual({ to: "focus", id: "a" });
    for (let i = 0; i < 5; i++) expect(nextScroll(s, "a", all, false)).toBeNull();
  });
  it("still follows the end when the owner scrolls back to the bottom while a focus is set", () => {
    const s = newFocusScroll();
    nextScroll(s, "a", all, false);
    expect(nextScroll(s, "a", all, true)).toEqual({ to: "bottom" });
  });
  // Lab (integration e2e): after «محادثة جديدة» the first row was the reset divider (no anchor); a focus that never appears must
  // not hold the log: it is dropped and following works as without a focus.
  it("drops a focus whose row is not on screen instead of holding the log", () => {
    const s = newFocusScroll();
    expect(nextScroll(s, "a", () => false, true)).toEqual({ to: "bottom" });
    expect(nextScroll(s, "a", () => true, false)).toBeNull(); // not re-tried later
    expect(nextScroll(s, "a", () => true, true)).toEqual({ to: "bottom" });
  });
  it("a different focus request scrolls again", () => {
    const s = newFocusScroll();
    nextScroll(s, "a", all, false);
    expect(nextScroll(s, "b", all, false)).toEqual({ to: "focus", id: "b" });
  });
  it("clearing the focus returns to the end even when the owner was not following; no focus + following follows", () => {
    const s = newFocusScroll();
    nextScroll(s, "a", all, false);
    expect(nextScroll(s, null, all, false)).toEqual({ to: "bottom" });
    expect(nextScroll(s, null, all, false)).toBeNull();
    expect(nextScroll(s, null, all, true)).toEqual({ to: "bottom" });
  });
});

describe("the chat screen uses the once-only focus scroll", () => {
  it("scrolls into view only on nextScroll's focus decision", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../features/chat/chat-screen.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const next = nextScroll\(focusScroll\.current, focusKey\(basht\.focusId \?\? null, basht\.focusReq\),/);
    expect(src.match(/scrollIntoView\(/g)?.length).toBe(1);
    expect(src).toMatch(/if \(next\?\.to === "focus"\) document\.getElementById\("m-" \+ focusTarget\(next\.id\)\)\?\.scrollIntoView/);
    expect(src).toMatch(/view, basht\.focusId, basht\.focusReq\]\);/);
  });
});

// Review (Codex, round 13): picking the same search hit again (after scrolling away) did not scroll back to it.
describe("every deliberate focus request scrolls once, the same message included", () => {
  it("a repeated pick of the same message is a new request; renders in between are not", () => {
    const s = newFocusScroll();
    const all = () => true;
    expect(nextScroll(s, focusKey("a", 1), all, false)).toEqual({ to: "focus", id: "1:a" });
    expect(nextScroll(s, focusKey("a", 1), all, false)).toBeNull();
    expect(nextScroll(s, focusKey("a", 2), all, false)).toEqual({ to: "focus", id: "2:a" });
    expect(focusTarget("2:a")).toBe("a");
    expect(focusTarget("12:msg:with:colons")).toBe("msg:with:colons");
    expect(focusKey(null, 3)).toBeNull();
  });
  it("the hook numbers every pick and earlier page", async () => {
    const { readFileSync } = await import("node:fs");
    const hook = readFileSync(new URL("../features/chat/use-basht.ts", import.meta.url), "utf8");
    expect(hook).toMatch(/const requestFocus = useCallback\(\(id: string\) => \{ setFocusId\(id\); setFocusReq\(\(n\) => n \+ 1\); \}, \[\]\);/);
    expect(hook.match(/requestFocus\((firstShown|messageId)\)/g)?.length).toBe(3);
    expect(hook).toMatch(/focusId, focusReq, setFocusId/);
  });
});
