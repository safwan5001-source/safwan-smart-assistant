import { beforeEach, describe, expect, it } from "vitest";
import { installBrowser } from "./setup";
import { createStore, jsonCodec } from "@/lib/storage";
import { parseTasks, type Task } from "@/lib/domain";

describe("createStore", () => {
  beforeEach(() => { installBrowser(); });
  const make = (key = "k") => createStore<Task[]>({ key, fallback: [], ...jsonCodec(parseTasks, [] as Task[]) });

  it("returns a stable snapshot until data changes (required by useSyncExternalStore)", () => {
    const s = make();
    expect(s.getSnapshot()).toBe(s.getSnapshot());
    s.set([{ id: "1", title: "t", done: false, created: 1 }]);
    const a = s.getSnapshot();
    expect(a).toBe(s.getSnapshot());
    expect(a[0].title).toBe("t");
  });
  it("notifies subscribers and supports functional updates", () => {
    const s = make(); let n = 0;
    const off = s.subscribe(() => n++);
    s.set((p) => [...p, { id: "1", title: "a", done: false, created: 1 }]);
    s.set((p) => [...p, { id: "2", title: "b", done: false, created: 2 }]);
    off();
    expect(n).toBe(2); expect(s.getSnapshot()).toHaveLength(2);
  });
  it("survives corrupted stored JSON", () => {
    const { data } = installBrowser(); data.set("bad", "{not json");
    expect(make("bad").getSnapshot()).toEqual([]);
  });
  it("falls back to memory (with an error flag) when storage is blocked", () => {
    installBrowser({ blockedStorage: true });
    const s = make("blocked");
    s.set([{ id: "1", title: "t", done: false, created: 1 }]);
    expect(s.getSnapshot()).toHaveLength(1);
    expect(s.getError()).toMatch(/تعذر الحفظ/);
  });
  it("reset clears the value", () => {
    const s = make(); s.set([{ id: "1", title: "t", done: false, created: 1 }]); s.reset();
    expect(s.getSnapshot()).toEqual([]);
  });
});

describe("quota exhaustion", () => {
  it("keeps the newest in-memory value when the real write is rejected but the probe succeeds", () => {
    const { data } = installBrowser();
    const win = (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window;
    const realSet = win.localStorage.setItem.bind(win.localStorage);
    let full = false;
    win.localStorage.setItem = (k, v) => { if (full && k === "quota") throw new Error("QuotaExceededError"); realSet(k, v); };
    const s = createStore<Task[]>({ key: "quota", fallback: [], ...jsonCodec(parseTasks, [] as Task[]) });
    s.set([{ id: "1", title: "old", done: false, created: 1 }]);
    full = true;
    s.set((p) => [...p, { id: "2", title: "new", done: false, created: 2 }]);
    expect(s.getSnapshot().map((t) => t.id)).toEqual(["1", "2"]); // not reverted to the stale persisted ["1"]
    expect(s.getError()).toMatch(/تعذر الحفظ/);
    expect(JSON.parse(data.get("quota")!)).toHaveLength(1);
    full = false;
    s.set((p) => [...p, { id: "3", title: "x", done: false, created: 3 }]);
    expect(s.getError()).toBeNull();
    expect(JSON.parse(data.get("quota")!)).toHaveLength(3);
  });
});
