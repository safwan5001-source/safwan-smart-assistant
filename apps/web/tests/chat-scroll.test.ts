import { describe, expect, it } from "vitest";
import { newFocusScroll, nextScroll } from "../lib/chat-scroll";

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
  it("waits for a focused message that is not on screen yet, without jumping to the end meanwhile", () => {
    const s = newFocusScroll();
    let shown = false;
    expect(nextScroll(s, "a", () => shown, true)).toBeNull();
    shown = true;
    expect(nextScroll(s, "a", () => shown, true)).toEqual({ to: "focus", id: "a" });
    expect(nextScroll(s, "a", () => shown, false)).toBeNull();
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
    expect(src).toMatch(/const next = nextScroll\(focusScroll\.current, basht\.focusId \?\? null,/);
    expect(src.match(/scrollIntoView\(/g)?.length).toBe(1);
    expect(src).toMatch(/if \(next\?\.to === "focus"\) \{ stick\.current = false; document\.getElementById\("m-" \+ next\.id\)\?\.scrollIntoView/);
  });
});
