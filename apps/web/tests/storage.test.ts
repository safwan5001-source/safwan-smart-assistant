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
