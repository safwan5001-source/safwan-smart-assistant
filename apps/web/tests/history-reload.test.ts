import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { patchRowMedia, refreshInto, refreshMessageMedia } from "@/lib/history-reload";
import type { BashtMedia, BashtMessage } from "@/lib/basht-client";

const media = (available: boolean): BashtMedia[] => [{ kind: "image", name: "p.png", ref: "a".repeat(32), mime: "image/png", available }];
const row = (id: string, available = false, extra: Partial<BashtMessage> = {}): BashtMessage => ({ role: "assistant", text: "t-" + id, at: 1, id, media: media(available), ...extra });

/** The screen's state holders, like the hook's: the rows of the newest page / window, and the rows paged in above them. */
function screen(messages: BashtMessage[] | null, olderRows: BashtMessage[]) {
  const st = { messages, olderRows, focusId: "keep-me", cursor: "cursor-1", windowed: true };
  return { st,
    setMessages: (f: (m: BashtMessage[] | null) => BashtMessage[] | null) => { st.messages = f(st.messages); },
    setOlderRows: (f: (o: BashtMessage[]) => BashtMessage[]) => { st.olderRows = f(st.olderRows); } };
}
const run = (s: ReturnType<typeof screen>, id: string | null | undefined, page: BashtMessage[], gen = { start: 1, now: 1 }) => {
  const fetchAround = vi.fn(async (_id: string) => ({ messages: page }));
  return { fetchAround, done: refreshInto({ id, fetchAround, startedAt: gen.start, now: () => gen.now, setMessages: s.setMessages, setOlderRows: s.setOlderRows }) };
};

