import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, type Deps } from "@/server/basht-chat";
import { issueCookieValue } from "@/server/assistant-chat-gate";
import { setRuntimeForTests } from "@/server/notify/runtime";
import { createMemoryStore } from "@/server/notify/memory-store";
import {
  answerable, ApprovalError, confirmCopy, countdown, createApprovalsClient, outcomeText, type PendingApproval,
} from "@/lib/basht-approvals";
import { makeRuntime, makeSubscription, registerDevice } from "./notify-helpers";

const CODE = "basht-owner-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const env = { BASHT_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const gate = readBashtGate(env)!;
const NOW = 1_800_000_000_000;
const AID = "2f075550-246c-4742-97d7-5268e18d63d2";
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const cookie = `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}`;
const authed = { headers: { ...same, cookie } };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
let backend: ReturnType<typeof vi.fn>;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const call = (method: string, path: string, init?: Parameters<typeof req>[2]) => handleBashtChat(req(method, path, init), path.split("?")[0].split("/"), deps());
beforeEach(() => { backend = vi.fn(); resetBashtLimits(); setRuntimeForTests(null); });

const API_APPROVAL = { id: AID, kind: "exec", summary: "echo hello", title: null, host: "gateway", agent_id: "main", session: "app", is_app: true,
  warning: null, created_at: 1, expires_at: NOW + 60_000, decisions: ["allow-once", "deny"] };

describe("BASHT door: approvals (B3)", () => {
  it("needs the owner session; cross-site decisions are refused before the API", async () => {
    expect((await call("GET", "approvals", { headers: same })).status).toBe(401);
    expect((await call("POST", "approvals/decide", { headers: same, body: { id: AID, decision: "deny" } })).status).toBe(401);
    const cross = { headers: { ...authed.headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" } };
    expect((await call("POST", "approvals/decide", { ...cross, body: { id: AID, decision: "allow-once" } })).status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });

  it("lists pending approvals in a fixed camelCase shape; link down is shown as unavailable", async () => {
    backend.mockResolvedValueOnce(ok(200, { available: true, link: { state: "up" }, approvals: [API_APPROVAL, { id: "bad" }, { ...API_APPROVAL, id: "plugin:abcdef12", kind: "nope" }] }));
    const r = await call("GET", "approvals", authed);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ available: true, link: "up", approvals: [{ id: AID, kind: "exec", summary: "echo hello", title: null, session: "app", isApp: true,
      warning: null, createdAt: 1, expiresAt: NOW + 60_000, decisions: ["allow-once", "deny"] }] });
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/approvals", method: "GET" });
    backend.mockResolvedValueOnce(ok(200, { available: false, approvals: [], link: { state: "down" } }));
    expect(await (await call("GET", "approvals", authed)).json()).toEqual({ available: false, link: "down", approvals: [] });
    backend.mockResolvedValueOnce({ kind: "unreachable" });
    expect((await call("GET", "approvals", authed)).status).toBe(503);
  });

  it("decide: allow-once or deny only, validated id, codes passed through from a fixed list", async () => {
    for (const d of ["allow-always", "allow", "", 1, null]) {
      const r = await call("POST", "approvals/decide", { ...authed, body: { id: AID, decision: d } });
      expect(r.status).toBe(400); expect((await r.json()).error).toBe("bad_decision");
    }
    for (const id of ["x", "../../x", "a b c d e f g h", 5]) expect((await (await call("POST", "approvals/decide", { ...authed, body: { id, decision: "deny" } })).json()).error).toBe("bad_id");
    expect(backend).not.toHaveBeenCalled();
    backend.mockResolvedValueOnce(ok(200, { applied: true, approval: { id: AID, kind: "exec", decision: "allow-once", status: "allowed", session: "app", by: "app" } }));
    const r = await call("POST", "approvals/decide", { ...authed, body: { id: AID, decision: "allow-once", kind: "plugin", sessionKey: "agent:main:main" } });
    expect(await r.json()).toMatchObject({ applied: true, approval: { id: AID, decision: "allow-once" } });
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/approvals/decide", method: "POST", body: { id: AID, decision: "allow-once" } });
    for (const code of ["link_down", "not_found", "rejected"]) {
      backend.mockResolvedValueOnce(ok(400, { detail: { code } }));
      const e = await call("POST", "approvals/decide", { ...authed, body: { id: AID, decision: "deny" } });
      expect([e.status, (await e.json()).error]).toEqual([400, code]);
    }
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "some upstream text" } }));
    expect((await (await call("POST", "approvals/decide", { ...authed, body: { id: AID, decision: "deny" } })).json()).error).toBe("bad_request");
  });

  it("history: the last decisions, fixed shape", async () => {
    backend.mockResolvedValueOnce(ok(200, { available: true, items: [{ id: AID, kind: "exec", summary: "x", status: "denied", decision: "deny", reason: "user", session: "app", by: "app", created_at: 1, resolved_at: 2, url_path: "/x" }] }));
    const j = await (await call("GET", "approvals/history", authed)).json();
    expect(j.items[0]).toEqual({ id: AID, kind: "exec", summary: "x", status: "denied", decision: "deny", reason: "user", session: "app", by: "app", createdAt: 1, resolvedAt: 2 });
    expect(backend.mock.calls[0][0]).toMatchObject({ path: "/internal/v1/basht/approvals/history", method: "POST", body: { limit: 20 } });
  });
});

