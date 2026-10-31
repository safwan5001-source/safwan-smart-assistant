import { beforeEach, describe, expect, it } from "vitest";
import { installBrowser } from "./setup";
import { runCommand } from "@/lib/commands";
import { KEYS, tasksStore, threadsStore } from "@/lib/stores";

// Exactly the shapes written by v1 (before this platform work).
const LEGACY_TASKS = [
  { id: "t1", title: "مهمة قديمة", done: false, created: 1700000000000, priority: "high", due: "2026-01-15" },
  { id: "t2", title: "مكتملة", done: true, created: 1690000000000 },
];
const LEGACY_CHATS = [
  { id: "c1", title: "محادثة قديمة", created: 1700000000000, archived: true,
    messages: [{ id: "m1", text: "رسالة قديمة", created: 1700000000001, attachments: [{ id: "f1", name: "فاتورة.pdf" }] }] },
];

describe("data saved by earlier versions is preserved", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    ({ data } = installBrowser());
    tasksStore.reset(); threadsStore.reset();
    data.set(KEYS.tasks, JSON.stringify(LEGACY_TASKS));
    data.set(KEYS.chats, JSON.stringify(LEGACY_CHATS));
  });

  it("reads legacy tasks and chats unchanged", () => {
    expect(tasksStore.getSnapshot()).toEqual(LEGACY_TASKS);
    expect(threadsStore.getSnapshot()).toEqual(LEGACY_CHATS);
  });

  it("keeps every legacy record (and field) after new writes", async () => {
    await runCommand("tasks.add", { title: "جديدة" });
    await runCommand("tasks.toggle", { id: "t1" });
    await runCommand("chat.send", { threadId: "c1", text: "رد جديد" });
    await runCommand("chat.send", { threadId: null, text: "محادثة جديدة" });
    const tasks = JSON.parse(data.get(KEYS.tasks)!);
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(tasks.find((t: { id: string }) => t.id === "t2")).toEqual(LEGACY_TASKS[1]);
    expect(tasks.find((t: { id: string }) => t.id === "t1")).toMatchObject({ title: "مهمة قديمة", priority: "high", due: "2026-01-15", done: true });
    const chats = JSON.parse(data.get(KEYS.chats)!);
    const old = chats.find((c: { id: string }) => c.id === "c1");
    expect(old.archived).toBe(true);
    expect(old.messages[0]).toEqual(LEGACY_CHATS[0].messages[0]); // attachment reference intact
    expect(old.messages).toHaveLength(2);
  });

  it("never wipes data on routine commands, failed commands or denied commands", async () => {
    await runCommand("tasks.add", { title: "  " });                       // invalid
    await runCommand("tasks.add", { title: "x" }, { mode: "review" });     // denied
    await runCommand("tasks.clear_completed", {});                          // needs approval
    await runCommand("data.erase_all", {}, { origin: "assistant", approved: true }); // assistant can't self-approve
    expect(tasksStore.getSnapshot()).toEqual(LEGACY_TASKS);
    expect(threadsStore.getSnapshot()).toEqual(LEGACY_CHATS);
  });

  it("an unreadable/corrupt value never overwrites itself silently on read", () => {
    data.set(KEYS.tasks, "{corrupt");
    expect(tasksStore.getSnapshot()).toEqual([]);
    expect(data.get(KEYS.tasks)).toBe("{corrupt"); // reading alone does not destroy the raw value
  });
});