describe("one rule: a picture's retry refreshes the affected message wherever it lives, and never changes the view", () => {
  const fresh = (id: string) => [row("other", true, { text: "NEWER TEXT MUST NOT LEAK" }), row(id, true, { text: "FRESH TEXT: only the media is taken" })];

  it("a message on the NEWEST PAGE: its media is refreshed (available now); every other row is untouched (same objects)", async () => {
    const s = screen([row("a"), row("b"), row("c")], []);
    const before = [...s.st.messages!];
    const { fetchAround, done } = run(s, "b", fresh("b"));
    expect(await done).toBe("refreshed");
    expect(fetchAround).toHaveBeenCalledWith("b");
    expect(s.st.messages![1].media).toEqual(media(true));
    expect(s.st.messages![1].text).toBe("t-b");                                  // only the media is replaced
    expect(s.st.messages![0]).toBe(before[0]); expect(s.st.messages![2]).toBe(before[2]);
  });

  it("a message in a SEARCH WINDOW: refreshed in place; the window, focus and cursor are exactly as they were", async () => {
    const s = screen([row("w1"), row("hit"), row("w3")], []);
    const snapshot = { focusId: s.st.focusId, cursor: s.st.cursor, windowed: s.st.windowed, ids: s.st.messages!.map((m) => m.id) };
    expect(await run(s, "hit", fresh("hit")).done).toBe("refreshed");
    expect(s.st.messages![1].media).toEqual(media(true));
    expect({ focusId: s.st.focusId, cursor: s.st.cursor, windowed: s.st.windowed, ids: s.st.messages!.map((m) => m.id) }).toEqual(snapshot); // the window is the same window
  });

  it("a message PAGED IN through «عرض الرسائل السابقة» (olderRows): refreshed there too — it stays unavailable no longer", async () => {
    const s = screen([row("n1", true), row("n2", true)], [row("old1"), row("old2")]);
    const newest = [...s.st.messages!];
    expect(await run(s, "old2", fresh("old2")).done).toBe("refreshed");
    expect(s.st.olderRows[1].media).toEqual(media(true));
    expect(s.st.olderRows[0].media).toEqual(media(false)); // its neighbour is untouched
    expect(s.st.messages).toEqual(newest);                  // the newest rows are unchanged
    expect(s.st.olderRows.map((m) => m.id)).toEqual(["old1", "old2"]); // paged-in extent unchanged
  });

  it("older rows paged in WHILE a search window is open: refreshed in olderRows, the window untouched", async () => {
    const s = screen([row("w1"), row("hit")], [row("above1"), row("above2")]);
    expect(await run(s, "above1", fresh("above1")).done).toBe("refreshed");
    expect(s.st.olderRows[0].media).toEqual(media(true));
    expect(s.st.messages!.map((m) => m.media)).toEqual([media(false), media(false)]);
  });

  it("a message present in BOTH lists (a row that slid between pages) is refreshed in both", async () => {
    const s = screen([row("dup")], [row("dup")]);
    await run(s, "dup", fresh("dup")).done;
    expect(s.st.messages![0].media).toEqual(media(true)); expect(s.st.olderRows[0].media).toEqual(media(true));
  });

  it("nothing changes when it cannot refresh: no id (the caller falls back), the engine no longer returns the row, or a load started meanwhile", async () => {
    const s = screen([row("a")], [row("o")]);
    const m0 = s.st.messages, o0 = s.st.olderRows;
    expect(await run(s, null, []).done).toBe("no-id");
    expect(await run(s, undefined, []).done).toBe("no-id");
    expect(await run(s, "a", [row("elsewhere", true)]).done).toBe("gone");
    expect(await run(s, "a", fresh("a"), { start: 1, now: 2 }).done).toBe("stale");
    expect(s.st.messages).toBe(m0); expect(s.st.olderRows).toBe(o0);   // not even a new array
  });

  it("an id that is on no list changes no state (the same arrays come back)", async () => {
    const s = screen([row("a")], [row("o")]);
    const m0 = s.st.messages, o0 = s.st.olderRows;
    expect(await run(s, "zzz999", fresh("zzz999")).done).toBe("refreshed");
    expect(s.st.messages).toBe(m0); expect(s.st.olderRows).toBe(o0);
  });

  it("a failed read rejects (the caller shows the error) and changes nothing", async () => {
    const s = screen([row("a")], []); const m0 = s.st.messages;
    await expect(refreshInto({ id: "a", fetchAround: async () => { throw new Error("net"); }, startedAt: 1, now: () => 1, setMessages: s.setMessages, setOlderRows: s.setOlderRows })).rejects.toThrow("net");
    expect(s.st.messages).toBe(m0);
  });

  it("helpers: patchRowMedia replaces only the media; refreshMessageMedia needs an id", async () => {
    const rows = [row("a"), row("b")];
    const out = patchRowMedia(rows, "b", { media: media(true) });
    expect(out[1]).toMatchObject({ id: "b", text: "t-b", media: media(true) }); expect(out[0]).toBe(rows[0]); expect(patchRowMedia(rows, "x", { media: [] })).toBe(rows);
    expect(await refreshMessageMedia(null, async () => ({ messages: [] }))).toBeNull();
  });

  it("wiring (source contract): the tile's retry passes ITS message id; the screen refreshes that message; a row without an id falls back to the newest-page load only when no window is open; the hook never resets the view here", () => {
    const WEB = resolve(__dirname, "..");
    const hook = readFileSync(join(WEB, "features/chat/use-basht.ts"), "utf8");
    const body = hook.slice(hook.indexOf("const refreshMedia = useCallback"), hook.indexOf("const backToLatest"));
    expect(body).toContain("refreshInto({ id: messageId");
    expect(body).toMatch(/out === "no-id" && !windowedRef\.current\) void load\(k, true\)/);
    for (const forbidden of ["setFocusId", "viewGen.current++", "setOlder(", "setWindowed", "olderRowsRef.current = []"]) expect(body).not.toContain(forbidden);
    expect(readFileSync(join(WEB, "features/chat/message-media.tsx"), "utf8")).toContain("onRetry ? () => onRetry(messageId) : undefined");
    expect(readFileSync(join(WEB, "features/chat/chat-screen.tsx"), "utf8")).toMatch(/const retryMedia = useCallback\(\(messageId\?: string \| null\) => \{ localMedia\.retry\(\); void basht\.refreshMedia\(messageId\); \}/);
  });
});
