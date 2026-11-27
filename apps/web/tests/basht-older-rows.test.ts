import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reconcileOlder, rowsAfterLoad } from "@/features/chat/use-basht";
import type { BashtMessage } from "@/lib/basht-client";

const rows = (from: number, to: number): BashtMessage[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ role: (from + i) % 2 ? "user" : "assistant", text: `m${from + i}`, at: from + i, id: `msg-${String(from + i).padStart(4, "0")}` }));

// Review (Codex, round 4): after «عرض الرسائل السابقة», a new turn must not make rows between the earlier pages and the newest
// page disappear.
describe("earlier rows stay contiguous after a refresh", () => {
  it("rows that slid off the newest page are kept between the earlier rows and the new page", () => {
    const older = rows(1, 50); const prev = rows(51, 100); const next = rows(53, 102);
    const kept = reconcileOlder(older, prev, next);
    expect(kept.map((m) => m.at)).toEqual(rows(1, 52).map((m) => m.at));
    // what the screen shows: earlier rows + the new page, every row once, in order
    const shown = [...kept, ...next];
    expect(shown.map((m) => m.at)).toEqual(rows(1, 102).map((m) => m.at));
  });
  it("nothing changes without earlier rows, or when no row slid off", () => {
    const none: BashtMessage[] = [];
    expect(reconcileOlder(none, rows(51, 100), rows(53, 102))).toBe(none);
    const older = rows(1, 50);
    expect(reconcileOlder(older, rows(51, 100), rows(51, 100))).toBe(older);
    expect(reconcileOlder(older, null, rows(51, 100))).toBe(older);
  });
  it("the hook reconciles on every load and resets the references when the conversation changes", () => {
    const src = readFileSync(new URL("../features/chat/use-basht.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const next = rowsAfterLoad\(windowedRef\.current, olderRowsRef\.current, messagesRef\.current, page\.messages\);/);
    expect(src).toMatch(/if \(next\.leftWindow\) \{ windowedRef\.current = false; viewGen\.current\+\+; setFocusId\(null\); \}/);
    expect(src).toMatch(/olderRowsRef\.current = \[\]; windowedRef\.current = true;/); // opening a search window marks it
    expect(src).toMatch(/messagesRef\.current = null; olderRowsRef\.current = \[\];/);
  });

  // Review (Codex, round 6): a turn finishing while a search window is open must not stitch the window onto the newest page
  it("leaving a search window resets the anchored state: only the newest page, no gap-hiding stitch", () => {
    const olderInWindow = rows(1, 50); const windowRows = rows(51, 100); const newest = rows(151, 200);
    const r = rowsAfterLoad(true, olderInWindow, windowRows, newest);
    expect(r.leftWindow).toBe(true);
    expect(r.olderRows).toEqual([]); // the screen shows 151–200 with the newest page's own cursor, never 1–100 + 151–200
    const fromLatest = rowsAfterLoad(false, rows(1, 50), rows(51, 100), rows(53, 102));
    expect(fromLatest.leftWindow).toBe(false);
    expect(fromLatest.olderRows.map((m) => m.at)).toEqual(rows(1, 52).map((m) => m.at));
  });
});
