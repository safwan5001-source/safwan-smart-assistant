import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowser } from "./setup";
import { runCommand, runQuickCommand } from "@/lib/commands";
import { activityStore, threadsStore } from "@/lib/stores";
import { parseThreads } from "@/lib/domain";
import { createBrowserClient } from "@/lib/browser-client";
import { STEP_IDS } from "@/lib/browser-task";

const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { installBrowser(); threadsStore.reset(); activityStore.reset(); });

describe("/متصفح in the chat", () => {
  it("only offers a card: no network, no task, and the sender is not an assistant", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const q = await runQuickCommand("/متصفح");
    expect(q).toEqual({ handled: true, browserOffer: { url: "https://example.com/" } });
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("refuses disallowed addresses and action requests with an explanation", async () => {
    for (const t of ["/متصفح https://evil.test", "/browse http://169.254.169.254", "/متصفح انقر على زر الدفع", "/browse login to my bank"]) {
      const q = await runQuickCommand(t);
      expect(q.handled).toBe(true); expect(q.browserOffer).toBeUndefined(); expect(q.reply).toBeTruthy();
    }
  });
  it("stores a browser card message and updates only its small reference", async () => {
    const sent = await runCommand("chat.send", { threadId: null, text: "طلب تصفح", role: "system", browser: { url: "https://example.com/", state: "offer" } });
    expect(sent.status).toBe("executed");
    const t = threadsStore.getSnapshot()[0], m = t.messages[0];
    expect(m.browser).toEqual({ url: "https://example.com/", state: "offer" });
    expect((await runCommand("chat.browser.update", { threadId: t.id, id: m.id, patch: { state: "started", taskId: ID } })).status).toBe("executed");
    expect(threadsStore.getSnapshot()[0].messages[0].browser).toEqual({ url: "https://example.com/", state: "started", taskId: ID });
    await runCommand("chat.browser.update", { threadId: t.id, id: m.id, patch: { state: "done", outcome: "succeeded" } });
    expect(threadsStore.getSnapshot()[0].messages[0].browser).toMatchObject({ state: "done", outcome: "succeeded" });
  });
  it("the update cannot change the address or smuggle content", async () => {
    await runCommand("chat.send", { threadId: null, text: "x", role: "system", browser: { url: "https://example.com/", state: "offer" } });
    const t = threadsStore.getSnapshot()[0], m = t.messages[0];
    await runCommand("chat.browser.update", { threadId: t.id, id: m.id, patch: { url: "https://evil.test/", excerpt: "secret", screenshot: "AAAA" } as never });
    expect(threadsStore.getSnapshot()[0].messages[0].browser).toEqual({ url: "https://example.com/", state: "offer" });
    expect((await runCommand("chat.send", { threadId: null, text: "x", browser: { url: "https://evil.test/", state: "offer" } })).status).toBe("invalid");
    expect((await runCommand("chat.browser.update", { threadId: t.id, id: "missing", patch: {} })).status).toBe("invalid");
  });
});

describe("persisted data is sanitised on load", () => {
  const thread = (browser: unknown) => [{ id: "t", title: "t", created: 1, messages: [{ id: "m", text: "x", created: 1, browser }] }];
  it("keeps valid references", () => expect(parseThreads(thread({ url: "https://example.com/", state: "done", outcome: "failed" }))[0].messages[0].browser).toEqual({ url: "https://example.com/", state: "done", outcome: "failed" }));
  it.each([
    [{ url: "https://evil.test/", state: "offer" }], [{ url: "https://example.com/", state: "weird" }], ["x"], [null], [{ state: "offer" }],
  ])("drops tampered references %#", (b) => expect(parseThreads(thread(b))[0].messages[0].browser).toBeUndefined());
  it("never keeps stray fields, bad ids or a resumable card without a task id", () => {
    const ref = parseThreads(thread({ url: "https://example.com/", state: "started", taskId: "../x", excerpt: "leak", screenshot: "AAAA" }))[0].messages[0].browser!;
    expect(ref).toEqual({ url: "https://example.com/", state: "dismissed" });
  });
});

describe("browser client", () => {
  const view = (over = {}) => ({ id: ID, status: "running", url: "https://example.com/", sessionReleased: false, steps: STEP_IDS.map((id) => ({ id, status: "pending" })), ...over });
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("sends approval only on create, with same-origin credentials, fixed paths and no token", async () => {
    const f = vi.fn(async () => resp(202, { task: view() }));
    const c = createBrowserClient(f as unknown as typeof fetch);
    const r = await c.create("https://example.com/");
    expect(r.ok && r.value.id).toBe(ID);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/browser/tasks"); expect(init.credentials).toBe("same-origin"); expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/", approved: true });
    expect(JSON.stringify(init)).not.toMatch(/authorization|bearer|token/i);
    await c.get(ID); await c.cancel(ID);
    expect(f.mock.calls.map((x) => (x as unknown as [string, RequestInit]).slice(0, 2).map((v) => (typeof v === "string" ? v : (v as RequestInit).method)).join(" "))).toEqual(["/api/browser/tasks POST", `/api/browser/tasks/${ID} GET`, `/api/browser/tasks/${ID}/cancel POST`]);
  });
  it("refuses to build a request for anything that is not a task id", async () => {
    const c = createBrowserClient(vi.fn() as unknown as typeof fetch);
    await expect(c.get("../ping")).rejects.toThrow(); await expect(c.cancel("x")).rejects.toThrow(); expect(() => c.screenshotUrl("x/../y")).toThrow();
    expect(c.screenshotUrl(ID)).toBe(`/api/browser/tasks/${ID}/screenshot`);
  });
  it("maps errors to fixed codes and rejects replies that are not a valid task", async () => {
    const seq = [resp(401, { error: "unauthorized" }), resp(409, { error: "busy" }), resp(503, { error: "disabled" }), resp(500, "<html>"), resp(200, { task: { id: "bad" } }), resp(200, "nope")];
    const c = createBrowserClient((async () => seq.shift()) as unknown as typeof fetch);
    expect((await c.create("https://example.com/"))).toEqual({ ok: false, error: "unauthorized" });
    expect((await c.create("https://example.com/"))).toEqual({ ok: false, error: "busy" });
    expect((await c.create("https://example.com/"))).toEqual({ ok: false, error: "disabled" });
    expect((await c.get(ID))).toEqual({ ok: false, error: "unavailable" });
    expect((await c.get(ID))).toEqual({ ok: false, error: "unavailable" });
    expect((await c.get(ID))).toEqual({ ok: false, error: "unavailable" });
    expect(await createBrowserClient((async () => { throw new Error("offline"); }) as unknown as typeof fetch).get(ID)).toEqual({ ok: false, error: "network" });
  });
});
