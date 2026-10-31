import { describe, expect, it } from "vitest";
import { parseTasks, parseThreads } from "@/lib/domain";

describe("parseTasks", () => {
  it("keeps legacy v1 tasks untouched", () => {
    const legacy = [{ id: "a", title: "x", done: false, created: 1, priority: "high", due: "2026-01-02" }];
    expect(parseTasks(legacy)).toEqual(legacy);
  });
  it("drops malformed entries and bad enum/date values instead of throwing", () => {
    const out = parseTasks([null, 5, { id: 1 }, { id: "a", title: "t", done: false, created: 1, priority: "urgent", due: "tomorrow" }]);
    expect(out).toEqual([{ id: "a", title: "t", done: false, created: 1 }]);
  });
  it("returns [] for non-arrays", () => { expect(parseTasks({})).toEqual([]); expect(parseTasks(undefined)).toEqual([]); });
});

describe("parseThreads", () => {
  it("keeps legacy threads (messages without role) and filters broken messages/attachments", () => {
    const out = parseThreads([{ id: "t", title: "ت", created: 5, archived: true, messages: [
      { id: "m1", text: "hi", created: 1, attachments: [{ id: "f", name: "n" }, { id: 3 }] }, { nope: true }] }]);
    expect(out).toHaveLength(1);
    expect(out[0].archived).toBe(true);
    expect(out[0].messages).toEqual([{ id: "m1", text: "hi", created: 1, attachments: [{ id: "f", name: "n" }] }]);
  });
  it("skips non-thread values", () => { expect(parseThreads([{ id: "x" }, 1])).toEqual([]); });
});
