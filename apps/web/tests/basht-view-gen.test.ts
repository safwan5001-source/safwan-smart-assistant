import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const hook = readFileSync(new URL("../features/chat/use-basht.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../features/chat/chat-screen.tsx", import.meta.url), "utf8");
const body = (src: string, start: RegExp) => { const i = src.search(start); expect(i, String(start)).toBeGreaterThan(-1); return src.slice(i, i + 1400); };

// Review (Codex, round 5)
describe("keyboard send respects the photo-preparation barrier", () => {
  it("send() itself returns early while photos are being prepared (Enter calls send() directly)", () => {
    expect(chat).toMatch(/if \(e\.key === "Enter" && !e\.shiftKey && desktop\) \{ e\.preventDefault\(\); void send\(\); \}/);
    const send = body(chat, /const send = async \(\) => \{/);
    const barrier = send.search(/if \(bashtOn && pics\.preparing\) \{ setNotice\([^)]*\); return; \}/);
    const busyLine = send.search(/setBusy\(true\)/);
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(busyLine);
  });
});

describe("an older page for an abandoned history view is dropped", () => {
  it("loadEarlier checks the view generation it started in before applying", () => {
    const fn = body(hook, /const loadEarlier = useCallback\(async \(\) => \{/);
    expect(fn).toMatch(/const view = viewGen\.current;/);
    expect(fn).toMatch(/if \(keyRef\.current !== k \|\| view !== viewGen\.current( \|\| [^)]*\))?\) return;/);
    expect(fn.search(/view !== viewGen\.current/)).toBeLessThan(fn.search(/setOlderRows\(/));
  });
  // Review (Codex, round 8): «عرض الرسائل السابقة» pressed while a search window was loading captured the generation jumpTo had
  // already bumped, so its page landed inside the window. Installing the window starts a new view again.
  it("installing a search window invalidates an older page requested while it loaded", () => {
    const fn = body(hook, /const jumpTo = useCallback/);
    expect(fn).toMatch(/if \(keyRef\.current !== k \|\| gen !== loadGen\.current( \|\| [^)]*)?\) return;\s*viewGen\.current\+\+;[^\n]*\n\s*olderRowsRef\.current = \[\]; windowedRef\.current = true;/);
  });
  it("refresh / «العودة إلى الأحدث», opening a conversation, «محادثة جديدة» and a search window start a new view", () => {
    expect(body(hook, /const refresh = useCallback/)).toMatch(/viewGen\.current\+\+/);
    expect(hook).toMatch(/const backToLatest = useCallback\(\(\) => \{ setFocusId\(null\); refresh\(\); \}/);
    expect(body(hook, /const newConversation = useCallback/)).toMatch(/if \(keyRef\.current === APP_SESSION_KEY\) \{\s*viewGen\.current\+\+;/);
    expect(body(hook, /const jumpTo = useCallback/)).toMatch(/viewGen\.current\+\+;/);
    expect(hook).toMatch(/viewGen\.current\+\+;\s*windowedRef\.current = false;\s*setMessages\(null\); setOlderRows\(\[\]\)/);
  });
});

// Review (Codex, round 7): a new merged-history array on every render re-ran the screen's scroll effect (each keystroke pulled
// the owner back to the focused message). The merged rows are memoized on the two history arrays only.
describe("the merged history keeps its identity across unrelated renders", () => {
  it("is computed with useMemo([olderRows, messages])", () => {
    expect(hook).toMatch(/const shown = useMemo\(\(\) => \(messages === null \? null : olderRows\.length \? mergeRows\(olderRows, messages\) : messages\), \[olderRows, messages\]\);/);
    expect(hook).toMatch(/messages: shown/);
  });
});

// Review (Codex, round 9): after a refresh started, «عرض الرسائل السابقة» could still use the discarded cursor and land rows
// before a gap paging can never fill. The refresh drops the cursor, and an older page lands only on the cursor it used.
describe("an older page lands only on the cursor it was requested with", () => {
  it("refresh drops the old cursor until the refreshed page installs its own", () => {
    expect(body(hook, /const refresh = useCallback/)).toMatch(/viewGen\.current\+\+; olderRowsRef\.current = \[\]; setOlderRows\(\[\]\); setOlder\(null\);/);
    expect(hook).toMatch(/const setOlder = useCallback\(\(o: Older\) => \{ olderRef\.current = o; setOlderState\(o\); \}, \[\]\);/);
  });
  it("loadEarlier compares its cursor with the one in force before applying", () => {
    const fn = body(hook, /const loadEarlier = useCallback\(async \(\) => \{/);
    expect(fn).toMatch(/const cursor = older;/);
    expect(fn).toMatch(/bashtClient\.historyPage\(k, cursor\)/);
    expect(fn).toMatch(/if \(keyRef\.current !== k \|\| view !== viewGen\.current \|\| !sameOlder\(cursor, olderRef\.current\)\) return;/);
    expect(fn.search(/!sameOlder\(cursor, olderRef\.current\)/)).toBeLessThan(fn.search(/setOlderRows\(/));
  });
  it("sameOlder compares cursors by value", async () => {
    const { sameOlder } = await import("../features/chat/use-basht");
    expect(sameOlder({ offset: 50 }, { offset: 50 })).toBe(true);
    expect(sameOlder({ offset: 50 }, { offset: 52 })).toBe(false);
    expect(sameOlder({ before: "a" }, null)).toBe(false);
    expect(sameOlder(null, null)).toBe(true);
  });
});

// Review (Codex, round 10): «محادثة جديدة» resets the APP conversation; another conversation on screen kept losing its
// earlier rows and cursor (and was not reloaded). The view state is cleared only when the app conversation is on screen.
describe("«محادثة جديدة» leaves another conversation on screen untouched", () => {
  it("clears earlier rows, cursor and focus only inside the app-session branch", () => {
    const fn = body(hook, /const newConversation = useCallback/);
    const branch = fn.search(/if \(keyRef\.current === APP_SESSION_KEY\) \{/);
    expect(branch).toBeGreaterThan(-1);
    for (const re of [/setOlderRows\(\[\]\)/, /setOlder\(null\)/, /setFocusId\(null\)/, /viewGen\.current\+\+/]) {
      const at = fn.search(re);
      expect(at, String(re)).toBeGreaterThan(branch);
    }
  });
});

// Review (Codex, round 11): picking an unloaded hit A, then an already-loaded hit B, let A's window land afterwards and
// replace the history and focus. Every pick (loaded or not) supersedes the earlier ones.
describe("a later search-hit pick supersedes an earlier window request", () => {
  it("jumpTo counts every pick before the on-screen shortcut and checks it before installing a window", () => {
    const fn = body(hook, /const jumpTo = useCallback/);
    const pick = fn.search(/const pick = \+\+jumpGen\.current;/);
    expect(pick).toBeGreaterThan(-1);
    expect(pick).toBeLessThan(fn.search(/\.some\(\(m\) => m\.id === messageId\)\) \{ requestFocus\(messageId\); return; \}/));
    expect(fn).toMatch(/if \(keyRef\.current !== k \|\| gen !== loadGen\.current \|\| pick !== jumpGen\.current\) return;/);
  });
});

// Lab (integration e2e): after «محادثة جديدة» the newest page starts with the reset divider, which has no anchor; «عرض الرسائل
// السابقة» focused it, the focus never resolved and the reading position was lost.
describe("«عرض الرسائل السابقة» keeps the reading position on a row that has an anchor", () => {
  it("picks the first row with an id that is not a reset divider", () => {
    const fn = body(hook, /const loadEarlier = useCallback\(async \(\) => \{/);
    expect(fn).toMatch(/const firstShown = \[\.\.\.olderRows, \.\.\.\(messages \?\? \[\]\)\]\.find\(\(m\) => m\.id && m\.kind !== "reset"\)\?\.id \?\? null;/);
  });
});
