import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loginHref, safeNext } from "@/lib/login-path";
import { expiredLoginHref } from "@/components/owner-gate";
import { deviceLabel } from "@/server/device-label";
import { handleAuth, resetAuthLimits, type Deps } from "@/server/owner-auth";
import { resetOwnerSessionCache, SESSION_COOKIE } from "@/server/owner-session";

// ── the middleware talks to the API through callBackend: one fake for the whole file ──
type Reply = { kind: "ok"; status: number; json: unknown } | { kind: "unreachable" };
const backend = vi.fn<(a: { path: string; body: Record<string, unknown> }) => Promise<Reply>>();
vi.mock("@/server/backend", () => ({ callBackend: (a: { path: string; body: Record<string, unknown> }) => backend(a) }));
const { middleware, config } = await import("@/middleware");

const HOST = "app.example.test", BASE = `https://${HOST}`;
const GOOD = "G".repeat(43), BAD = "B".repeat(43);
const ok = (status: number, json: unknown): Reply => ({ kind: "ok", status, json });
const api = (path: string, body: Record<string, unknown>): Reply => {
  if (path.endsWith("/config")) return ok(200, { owner_auth: true, passkeys: false });
  if (path.endsWith("/session")) return body.session === GOOD ? ok(200, { account_id: "a" }) : ok(400, { detail: { code: "unauthorized" } });
  return ok(404, {});
};
const page = (path: string, cookie?: string) => new NextRequest(BASE + path, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });
const where = (r: Response) => { const l = r.headers.get("location"); return l ? new URL(l).pathname + new URL(l).search : null; };

beforeEach(() => {
  resetOwnerSessionCache(); resetAuthLimits(); backend.mockReset();
  backend.mockImplementation(async (a) => api(a.path, a.body));
  vi.stubEnv("OWNER_AUTH", "on"); vi.stubEnv("BACKEND_URL", "https://api.internal.example"); vi.stubEnv("SERVICE_AUTH_SECRET", "s".repeat(48));
});