describe("BASHT door: push link (B4)", () => {
  it("links a device only with BOTH the owner session and the device's own token, and only when it is subscribed", async () => {
    const store = createMemoryStore();
    const rt = makeRuntime({ store, now: () => NOW });
    setRuntimeForTests(rt);
    const dev = await registerDevice(rt, makeSubscription().sub);
    const unsub = await registerDevice(rt);
    // no owner session
    expect((await call("POST", "push", { headers: { ...same, ...dev.auth }, body: { enabled: true } })).status).toBe(401);
    // owner session but no / wrong device token
    expect((await call("POST", "push", { ...authed, body: { enabled: true } })).status).toBe(401);
    expect((await call("POST", "push", { headers: { ...authed.headers, Authorization: `Bearer ${dev.deviceId}.${"x".repeat(43)}` }, body: { enabled: true } })).status).toBe(401);
    expect((await call("POST", "push", { headers: { ...authed.headers, ...unsub.auth }, body: { enabled: true } })).status).toBe(409);
    expect((await call("POST", "push", { headers: { ...authed.headers, ...dev.auth }, body: { enabled: "yes" } })).status).toBe(400);
    expect(await store.bashtDevices(10)).toEqual([]);
    const r = await call("POST", "push", { headers: { ...authed.headers, ...dev.auth }, body: { enabled: true } });
    expect(await r.json()).toEqual({ enabled: true });
    expect((await store.bashtDevices(10)).map((d) => d.id)).toEqual([dev.deviceId]);
    expect(await (await call("GET", "push", { headers: { ...authed.headers, ...dev.auth } })).json()).toEqual({ enabled: true, subscribed: true });
    await call("POST", "push", { headers: { ...authed.headers, ...dev.auth }, body: { enabled: false } });
    expect(await store.bashtDevices(10)).toEqual([]);
    setRuntimeForTests(makeRuntime({ env: { VAPID_PUBLIC_KEY: "" } }));
    expect((await call("GET", "push", { headers: { ...authed.headers, ...dev.auth } })).status).toBe(503);
  });
});

describe("approvals UI helpers", () => {
  const a = (over: Partial<PendingApproval> = {}): PendingApproval => ({ id: AID, kind: "exec", summary: "echo hi", title: null, session: "app", isApp: true, warning: null,
    createdAt: 1, expiresAt: NOW + 10 * 60_000, decisions: ["allow-once", "deny"], ...over });
  it("countdown in Arabic, urgent near the end, expired after", () => {
    expect(countdown(NOW + 29 * 60_000 + 1, NOW)).toEqual({ text: "تنتهي خلال ٣٠ د", expired: false, urgent: false });
    expect(countdown(NOW + 90_000, NOW).urgent).toBe(true);
    expect(countdown(NOW + 45_000, NOW).text).toBe("تنتهي خلال ٤٥ ث");
    expect(countdown(NOW, NOW)).toEqual({ text: "انتهت مهلة الطلب", expired: true, urgent: true });
    expect(countdown(null, NOW).text).toBe("");
  });
  it("answerable: not expired, has an allowed answer, app-only for the chat card, oldest first", () => {
    const list = [a({ id: "b".repeat(10), createdAt: 5 }), a({ id: "c".repeat(10), isApp: false, createdAt: 2 }), a({ id: "d".repeat(10), expiresAt: NOW - 1 }), a({ id: "e".repeat(10), decisions: [] })];
    expect(answerable(list, NOW).map((x) => x.id)).toEqual(["c".repeat(10), "b".repeat(10)]);
    expect(answerable(list, NOW, true).map((x) => x.id)).toEqual(["b".repeat(10)]);
  });
  it("confirmation and outcome copy", () => {
    expect(confirmCopy(a(), "allow-once")).toMatchObject({ confirmLabel: "سماح مرة واحدة", tone: "default" });
    expect(confirmCopy(a(), "allow-once").message).toContain("«echo hi»");
    expect(confirmCopy(a({ summary: null }), "deny")).toMatchObject({ confirmLabel: "رفض", tone: "danger" });
    expect(outcomeText(true, "allow-once", "allow-once")).toBe("تمت الموافقة؛ يكمل باشت الآن.");
    expect(outcomeText(false, "deny", "allow-once")).toBe("سبق الرد على هذا الطلب (رُفض).");
    expect(outcomeText(false, null, "deny")).toBe("انتهى هذا الطلب قبل وصول ردك.");
  });
  it("client: same-origin calls, Arabic errors, device bearer only on the push link", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const f = (async (u: string, init?: RequestInit) => { seen.push([u, init]); return u.includes("decide") ? new Response(JSON.stringify({ error: "link_down" }), { status: 400 }) : new Response(JSON.stringify({ enabled: true })); }) as typeof fetch;
    const c = createApprovalsClient(f);
    await expect(c.decide(AID, "deny")).rejects.toMatchObject({ code: "link_down", message: expect.stringContaining("غير متصل") });
    expect(JSON.parse(String(seen[0][1]?.body))).toEqual({ id: AID, decision: "deny" });
    await c.setPushLinked({ deviceId: AID, token: "t".repeat(43), subscribed: true, registeredAt: 1 }, true);
    expect((seen[1][1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${AID}.${"t".repeat(43)}`);
    await expect(createApprovalsClient((async () => { throw new Error("x"); }) as typeof fetch).list()).rejects.toBeInstanceOf(ApprovalError);
  });
});
