import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const hook = readFileSync(new URL("../features/chat/use-basht.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../features/chat/chat-screen.tsx", import.meta.url), "utf8");
const body = (src: string, start: RegExp) => { const i = src.search(start); expect(i, String(start)).toBeGreaterThan(-1); return src.slice(i, i + 900); };

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
    expect(fn).toMatch(/if \(keyRef\.current !== k \|\| view !== viewGen\.current\) return;/);
    expect(fn.search(/view !== viewGen\.current/)).toBeLessThan(fn.search(/setOlderRows\(/));
  });
  it("refresh / «العودة إلى الأحدث», opening a conversation, «محادثة جديدة» and a search window start a new view", () => {
    expect(body(hook, /const refresh = useCallback/)).toMatch(/viewGen\.current\+\+/);
    expect(hook).toMatch(/const backToLatest = useCallback\(\(\) => \{ setFocusId\(null\); refresh\(\); \}/);
    expect(body(hook, /const newConversation = useCallback/)).toMatch(/await bashtClient\.newConversation\(\);\s*viewGen\.current\+\+;/);
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
