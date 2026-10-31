import { beforeEach, describe, expect, it } from "vitest";
import { installBrowser } from "./setup";
import { runCommand, runQuickCommand } from "@/lib/commands";
import { activityStore, tasksStore, threadsStore } from "@/lib/stores";

beforeEach(() => { installBrowser(); tasksStore.reset(); threadsStore.reset(); activityStore.reset(); });

describe("tasks commands", () => {
  it("adds, toggles, updates and removes", async () => {
    const add = await runCommand("tasks.add", { title: "  مراجعة الفواتير  ", priority: "high", due: "2026-03-01" });
    expect(add.status).toBe("executed");
    const id = tasksStore.getSnapshot()[0].id;
    expect(tasksStore.getSnapshot()[0]).toMatchObject({ title: "مراجعة الفواتير", priority: "high", done: false });
    await runCommand("tasks.toggle", { id });
    expect(tasksStore.getSnapshot()[0].done).toBe(true);
    expect(tasksStore.getSnapshot()[0].completedAt).toBeTypeOf("number");
    await runCommand("tasks.update", { id, title: "جديد", due: null });
    expect(tasksStore.getSnapshot()[0]).toMatchObject({ title: "جديد" });
    expect(tasksStore.getSnapshot()[0].due).toBeUndefined();
    await runCommand("tasks.remove", { id });
    expect(tasksStore.getSnapshot()).toEqual([]);
  });
  it("rejects empty titles and bad dates without touching data", async () => {
    expect((await runCommand("tasks.add", { title: "   " })).status).toBe("invalid");
    expect((await runCommand("tasks.add", { title: "x", due: "غدا" })).status).toBe("invalid");
    expect((await runCommand("tasks.toggle", { id: "missing" })).status).toBe("invalid");
    expect(tasksStore.getSnapshot()).toEqual([]);
  });
});

describe("permission enforcement in the command layer", () => {
  it("review mode blocks writes", async () => {
    const r = await runCommand("tasks.add", { title: "x" }, { mode: "review" });
    expect(r.status).toBe("denied");
    expect(tasksStore.getSnapshot()).toEqual([]);
  });
  it("approve mode holds writes until a user approves", async () => {
    expect((await runCommand("tasks.add", { title: "x" }, { mode: "approve" })).status).toBe("approval_required");
    expect((await runCommand("tasks.add", { title: "x" }, { mode: "approve", approved: true })).status).toBe("executed");
  });
  it("bulk deletion is sensitive: needs explicit approval even in execute mode", async () => {
    await runCommand("tasks.add", { title: "a" });
    const id = tasksStore.getSnapshot()[0].id;
    await runCommand("tasks.toggle", { id });
    expect((await runCommand("tasks.clear_completed", {})).status).toBe("approval_required");
    expect(tasksStore.getSnapshot()).toHaveLength(1);
    const ok = await runCommand("tasks.clear_completed", {}, { approved: true });
    expect(ok).toEqual({ status: "executed", data: 1 });
  });
  it("the assistant can never approve its own sensitive action", async () => {
    await runCommand("tasks.add", { title: "a" });
    const r = await runCommand("tasks.clear_completed", {}, { origin: "assistant", mode: "execute", approved: true });
    expect(r.status).toBe("approval_required");
    const wipe = await runCommand("data.erase_all", {}, { origin: "assistant", approved: true });
    expect(wipe.status).toBe("approval_required");
    expect(tasksStore.getSnapshot()).toHaveLength(1);
  });
  it("erase_all wipes data after user approval and leaves no activity trail", async () => {
    await runCommand("tasks.add", { title: "a" });
    await runCommand("chat.send", { threadId: null, text: "hi" });
    expect((await runCommand("data.erase_all", {}, { approved: true })).status).toBe("executed");
    expect(tasksStore.getSnapshot()).toEqual([]);
    expect(threadsStore.getSnapshot()).toEqual([]);
    expect(activityStore.getSnapshot()).toEqual([]);
  });
  it("records activity, including refusals", async () => {
    await runCommand("tasks.add", { title: "a" });
    await runCommand("tasks.add", { title: "b" }, { mode: "review" });
    expect(activityStore.getSnapshot().map((a) => a.status)).toEqual(["denied", "executed"]);
  });
});

describe("chat commands", () => {
  it("creates a thread on first send, titles it, then appends", async () => {
    const first = await runCommand("chat.send", { threadId: null, text: "مرحباً بك" });
    expect(first.status).toBe("executed");
    const id = threadsStore.getSnapshot()[0].id;
    await runCommand("chat.send", { threadId: id, text: "ثانية" });
    const t = threadsStore.getSnapshot()[0];
    expect(t.title).toBe("مرحباً بك");
    expect(t.messages.map((m) => m.text)).toEqual(["مرحباً بك", "ثانية"]);
  });
  it("rejects empty messages, edits, deletes, renames, archives", async () => {
    expect((await runCommand("chat.send", { threadId: null, text: "  " })).status).toBe("invalid");
    await runCommand("chat.send", { threadId: null, text: "a" });
    const t = threadsStore.getSnapshot()[0];
    await runCommand("chat.message.edit", { threadId: t.id, id: t.messages[0].id, text: "b" });
    expect(threadsStore.getSnapshot()[0].messages[0]).toMatchObject({ text: "b", edited: true });
    await runCommand("chat.rename", { id: t.id, title: "اسم" });
    await runCommand("chat.archive", { id: t.id });
    expect(threadsStore.getSnapshot()[0]).toMatchObject({ title: "اسم", archived: true });
    await runCommand("chat.message.remove", { threadId: t.id, id: t.messages[0].id });
    expect(threadsStore.getSnapshot()[0].messages).toEqual([]);
    await runCommand("chat.remove", { id: t.id });
    expect(threadsStore.getSnapshot()).toEqual([]);
  });
  it("system replies are stored with role=system", async () => {
    await runCommand("chat.send", { threadId: null, text: "x" });
    const id = threadsStore.getSnapshot()[0].id;
    await runCommand("chat.send", { threadId: id, text: "تم", role: "system" });
    expect(threadsStore.getSnapshot()[0].messages[1].role).toBe("system");
  });
});

describe("quick commands (no AI)", () => {
  it("ignores normal text and unknown slashes", async () => {
    expect((await runQuickCommand("مرحبا")).handled).toBe(false);
    expect((await runQuickCommand("/unknown x")).handled).toBe(false);
    expect((await runQuickCommand("/path/to/file")).handled).toBe(false);
  });
  it("/مهمة creates a task through the command layer", async () => {
    const r = await runQuickCommand("/مهمة مراجعة العقد");
    expect(r.handled).toBe(true);
    expect(tasksStore.getSnapshot()[0].title).toBe("مراجعة العقد");
    expect(r.reply).toContain("مراجعة العقد");
  });
  it("/مهمة without a title explains usage and creates nothing", async () => {
    const r = await runQuickCommand("/مهمة");
    expect(r.handled).toBe(true); expect(tasksStore.getSnapshot()).toEqual([]);
  });
  it("help says explicitly that these are not AI", async () => {
    expect((await runQuickCommand("/مساعدة")).reply).toContain("ليست ذكاءً اصطناعياً");
  });
});
