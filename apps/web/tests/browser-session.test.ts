import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowser } from "./setup";
import { runCommand, runQuickCommand } from "@/lib/commands";
import { threadsStore } from "@/lib/stores";
import { parseThreads } from "@/lib/domain";
import { createBrowserClient } from "@/lib/browser-client";
import { SESSION_STEP_IDS, parseActionLine, parseActionRequest, parseBrowseCommand, parseLocator, parseTaskView } from "@/lib/browser-task";
import { handleBrowserChat, resetBrowserChatLimits, type Deps } from "@/server/browser-chat/api";
import { COOKIE_NAME, issueCookieValue, readGate } from "@/server/browser-chat/gate";
import { isolateScopes, readScopes, sameSite, sessionResultOk, sessionStartUrl, sessionTargetOk, siteOf } from "@/server/browser-chat/scopes";

const ID = "11111111-1111-4111-8111-111111111111";
const LAB = "https://lab.example.org/browser-lab/index.html";
const SCOPE = "lab.example.org/browser-lab/";
const CODE = "owner-access-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const NOW = 1_800_000_000_000;
const env = { BROWSER_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production", BROWSER_INTERACTIVE_SCOPES: SCOPE };
const gate = readGate(env)!;
const sview = (over: Record<string, unknown> = {}) => ({
  id: ID, mode: "interactive", status: "running", url: LAB, sessionReleased: false, ready: true, createdAt: 1_700_000_000_000, deadlineAt: 1_700_000_300_000,
  steps: SESSION_STEP_IDS.map((id) => ({ id, status: "pending" })), limits: { maxActions: 20, deadlineMs: 300000, idleMs: 45000, approvalMs: 60000 }, blockedRequests: 0, actions: [],
  result: { title: "مختبر", url: LAB, excerpt: "hello", hasScreenshot: true, version: 2 }, ...over,
});

describe("lib: structured locators and actions (no selector strings, no scripts)", () => {
  it("accepts the four kinds of locator and trims", () => {
    expect(parseLocator({ by: "role", role: "button", value: " Save " })).toEqual({ by: "role", role: "button", value: "Save" });
    expect(parseLocator({ by: "label", value: "الاسم", exact: true })).toEqual({ by: "label", value: "الاسم", exact: true });
    expect(parseLocator({ by: "placeholder", value: "x" })).toEqual({ by: "placeholder", value: "x" });
    expect(parseLocator({ by: "text", value: "x" })).toEqual({ by: "text", value: "x" });
  });
  it.each([
    [null], ["button"], [[]], [{}], [{ by: "css", value: "#a" }], [{ by: "xpath", value: "//a" }], [{ by: "role", value: "x" }], [{ by: "role", role: "script", value: "x" }],
    [{ by: "role", role: "button", value: "x", css: "a" }], [{ by: "label", role: "button", value: "x" }], [{ by: "text", value: "" }], [{ by: "text", value: "   " }],
    [{ by: "text", value: "a".repeat(81) }], [{ by: "text", value: "a\nb" }], [{ by: "text", value: "a‮b" }], [{ by: "text", value: "x", exact: "yes" }], [{ by: "text", value: 5 }],
  ])("rejects %j", (raw) => expect(parseLocator(raw)).toBeNull());
  const ok = (u: string) => u.startsWith("https://lab.example.org/browser-lab/");
  it("validates whole actions strictly", () => {
    expect(parseActionRequest({ tool: "observe" }, ok)).toEqual({ tool: "observe" });
    expect(parseActionRequest({ tool: "navigate", url: LAB }, ok)).toEqual({ tool: "navigate", url: LAB });
    expect(parseActionRequest({ tool: "type", target: { by: "label", value: "N" }, text: "مرحبا" }, ok)).toMatchObject({ tool: "type", text: "مرحبا" });
    for (const bad of [{}, { tool: "eval" }, { tool: "press", key: "Enter" }, { tool: "observe", x: 1 }, { tool: "navigate", url: "https://evil.test/" }, { tool: "navigate" }, { tool: "click" },
      { tool: "click", target: { by: "text", value: "x" }, approved: true }, { tool: "type", target: { by: "label", value: "x" } }, { tool: "type", target: { by: "label", value: "x" }, text: "a".repeat(201) },
      { tool: "type", target: { by: "label", value: "x" }, text: "a\nb" }, { tool: "type", target: { by: "label", value: "x" }, text: 5 }, null, [], "click"]) {
      expect(parseActionRequest(bad, ok), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("chat command lines", () => {
  const act = (t: string) => { const l = parseActionLine(t, (u) => u.startsWith("https://")); return l && l.kind === "action" ? l.action : l; };
  it("parses Arabic and English forms, including iPhone smart quotes", () => {
    expect(act('/انقر زر "إرسال"')).toEqual({ tool: "click", target: { by: "role", role: "button", value: "إرسال" } });
    expect(act("/انقر على رابط «الصفحة الثانية»")).toEqual({ tool: "click", target: { by: "role", role: "link", value: "الصفحة الثانية" } });
    expect(act("/click button “Save”")).toEqual({ tool: "click", target: { by: "role", role: "button", value: "Save" } });
    expect(act('/اكتب "أحمد" في حقل "الاسم"')).toEqual({ tool: "type", target: { by: "role", role: "textbox", value: "الاسم" }, text: "أحمد" });
    expect(act("/type “it's fine” in textbox “Name”")).toMatchObject({ tool: "type", text: "it's fine" });
    expect(act('/اكتب "x" في عنوان "الاسم الكامل"')).toMatchObject({ target: { by: "label", value: "الاسم الكامل" } });
    expect(act('/انقر نص إرشادي "بحث"')).toEqual({ tool: "click", target: { by: "placeholder", value: "بحث" } });
    expect(act("/افتح https://lab.example.org/browser-lab/page2.html")).toEqual({ tool: "navigate", url: "https://lab.example.org/browser-lab/page2.html" });
    expect(act("/اقرأ")).toEqual({ tool: "observe" });
    expect(act('/انقر خانة اختيار "أوافق"')).toEqual({ tool: "click", target: { by: "role", role: "checkbox", value: "أوافق" } });
    expect(act('/انقر زر اختيار "نعم"')).toEqual({ tool: "click", target: { by: "role", role: "radio", value: "نعم" } });
    expect(act('/اكتب "x" في حقل بحث "بحث"')).toMatchObject({ tool: "type", target: { by: "role", role: "searchbox", value: "بحث" } });
  });
  it("is not triggered by ordinary text or other commands, and explains malformed ones", () => {
    for (const t of ["انقر زر", "hello /click", "/مهمة انقر", "/متصفح", "", "  "]) expect(parseActionLine(t)).toBeNull();
    for (const t of ["/انقر", "/انقر زر", "/انقر زر بدون اقتباس", '/انقر شيء "x"', '/اكتب "x"', '/اكتب "x" في "y"', '/افتح']) {
      const l = parseActionLine(t, () => true);
      expect(l && l.kind, t).toBe("error");
    }
    expect(parseActionLine("/افتح http://169.254.169.254", (u) => u.startsWith("https://lab"))).toMatchObject({ kind: "error" });
    expect(parseActionLine('/اكتب "' + "a".repeat(201) + '" في حقل "n"')).toMatchObject({ kind: "error" });
  });
  it("«/متصفح تفاعلي» offers a card and nothing else; read-only commands are unchanged", () => {
    expect(parseBrowseCommand("/متصفح تفاعلي")).toEqual({ kind: "offer-interactive" });
    expect(parseBrowseCommand("/browse interactive")).toEqual({ kind: "offer-interactive" });
    expect(parseBrowseCommand("/متصفح")).toEqual({ kind: "offer", url: "https://example.com/" });
    expect(parseBrowseCommand("/متصفح انقر على زر الدفع")).toMatchObject({ kind: "blocked" });
  });
});

describe("quick commands and persisted references", () => {
  beforeEach(() => { installBrowser(); threadsStore.reset(); });
  it("never touch the network; they only produce an offer or an action for the active card", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    expect(await runQuickCommand("/متصفح تفاعلي")).toEqual({ handled: true, browserOffer: { url: "", mode: "interactive" } });
    expect(await runQuickCommand('/انقر زر "إرسال"')).toEqual({ handled: true, browserAction: { tool: "click", target: { by: "role", role: "button", value: "إرسال" } } });
    expect((await runQuickCommand("/انقر")).reply).toBeTruthy();
    expect(f).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });
  it("stores an interactive card with no address and no content", async () => {
    await runCommand("chat.send", { threadId: null, text: "x", role: "system", browser: { url: "", mode: "interactive", state: "offer" } });
    const t = threadsStore.getSnapshot()[0], m = t.messages[0];
    expect(m.browser).toEqual({ url: "", mode: "interactive", state: "offer" });
    await runCommand("chat.browser.update", { threadId: t.id, id: m.id, patch: { state: "started", taskId: ID } });
    expect(threadsStore.getSnapshot()[0].messages[0].browser).toEqual({ url: "", mode: "interactive", state: "started", taskId: ID });
    // the update cannot turn it into a read-only card, give it an address, or smuggle content
    await runCommand("chat.browser.update", { threadId: t.id, id: m.id, patch: { mode: undefined, url: "https://example.com/", excerpt: "secret", typed: "x" } as never });
    expect(threadsStore.getSnapshot()[0].messages[0].browser).toEqual({ url: "", mode: "interactive", state: "started", taskId: ID });
    expect((await runCommand("chat.send", { threadId: null, text: "x", browser: { url: "https://evil.test/", mode: "interactive", state: "offer" } })).status).toBe("invalid");
    expect((await runCommand("chat.send", { threadId: null, text: "x", browser: { url: "", mode: "admin", state: "offer" } as never })).status).toBe("invalid");
  });
  it("sanitises persisted interactive references", () => {
    const thread = (b: unknown) => [{ id: "t", title: "t", created: 1, messages: [{ id: "m", text: "x", created: 1, browser: b }] }];
    expect(parseThreads(thread({ url: "", mode: "interactive", state: "done", outcome: "cancelled" }))[0].messages[0].browser).toEqual({ url: "", mode: "interactive", state: "done", outcome: "cancelled" });
    for (const bad of [{ url: "https://evil.test/", mode: "interactive", state: "offer" }, { url: "", state: "offer" }, { url: "", mode: "x", state: "offer" }, { url: "https://example.com/", mode: "interactive", state: "offer" }]) {
      expect(parseThreads(thread(bad))[0].messages[0].browser, JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseTaskView (interactive)", () => {
  const shape = (u: string) => u.startsWith("https://lab.example.org/browser-lab/");
  it("accepts a valid session view and drops unknown fields", () => {
    const v = parseTaskView(sview({ actions: [{ seq: 1, tool: "click", status: "denied", summary: "نقر", error: "sensitive_action", html: "<b>" }], endReason: "idle", connectUrl: "wss://x", pending: { seq: 1, kind: "submit", summary: "s", submitsTo: "https://lab.example.org/browser-lab/submit" } }), { sessionUrlOk: shape })!;
    expect(v.mode).toBe("interactive"); expect(v.actions![0]).toEqual({ seq: 1, tool: "click", status: "denied", summary: "نقر", error: "sensitive_action" });
    expect(v.endReason).toBe("idle"); expect(v.result!.version).toBe(2); expect(v.pending!.submitsTo).toContain("/submit");
    expect(JSON.stringify(v)).not.toMatch(/connectUrl|<b>/);
  });
  it.each([
    ["wrong steps", { steps: [{ id: "create_session", status: "done" }] }], ["url off scope", { url: "https://evil.test/" }], ["bad mode", { mode: "root" }],
    ["limits missing", { limits: null }], ["too many actions", { actions: Array.from({ length: 21 }, (_, i) => ({ seq: i + 1, tool: "click", status: "done", summary: "x" })) }],
    ["seq gap", { actions: [{ seq: 2, tool: "click", status: "done", summary: "x" }] }], ["bad tool", { actions: [{ seq: 1, tool: "eval", status: "done", summary: "x" }] }],
    ["bad action status", { actions: [{ seq: 1, tool: "click", status: "weird", summary: "x" }] }], ["bad pending kind", { pending: { seq: 1, kind: "pay", summary: "x" } }],
    ["pending dest off scope", { pending: { seq: 1, kind: "submit", summary: "x", submitsTo: "https://evil.test/c" } }], ["result off scope", { result: { title: "t", url: "https://evil.test/", excerpt: "", hasScreenshot: false } }],
  ])("rejects: %s", (_n, over) => expect(parseTaskView(sview(over), { sessionUrlOk: shape })).toBeNull());
  it("keeps the resolved element of a pending approval, cleaned; rejects a malformed one", () => {
    const pending = (element: unknown) => sview({ actions: [{ seq: 1, tool: "click", status: "awaiting_approval", summary: "x" }], pending: { seq: 1, kind: "button", summary: "s", element } });
    expect(parseTaskView(pending({ tag: "button", role: "switch", text: "Share\u202e all", html: "<b>" }), { sessionUrlOk: shape })!.pending!.element).toEqual({ tag: "button", text: "Share all", role: "switch" });
    for (const bad of [{ tag: "BUTTON<x>" }, "button", { text: "no tag" }]) expect(parseTaskView(pending(bad), { sessionUrlOk: shape })).toBeNull();
  });
  it("accepts the new outcome codes and the pending method; refuses another method", () => {
    const withPending = (p: unknown) => sview({ actions: [{ seq: 1, tool: "click", status: "denied", summary: "x", error: "effect_blocked" }, { seq: 2, tool: "click", status: "awaiting_approval", summary: "y" }], pending: p });
    const v = parseTaskView(withPending({ seq: 2, kind: "submit", summary: "s", method: "POST", submitsTo: "https://lab.example.org/browser-lab/submit" }), { sessionUrlOk: shape })!;
    expect(v.pending!.method).toBe("POST"); expect(v.actions![0].error).toBe("effect_blocked");
    expect(parseTaskView(withPending({ seq: 2, kind: "submit", summary: "s", method: "DELETE" }), { sessionUrlOk: shape })).toBeNull();
  });
  it("collapses unknown action errors to a fixed code", () => {
    expect(parseTaskView(sview({ actions: [{ seq: 1, tool: "click", status: "failed", summary: "x", error: "Traceback /srv/x" }] }), { sessionUrlOk: shape })!.actions![0].error).toBe("action_failed");
  });
  it("read-only views are unchanged: example.com only, 6 steps", () => {
    expect(parseTaskView({ id: ID, status: "running", url: "https://example.com/", sessionReleased: false, steps: ["create_session", "connect", "navigate", "read", "screenshot", "release"].map((id) => ({ id, status: "pending" })) })).not.toBeNull();
    expect(parseTaskView({ id: ID, status: "running", url: LAB, sessionReleased: false, steps: [] })).toBeNull();
  });
});

describe("scopes (BFF)", () => {
  it("parses the same grammar as the worker; any invalid entry turns the feature OFF", () => {
    expect(readScopes({ BROWSER_INTERACTIVE_SCOPES: SCOPE })).toEqual([{ host: "lab.example.org", prefix: "/browser-lab/" }]);
    for (const bad of ["", " ", "lab.example.org", "lab.example.org/", "10.0.0.1/a/", "x.railway.internal/a/", "localhost/a/", "lab.example.org:8443/a/", "https://lab.example.org/a/", "lab.example.org/../a/", `${SCOPE},bad`]) {
      expect(readScopes({ BROWSER_INTERACTIVE_SCOPES: bad }), bad).toEqual([]);
    }
    expect(readScopes({})).toEqual([]);
  });
  it("targets must be inside a scope (or the look-only host); results may carry a query", () => {
    const s = readScopes(env);
    for (const u of [LAB, "https://lab.example.org/browser-lab/a/b.html", "https://example.com/", "https://example.com/x"]) expect(sessionTargetOk(u, s), u).toBe(true);
    for (const u of ["https://lab.example.org/", "https://lab.example.org/browser-lab", "https://lab.example.org/other", "https://lab.example.org/browser-lab/../x", "https://lab.example.org/browser-lab/a?x=1",
      "http://lab.example.org/browser-lab/a", "https://lab.example.org.evil.test/browser-lab/a", "https://evil.test/browser-lab/a", "https://example.com:8443/", 5, null, "x".repeat(300)]) expect(sessionTargetOk(u, s), String(u)).toBe(false);
    expect(sessionResultOk("https://lab.example.org/browser-lab/a?x=1#h", s)).toBe(true);
    expect(sessionResultOk("https://lab.example.org/elsewhere", s)).toBe(false);
    expect(sessionStartUrl(s)).toBe(LAB); expect(sessionStartUrl([])).toBeNull();
  });
});

describe("isolation: the lab must be a different site from the app and the API", () => {
  it("siteOf / sameSite (conservative eTLD+1 heuristic)", () => {
    expect(siteOf("lab.example.org")).toBe("example.org"); expect(siteOf("a.b.example.co.uk")).toBe("example.co.uk"); expect(siteOf("127.0.0.1")).toBe("127.0.0.1"); expect(siteOf("localhost")).toBe("localhost");
    for (const [a, b] of [["lab.app.com", "app.com"], ["lab.app.com", "www.app.com"], ["app.com", "app.com"], ["x.app.co.uk", "y.app.co.uk"], ["APP.com.", "lab.app.com"]]) expect(sameSite(a, b), `${a} ${b}`).toBe(true);
    for (const [a, b] of [["lab-owner.net", "app.com"], ["app.com", "app.co"], ["app.com", "notapp.com"], ["lab.test", "127.0.0.1"], ["", "app.com"]]) expect(sameSite(a, b), `${a} ${b}`).toBe(false);
  });
  it("refuses (all of) the scopes when any shares a site with the app or the API", () => {
    const s = readScopes({ BROWSER_INTERACTIVE_SCOPES: "lab.example.org/browser-lab/" });
    expect(isolateScopes(s, ["app.example.org", null])).toEqual({ scopes: [], refused: true });
    expect(isolateScopes(s, ["app.other.com", "api.example.org"])).toEqual({ scopes: [], refused: true });
    expect(isolateScopes(s, ["app.other.com", "api.another.io"])).toEqual({ scopes: s, refused: false });
    const two = readScopes({ BROWSER_INTERACTIVE_SCOPES: "lab.example.org/a/,lab2.fine.net/b/" });
    expect(isolateScopes(two, ["app.example.org"]).scopes).toEqual([]);
  });
});

// ── BFF routes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Mock = ReturnType<typeof vi.fn>;
let backend: Mock;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const cookie = () => `${COOKIE_NAME}=${issueCookieValue(gate, NOW)}`;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const authed = { ...same, cookie: cookie() };
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = authed, d: Deps = deps()) =>
  handleBrowserChat(new Request(`https://${HOST}/api/browser/${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), path.split("/"), d);
const ok = (status: number, json: unknown) => ({ kind: "ok" as const, status, json });
const CLICK = { tool: "click", target: { by: "role", role: "button", value: "Count" } };
beforeEach(() => { backend = vi.fn(); resetBrowserChatLimits(); });

describe("BFF: starting a session", () => {
  it("status tells the signed-in owner where the lab is; anonymous callers learn only that it exists", async () => {
    expect(await (await call("GET", "status", undefined, {})).json()).toEqual({ enabled: true, authenticated: false, interactive: { enabled: true } });
    expect(await (await call("GET", "status", undefined, authed)).json()).toEqual({ enabled: true, authenticated: true, interactive: { enabled: true, startUrl: LAB } });
    const off = deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: undefined } });
    expect(await (await call("GET", "status", undefined, authed, off)).json()).toEqual({ enabled: true, authenticated: true, interactive: { enabled: false } });
  });
  it("needs the cookie, same origin, an explicit approval, a scope, and sends only the validated URL", async () => {
    backend.mockResolvedValue(ok(202, { task: sview() }));
    expect((await call("POST", "tasks", { mode: "interactive", approved: true }, { ...same })).status).toBe(401);
    expect((await call("POST", "tasks", { mode: "interactive", approved: true }, { ...authed, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("POST", "tasks", { mode: "interactive" })).status).toBe(400);
    expect((await call("POST", "tasks", { mode: "interactive", approved: true, url: "https://evil.test/" })).status).toBe(400);
    expect((await call("POST", "tasks", { mode: "root", approved: true })).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
    const r = await call("POST", "tasks", { mode: "interactive", approved: true });
    expect(r.status).toBe(202); expect((await r.json()).task.mode).toBe("interactive");
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/browser/tasks", method: "POST", body: { url: LAB, mode: "interactive" } });
    const noScope = deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: undefined } });
    expect((await call("POST", "tasks", { mode: "interactive", approved: true }, authed, noScope)).status).toBe(503);
  });
  it("refuses an interactive view when this tier has no scope, and one that points outside it", async () => {
    backend.mockResolvedValue(ok(202, { task: sview() }));
    const noScope = deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: undefined } });
    expect((await call("POST", "tasks", { url: "https://example.com/", approved: true }, authed, noScope)).status).toBe(502);
    backend.mockResolvedValue(ok(200, { task: sview({ url: "https://evil.test/" }) }));
    expect((await call("GET", `tasks/${ID}`)).status).toBe(502);
  });
});

describe("BFF: isolation of the lab from the app", () => {
  it("the whole interactive feature is OFF (and says why) when the lab shares a site with this app's host or the API's", async () => {
    backend.mockResolvedValue(ok(202, { task: sview() }));
    const sameApp = { ...authed, host: "app.example.org", "x-forwarded-host": "app.example.org", origin: "https://app.example.org" };
    const st = await (await call("GET", "status", undefined, sameApp, deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: "lab.example.org/browser-lab/" } }))).json();
    expect(st.interactive).toEqual({ enabled: false, reason: "same_site" });
    expect((await call("POST", "tasks", { mode: "interactive", approved: true }, sameApp, deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: "lab.example.org/browser-lab/" } }))).status).toBe(503);
    expect((await call("POST", `tasks/${ID}/actions`, CLICK, sameApp, deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: "lab.example.org/browser-lab/" } }))).status).toBe(503);
    const sameApi = deps({ env: { ...env, BACKEND_URL: "https://api.example.org", BROWSER_INTERACTIVE_SCOPES: "lab.example.org/browser-lab/" } });
    expect((await (await call("GET", "status", undefined, authed, sameApi)).json()).interactive.reason).toBe("same_site");
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("BFF: actions", () => {
  it("rebuilds and forwards a validated action; typed text is passed on and never logged or echoed", async () => {
    const spy = vi.spyOn(console, "log"), spy2 = vi.spyOn(console, "error");
    backend.mockResolvedValue(ok(202, { task: sview({ actions: [{ seq: 1, tool: "type", status: "queued", summary: "كتابة 12 حرفًا" }] }) }));
    const r = await call("POST", `tasks/${ID}/actions`, { tool: "type", target: { by: "label", value: "الاسم" }, text: "SECRET-TYPED-TEXT" });
    expect(r.status).toBe(202);
    expect(backend.mock.calls[0][0]).toMatchObject({ path: `/internal/v1/browser/tasks/${ID}/actions`, method: "POST", body: { tool: "type", target: { by: "label", value: "الاسم" }, text: "SECRET-TYPED-TEXT" } });
    expect(await r.text()).not.toContain("SECRET-TYPED-TEXT");
    expect(JSON.stringify([...spy.mock.calls, ...spy2.mock.calls])).not.toContain("SECRET-TYPED-TEXT");
    spy.mockRestore(); spy2.mockRestore();
  });
  it.each([
    [{}], [{ tool: "eval", code: "1" }], [{ tool: "click", target: { by: "css", value: "#a" } }], [{ tool: "navigate", url: "https://evil.test/" }], [{ tool: "click", target: { by: "text", value: "x" }, approved: true }],
    [{ tool: "type", target: { by: "label", value: "x" }, text: "a\nb" }], [{ tool: "observe", extra: 1 }],
  ])("rejects a malformed or out-of-scope action %j before the API", async (body) => {
    expect((await call("POST", `tasks/${ID}/actions`, body)).status).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });
  it("needs cookie + same origin + a scope + a UUID task id, and is rate limited", async () => {
    backend.mockResolvedValue(ok(202, { task: sview() }));
    expect((await call("POST", `tasks/${ID}/actions`, CLICK, { ...same })).status).toBe(401);
    expect((await call("POST", `tasks/${ID}/actions`, CLICK, { ...authed, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("POST", `tasks/${ID}/actions`, CLICK, { ...authed, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call("POST", "tasks/not-a-uuid/actions", CLICK)).status).toBe(404);
    expect((await call("POST", `tasks/${ID}/actions`, CLICK, authed, deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: undefined } }))).status).toBe(503);
    expect(backend).not.toHaveBeenCalled();
    for (let i = 0; i < 40; i++) expect((await call("POST", `tasks/${ID}/actions`, { tool: "observe" })).status).toBe(202);
    expect((await call("POST", `tasks/${ID}/actions`, { tool: "observe" })).status).toBe(429);
  });
  it("maps conflicts to fixed codes and never echoes upstream text", async () => {
    for (const [code, expected] of [["action_in_progress", "action_in_progress"], ["limit_reached", "limit_reached"], ["session_ended", "session_ended"], ["<script>x</script>", "conflict"]]) {
      backend.mockResolvedValueOnce(ok(409, { detail: { code } }));
      const r = await call("POST", `tasks/${ID}/actions`, CLICK);
      expect([r.status, (await r.json()).error]).toEqual([409, expected]);
    }
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "url_not_allowed" } }));
    expect((await (await call("POST", `tasks/${ID}/actions`, CLICK)).json()).error).toBe("url_not_allowed");
    backend.mockResolvedValueOnce({ kind: "rejected", status: 401 });
    expect((await call("POST", `tasks/${ID}/actions`, CLICK)).status).toBe(502);
  });
});

describe("BFF: approvals and finish", () => {
  const pending = { seq: 1, kind: "button", summary: "نقر على زر «Count»", expiresAt: 1_700_000_060_000 };
  it("approve/reject refer to a step number only, carry no payload, and need the same checks as every write", async () => {
    backend.mockResolvedValue(ok(200, { task: sview({ pending, actions: [{ seq: 1, tool: "click", status: "awaiting_approval", summary: "x" }] }) }));
    for (const verb of ["approve", "reject"]) {
      expect((await call("POST", `tasks/${ID}/actions/1/${verb}`, {}, { ...same })).status).toBe(401);
      expect((await call("POST", `tasks/${ID}/actions/1/${verb}`, {}, { ...authed, origin: "https://evil.test" })).status).toBe(403);
    }
    for (const seq of ["0", "21", "x", "01", "1.5", "-1", "100"]) expect((await call("POST", `tasks/${ID}/actions/${seq}/approve`, {})).status, seq).toBe(404);
    expect((await call("POST", `tasks/${ID}/actions/1/maybe`, {})).status).toBe(404);
    expect((await call("GET", `tasks/${ID}/actions/1/approve`)).status).toBe(404);
    expect(backend).not.toHaveBeenCalled();
    const r = await call("POST", `tasks/${ID}/actions/1/approve`, {});
    expect(r.status).toBe(200); expect((await r.json()).task.pending).toEqual(pending);
    expect(backend.mock.calls[0][0]).toMatchObject({ path: `/internal/v1/browser/tasks/${ID}/actions/1/approve`, method: "POST", body: {} });
    await call("POST", `tasks/${ID}/actions/1/reject`, {});
    expect(backend.mock.calls[1][0]).toMatchObject({ path: `/internal/v1/browser/tasks/${ID}/actions/1/reject` });
  });
  it("a body on approve cannot widen what is approved; approval needs a scope", async () => {
    backend.mockResolvedValue(ok(200, { task: sview() }));
    await call("POST", `tasks/${ID}/actions/1/approve`, { approved: true, seq: 2, tool: "type", text: "x" });
    expect(backend.mock.calls[0][0].body).toEqual({});
    expect((await call("POST", `tasks/${ID}/actions/1/approve`, {}, authed, deps({ env: { ...env, BROWSER_INTERACTIVE_SCOPES: undefined } }))).status).toBe(503);
  });
  it("finish ends gracefully; cancel (the hard stop) still works for interactive views", async () => {
    backend.mockResolvedValue(ok(200, { task: sview({ status: "succeeded", endReason: "finished", sessionReleased: true }) }));
    const r = await call("POST", `tasks/${ID}/finish`, {});
    expect((await r.json()).task.endReason).toBe("finished");
    expect(backend.mock.calls[0][0]).toMatchObject({ path: `/internal/v1/browser/tasks/${ID}/finish` });
    backend.mockResolvedValue(ok(200, { task: sview({ status: "cancelled", sessionReleased: true }) }));
    expect((await (await call("POST", `tasks/${ID}/cancel`, {})).json()).task.status).toBe("cancelled");
    expect((await call("POST", `tasks/${ID}/finish`, {}, { ...same })).status).toBe(401);
  });
});

describe("browser client (interactive)", () => {
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("sends approval only when starting, validates actions again, and builds only fixed paths", async () => {
    const f = vi.fn(async () => resp(202, { task: sview() }));
    const c = createBrowserClient(f as unknown as typeof fetch);
    expect((await c.createSession()).ok).toBe(true);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ mode: "interactive", approved: true });
    expect((await c.act(ID, { tool: "observe" })).ok).toBe(true);
    expect((await c.act(ID, { tool: "eval" } as never))).toEqual({ ok: false, error: "bad_request" });
    expect((await c.decide(ID, 0, true))).toEqual({ ok: false, error: "bad_request" });
    expect((await c.decide(ID, 21, true))).toEqual({ ok: false, error: "bad_request" });
    await c.decide(ID, 2, true); await c.decide(ID, 2, false); await c.finish(ID);
    const calls = f.mock.calls.map((x) => (x as unknown as [string, RequestInit])).map(([u, i]) => `${i.method} ${u}`);
    expect(calls).toEqual(["POST /api/browser/tasks", `POST /api/browser/tasks/${ID}/actions`, `POST /api/browser/tasks/${ID}/actions/2/approve`, `POST /api/browser/tasks/${ID}/actions/2/reject`, `POST /api/browser/tasks/${ID}/finish`]);
    expect(JSON.stringify(f.mock.calls)).not.toMatch(/authorization|bearer|token/i);
    await expect(c.act("../x", { tool: "observe" })).rejects.toThrow();
    expect(c.screenshotUrl(ID, 3)).toBe(`/api/browser/tasks/${ID}/screenshot?v=3`);
    expect(c.screenshotUrl(ID, -1)).toBe(`/api/browser/tasks/${ID}/screenshot`);
  });
  it("maps conflict codes and rejects an invalid session view", async () => {
    const seq = [resp(409, { error: "action_in_progress" }), resp(409, { error: "limit_reached" }), resp(503, { error: "interactive_disabled" }), resp(202, { task: { ...sview(), steps: [] } })];
    const c = createBrowserClient((async () => seq.shift()) as unknown as typeof fetch);
    expect(await c.act(ID, { tool: "observe" })).toEqual({ ok: false, error: "action_in_progress" });
    expect(await c.act(ID, { tool: "observe" })).toEqual({ ok: false, error: "limit_reached" });
    expect(await c.createSession()).toEqual({ ok: false, error: "interactive_disabled" });
    expect(await c.act(ID, { tool: "observe" })).toEqual({ ok: false, error: "unavailable" });
  });
});
