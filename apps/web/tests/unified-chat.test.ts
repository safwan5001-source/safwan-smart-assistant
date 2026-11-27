import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installBrowser } from "./setup";
import { runCommand } from "@/lib/commands";
import { threadsStore } from "@/lib/stores";
import { parseThreads } from "@/lib/domain";
import { agentState } from "@/lib/agent-activity";

const WEB = resolve(__dirname, "..");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");
beforeEach(() => { installBrowser(); threadsStore.reset(); });

describe("U1: one conversation — the app is BASHT", () => {
  it("the conversation has exactly ONE on-device thread for its local events; old threads are the archive", async () => {
    const old = await runCommand("chat.send", { threadId: null, text: "محادثة قديمة" });
    const a = await runCommand("chat.send", { threadId: null, main: true, text: "/مهمة أولى" });
    const b = await runCommand("chat.send", { threadId: null, main: true, text: "رد النظام", role: "system" });
    expect(a.status).toBe("executed"); expect(b.status).toBe("executed");
    const threads = threadsStore.getSnapshot();
    const main = threads.filter((t) => t.main);
    expect(main).toHaveLength(1);
    expect(main[0].messages.map((m) => m.text)).toEqual(["/مهمة أولى", "رد النظام"]);
    expect(threads.find((t) => old.status === "executed" && t.id === old.data)?.main).toBeUndefined();
    // the flag survives a reload; existing data without it parses unchanged
    expect(parseThreads(JSON.parse(JSON.stringify(threads))).filter((t) => t.main)).toHaveLength(1);
    expect(parseThreads([{ id: "x", title: "t", created: 1, messages: [] }])[0].main).toBeUndefined();
  });

  it("the conversation's own thread is never refused by the archive's thread cap (a command that already ran is never left to repeat)", async () => {
    threadsStore.set(Array.from({ length: 500 }, (_, i) => ({ id: "t" + i, title: "t", created: i, messages: [] })));
    expect((await runCommand("chat.send", { threadId: null, text: "سلسلة جديدة" })).status).not.toBe("executed");
    expect((await runCommand("chat.send", { threadId: null, main: true, text: "/مهمة" })).status).toBe("executed");
    expect(threadsStore.getSnapshot().filter((t) => t.main)).toHaveLength(1);
    // save → reload round trip keeps ALL 500 archived conversations plus the main thread
    const reloaded = parseThreads(JSON.parse(JSON.stringify(threadsStore.getSnapshot())));
    expect(reloaded).toHaveLength(501);
    expect(reloaded.filter((t) => !t.main)).toHaveLength(500);
    expect(reloaded.some((t) => t.id === "t499")).toBe(true);
    const chat = src("features/chat/chat-screen.tsx");
    expect(chat).toMatch(/if \(quick\.handled\) \{ setDraft\(""\);/);
  });

  it("a down engine is re-checked automatically and by the conversation's refresh control", () => {
    const chat = src("features/chat/chat-screen.tsx");
    expect(chat).toMatch(/setInterval\(refreshHealth, 20_000\)/);
    expect(chat).toMatch(/onClick=\{\(\) => \{ refreshHealth\(\); basht\.refresh\(\); \}\}/);
  });

  it("agent state follows BASHT (the engine), not Claude; an unreachable engine reads as offline, never as notes", () => {
    const idle = { phase: "idle" as const, at: 0 };
    const on = { server: "online" as const, assistant: false, version: "1", bashtChat: true };
    expect(agentState({ ...on, basht: "connected" }, idle)).toBe("ready");
    expect(agentState({ ...on, basht: "offline" }, idle)).toBe("offline");
    expect(agentState({ ...on, basht: "starting" }, idle)).toBe("offline");
    // without an engine: direct Claude still backs the conversation, or nothing does
    expect(agentState({ ...on, bashtChat: false, basht: "unconfigured", assistant: true }, idle)).toBe("ready");
    expect(agentState({ ...on, bashtChat: false, basht: "unconfigured" }, idle)).toBe("notes");
  });

  it("free text is sent only to a reachable brain, and the draft is cleared only after BASHT accepted the turn", () => {
    const chat = src("features/chat/chat-screen.tsx");
    // refused up front, nothing recorded, draft kept
    expect(chat).toMatch(/if \(!quick\.handled && text && !ready\) \{[\s\S]*?return;\s*\}/);
    expect(chat).toMatch(/try \{ await basht\.send\(text\); setDraft\(""\); \}/);
    // no silent fallback to notes: Claude backs the chat only when NO engine is configured
    expect(chat).toMatch(/const claudeOn = !bashtOn && aiReady\(status\);/);
    expect(chat).not.toMatch(/محادثة جديدة/); // a single conversation: no "new chat"
  });

  it("every entry point lands in the same conversation; the old addresses still work", () => {
    const cfg = src("next.config.ts");
    expect(cfg).toMatch(/source: "\/chat\/basht", destination: "\/chat"/);
    expect(cfg).toMatch(/source: "\/calls", destination: "\/chat\?voice=1"/);
    expect(cfg).not.toMatch(/rewrites/);
    expect(src("features/dashboard/dashboard-screen.tsx")).not.toMatch(/\/chat\/basht/);
    expect(src("features/calls/calls-screen.tsx")).not.toMatch(/href=|next\/link/); // the voice panel hands its text to the composer
  });
});