describe("login gate: server side (middleware)", () => {
  it("protects every page and keeps static files and /api out of its way", () => {
    const re = new RegExp("^" + config.matcher[0].replace("/((?!", "/(?!").replace(").*)", ").*") + "$");
    for (const p of ["/", "/chat", "/settings", "/hq", "/tasks/123", "/login"]) expect(re.test(p), p).toBe(true);
    for (const p of ["/api/auth/status", "/_next/static/x.js", "/brand/basht-mark.webp", "/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"]) expect(re.test(p), p).toBe(false);
    expect(config.runtime).toBe("nodejs");
  });
  it("no session → /login with the original destination (path + query); nothing of the app is served", async () => {
    const r = await middleware(page("/chat?voice=1"));
    expect(r.status).toBe(307);
    expect(where(r)).toBe("/login?next=%2Fchat%3Fvoice%3D1");
    expect(where(await middleware(page("/")))).toBe("/login");
    expect(where(await middleware(page("/settings", BAD)))).toBe("/login?next=%2Fsettings");
  });
  it("a valid session passes, never cached by a shared cache", async () => {
    const r = await middleware(page("/settings", GOOD));
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-middleware-next")).toBe("1");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  it("/login: shown when signed out; signed in → straight to `next` (only same-origin app paths)", async () => {
    expect((await middleware(page("/login"))).headers.get("x-middleware-next")).toBe("1");
    expect(where(await middleware(page("/login?next=%2Fchat", GOOD)))).toBe("/chat");
    expect(where(await middleware(page("/login?next=https%3A%2F%2Fevil.example", GOOD)))).toBe("/");
  });
  it("API unreachable → login page says so (fail closed, never the app)", async () => {
    backend.mockImplementation(async (a) => (a.path.endsWith("/session") ? { kind: "unreachable" } : api(a.path, a.body)));
    expect(where(await middleware(page("/chat", GOOD)))).toBe("/login?next=%2Fchat&reason=unavailable");
  });
  it("gate off (OWNER_AUTH unset): no-op, the legacy per-door codes keep working", async () => {
    vi.stubEnv("OWNER_AUTH", "");
    const r = await middleware(page("/chat"));
    expect(r.headers.get("location")).toBeNull();
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("login gate: where to go after sign-in", () => {
  it("safeNext accepts app paths only", () => {
    for (const ok of ["/", "/chat", "/chat?voice=1", "/tasks/abc#x"]) expect(safeNext(ok), ok).toBe(ok);
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "chat", "/login", "/login?next=/x", "/api/auth/status", "/a\nb", "/" + "a".repeat(600), null, undefined])
      expect(safeNext(bad as string), String(bad)).toBe("/");
  });
  it("expired → back to the same place afterwards", () => {
    expect(loginHref("/chat?x=1")).toBe("/login?next=%2Fchat%3Fx%3D1");
    expect(loginHref("/")).toBe("/login");
    expect(expiredLoginHref("/settings")).toBe("/login?next=%2Fsettings&reason=expired");
    expect(expiredLoginHref("/")).toBe("/login?reason=expired");
  });
});

describe("devices & sessions", () => {
  it("device names come from the User-Agent (display only)", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("آيفون · Safari");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")).toBe("ماك · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0")).toBe("ويندوز · Edge");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBe("أندرويد · Chrome");
    expect(deviceLabel(null)).toBe("جهاز");
  });

  const deps = (): Deps => ({ env: { OWNER_AUTH: "on", NODE_ENV: "production", BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48) },
    callBackend: ((a: { path: string; body: Record<string, unknown> }) => backend(a)) as unknown as Deps["callBackend"], now: () => 1_800_000_000_000 });
  const same = { origin: BASE, host: HOST, "sec-fetch-site": "same-origin" };
  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    new Request(`${BASE}/api/auth/${path}`, { method, headers: { ...same, cookie: `${SESSION_COOKIE}=${cookie}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ID = "0b5c1d0e-1111-4222-8333-444455556666";

  it("lists this account's sessions and ends another device's one", async () => {
    backend.mockImplementation(async (a) => a.path.endsWith("sessions/list") ? ok(200, { sessions: [{ id: ID, device: "ماك · Chrome", current: false }] })
      : a.path.endsWith("sessions/revoke") ? ok(200, { ok: true }) : api(a.path, a.body));
    expect((await (await handleAuth(req("GET", "sessions", GOOD), ["sessions"], deps())).json()).sessions).toHaveLength(1);
    const r = await handleAuth(req("POST", "sessions/revoke", GOOD, { id: ID }), ["sessions", "revoke"], deps());
    expect(await r.json()).toEqual({ ok: true, signedOut: false });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(backend.mock.calls.find((c) => c[0].path.endsWith("sessions/revoke"))![0].body).toEqual({ session: GOOD, id: ID });
  });
  it("ending THIS device's session from the list signs out here too", async () => {
    let ended = false;
    backend.mockImplementation(async (a) => a.path.endsWith("sessions/revoke") ? ((ended = true), ok(200, { ok: true }))
      : a.path.endsWith("/session") && ended ? ok(400, { detail: { code: "unauthorized" } }) : api(a.path, a.body));
    const r = await handleAuth(req("POST", "sessions/revoke", GOOD, { id: ID }), ["sessions", "revoke"], deps());
    expect(await r.json()).toEqual({ ok: true, signedOut: true });
    expect(r.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0`));
  });
  it("needs a valid session and a well-formed id", async () => {
    expect((await handleAuth(req("GET", "sessions", BAD), ["sessions"], deps())).status).toBe(401);
    expect((await handleAuth(req("POST", "sessions/revoke", GOOD, { id: "../x" }), ["sessions", "revoke"], deps())).status).toBe(400);
  });
  it("sign-in sends the device name with the code", async () => {
    await handleAuth(new Request(`${BASE}/api/auth/login/code`, { method: "POST", headers: { ...same, "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile Safari/604.1" }, body: JSON.stringify({ code: "x".repeat(40), remember: true }) }), ["login", "code"], deps());
    expect(backend.mock.calls.find((c) => c[0].path.endsWith("login/code"))![0].body).toMatchObject({ remember: true, device: "آيفون · Safari" });
  });
});
