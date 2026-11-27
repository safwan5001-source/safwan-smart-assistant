import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuth, resetAuthLimits, type Deps } from "@/server/owner-auth";
import { doorAccess, resetOwnerSessionCache, SESSION_COOKIE } from "@/server/owner-session";
import { handleBashtChat, resetBashtLimits } from "@/server/basht-chat";

const HOST = "app.example.test";
const NOW = 1_800_000_000_000;
const SECRET = "A".repeat(43), OTHER = "B".repeat(43);
const ACCOUNT = "0b5c1d0e-1111-4222-8333-444455556666";
const KEY_ID = "9f0e8d7c-6b5a-4938-8271-605f4e3d2c1b";
const base = { BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const env = { ...base, OWNER_AUTH: "on" };
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const withSession = (s = SECRET, extra = "") => ({ ...same, cookie: `${SESSION_COOKIE}=${s}${extra}` });
// imitates callBackend's transport classification (server/backend.ts): 401/403 = signature refused, 429/5xx = cannot serve
const ok = (status: number, body: unknown) =>
  status === 401 || status === 403 ? { kind: "rejected" as const, status } : status === 429 || status >= 500 ? { kind: "unavailable" as const, status } : { kind: "ok" as const, status, json: body };
const no = (code: string) => ok(400, { detail: { code } });

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[];
let api: { config: { owner_auth: boolean; passkeys: boolean }; code: string; sessions: Set<string>; down: boolean };
const backend = vi.fn(async ({ path, body }: Call) => {
  calls.push({ path, body });
  if (api.down) return { kind: "unavailable" as const };
  const p = path.replace("/internal/v1/auth/", "");
  switch (p) {
    case "config": return ok(200, api.config);
    case "session": return api.sessions.has(body.session as string) ? ok(200, { account_id: ACCOUNT }) : no("unauthorized");
    case "login/code": return body.code === api.code ? ok(200, { session: SECRET }) : no("unauthorized");
    case "logout": case "logout-all": return ok(200, {});
    case "passkeys/list": return ok(200, { passkeys: [{ id: KEY_ID, name: "iPhone", created_at: "2026-11-01T00:00:00Z", last_used_at: null }] });
    case "passkeys/delete": return ok(200, {});
    case "passkeys/login/options": case "passkeys/register/options": return ok(200, { options: { challenge: "Y2hhbA" }, challenge: "sealed.challenge.v1" });
    case "passkeys/login/verify": return body.challenge === "sealed.challenge.v1" ? ok(200, { session: SECRET }) : no("challenge_invalid");
    case "passkeys/register/verify": return body.name === "dup" ? no("passkey_exists") : ok(200, { id: KEY_ID });
  }
  return ok(404, {});
});
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW, ...over });
const req = (method: string, path: string, headers: Record<string, string> = same, body?: unknown) =>
  new Request(`https://${HOST}/api/auth/${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = (method: string, path: string, headers?: Record<string, string>, body?: unknown, d = deps()) => handleAuth(req(method, path, headers, body), path.split("/"), d);
const onlyAuthPaths = () => calls.map((c) => c.path.replace("/internal/v1/auth/", ""));

beforeEach(() => {
  calls = []; backend.mockClear(); resetOwnerSessionCache(); resetAuthLimits(); resetBashtLimits();
  api = { config: { owner_auth: true, passkeys: true }, code: "owner-code-0123456789-abcdefghijklmnop", sessions: new Set([SECRET]), down: false };
});

describe("unified owner sign-in: switch", () => {
  it("OWNER_AUTH off: status says off, every route is disabled and the API is never called", async () => {
    const d = deps({ env: base });
    expect(await (await call("GET", "status", same, undefined, d)).json()).toEqual({ owner_auth: false, passkeys: false, authenticated: false, gate: false, unavailable: false });
    expect((await call("POST", "login/code", same, { code: api.code }, d)).status).toBe(503);
    expect((await call("GET", "passkeys", withSession(), undefined, d)).status).toBe(503);
    expect(backend).not.toHaveBeenCalled();
  });
  it("on in the web but off in the API reads as off (fail closed); an outage is not cached", async () => {
    api.config = { owner_auth: false, passkeys: true };
    expect(await (await call("GET", "status")).json()).toEqual({ owner_auth: false, passkeys: false, authenticated: false, gate: true, unavailable: false }); // gate on + API answered "off" → login page says "unconfigured"
    resetOwnerSessionCache(); api.down = true;
    expect(await (await call("GET", "status")).json()).toMatchObject({ owner_auth: false, unavailable: true }); // could not ask ≠ "off"
    api.down = false; api.config = { owner_auth: true, passkeys: false };
    expect(await (await call("GET", "status", withSession())).json()).toEqual({ owner_auth: true, passkeys: false, authenticated: true, gate: true, unavailable: false });
  });
});

describe("unified owner sign-in: owner code", () => {
  it("right code → HttpOnly SameSite=Strict Secure session cookie on Path=/; browser-session unless remembered (30 days)", async () => {
    const r = await call("POST", "login/code", same, { code: api.code, remember: false });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(new RegExp(`^${SESSION_COOKIE}=${SECRET};`)); expect(sc).toContain("Path=/;"); expect(sc).toContain("HttpOnly"); expect(sc).toContain("SameSite=Strict"); expect(sc).toContain("Secure");
    expect(sc).not.toContain("Max-Age");
    expect(await r.text()).not.toContain(SECRET); // the secret only ever travels in the cookie
    const remembered = (await call("POST", "login/code", same, { code: api.code, remember: true })).headers.get("set-cookie")!;
    expect(remembered).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(calls.find((c) => c.path.endsWith("login/code"))!.body).toEqual({ code: api.code, remember: false, device: "جهاز" });
  });
  it("wrong code → 401, then throttled per client before reaching the API again", async () => {
    for (let i = 0; i < 5; i++) expect((await call("POST", "login/code", same, { code: "nope" })).status).toBe(401);
    const before = calls.length;
    expect((await call("POST", "login/code", same, { code: api.code })).status).toBe(429);
    expect(calls.length).toBe(before);
  });
  it("cross-site and malformed requests are refused before the API", async () => {
    const cross = { ...same, origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    expect((await call("POST", "login/code", cross, { code: api.code })).status).toBe(403);
    expect((await call("POST", "login/code", same, { code: 7 })).status).toBe(400);
    expect((await call("POST", "login/code", same, { code: "x".repeat(300) })).status).toBe(400);
    expect(onlyAuthPaths().filter((p) => p !== "config")).toEqual([]);
  });
});

describe("unified owner sign-in: API refusals reach the browser with the right status", () => {
  it("400+code from the API becomes 401/403/409/429; a transport failure stays 503 and is never read as a wrong code", async () => {
    const d = (fn: () => unknown) => deps({ callBackend: (async (a: Call) => (a.path.endsWith("config") ? ok(200, api.config) : fn())) as unknown as Deps["callBackend"] });
    const login = (fn: () => unknown) => call("POST", "login/code", same, { code: "x" }, d(fn));
    expect((await login(() => no("rate_limited"))).status).toBe(429);
    expect(await (await login(() => no("owner_disabled"))).json()).toEqual({ error: "forbidden" });
    expect((await login(() => no("whatever"))).status).toBe(400);
    expect((await login(() => ({ kind: "rejected", status: 401 }))).status).toBe(503); // our signature refused ≠ wrong code
    expect((await login(() => ({ kind: "unavailable", status: 429 }))).status).toBe(503);
    expect((await call("POST", "passkeys/register/verify", withSession(SECRET, "; safwan_wa=c"), { credential: { id: "x" }, name: "dup" })).status).toBe(409);
  });
  it("transport failures do not count against the code throttle", async () => {
    const d = deps({ callBackend: (async (a: Call) => (a.path.endsWith("config") ? ok(200, api.config) : { kind: "unreachable" })) as unknown as Deps["callBackend"] });
    for (let i = 0; i < 6; i++) expect((await call("POST", "login/code", same, { code: "x" }, d)).status).toBe(503);
    expect((await call("POST", "login/code", same, { code: api.code })).status).toBe(200);
  });
});

describe("unified owner sign-in: session, devices, sign-out", () => {
  it("device routes need a valid session; the lookup is cached briefly", async () => {
    expect((await call("GET", "passkeys")).status).toBe(401);
    expect((await call("GET", "passkeys", withSession(OTHER))).status).toBe(401);
    const r = await call("GET", "passkeys", withSession());
    expect(r.status).toBe(200);
    expect((await r.json()).passkeys).toHaveLength(1);
    await call("GET", "passkeys", withSession());
    expect(onlyAuthPaths().filter((p) => p === "session").length).toBe(2); // OTHER once, SECRET once (cached on the second call)
  });
  it("delete validates the id and passes the session, never trusting a body account", async () => {
    expect((await call("POST", "passkeys/delete", withSession(), { id: "../x" })).status).toBe(400);
    expect((await call("POST", "passkeys/delete", withSession(), { id: KEY_ID, account_id: "other" })).status).toBe(200);
    expect(calls.find((c) => c.path.endsWith("passkeys/delete"))!.body).toEqual({ session: SECRET, id: KEY_ID });
  });
  it("logout revokes server-side, clears the cookie and the cached lookup", async () => {
    expect((await call("GET", "status", withSession())).status).toBe(200);
    const r = await call("POST", "logout", withSession());
    expect(r.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0`));
    expect(calls.find((c) => c.path.endsWith("/logout"))!.body).toEqual({ session: SECRET });
    api.sessions.delete(SECRET);
    expect((await (await call("GET", "status", withSession())).json()).authenticated).toBe(false);
  });
  it("logout-all ends every session", async () => {
    await call("POST", "logout-all", withSession());
    expect(onlyAuthPaths()).toContain("logout-all");
  });
});

describe("unified owner sign-in: Face ID (passkeys)", () => {
  it("login: options set a sealed challenge cookie scoped to /api/auth; verify uses it, clears it and opens the session", async () => {
    const o = await call("POST", "passkeys/login/options", same, {});
    expect(o.status).toBe(200);
    expect(await o.json()).toEqual({ options: { challenge: "Y2hhbA" } }); // the sealed value is not in the body
    const wa = o.headers.get("set-cookie")!;
    expect(wa).toMatch(/^safwan_wa=sealed\.challenge\.v1; Path=\/api\/auth; Max-Age=300; HttpOnly; SameSite=Strict; Secure$/);
    expect((await call("POST", "passkeys/login/verify", same, { credential: { id: "x" } })).status).toBe(400); // no challenge cookie
    const v = await call("POST", "passkeys/login/verify", { ...same, cookie: "safwan_wa=sealed.challenge.v1" }, { credential: { id: "x" }, remember: true });
    expect(v.status).toBe(200);
    const cookies = v.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=${SECRET};`) && c.includes("Max-Age=2592000"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("safwan_wa=;") && c.includes("Max-Age=0"))).toBe(true);
  });
  it("a failed verify still clears the challenge (single use)", async () => {
    const v = await call("POST", "passkeys/login/verify", { ...same, cookie: "safwan_wa=forged" }, { credential: { id: "x" } });
    expect(v.status).toBe(400);
    expect(v.headers.get("set-cookie")).toMatch(/^safwan_wa=; .*Max-Age=0/);
  });
  it("register needs a signed-in owner; disabled while the API has no public origin", async () => {
    expect((await call("POST", "passkeys/register/options", same, {})).status).toBe(401);
    expect((await call("POST", "passkeys/register/options", withSession(), {})).status).toBe(200);
    const r = await call("POST", "passkeys/register/verify", withSession(SECRET, "; safwan_wa=sealed.challenge.v1"), { credential: { id: "x" }, name: "  آيفون صفوان  " });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.path.endsWith("register/verify"))!.body).toMatchObject({ session: SECRET, challenge: "sealed.challenge.v1", name: "آيفون صفوان" });
    resetOwnerSessionCache(); api.config = { owner_auth: true, passkeys: false };
    expect((await call("POST", "passkeys/login/options", same, {})).status).toBe(503);
    expect((await call("POST", "passkeys/register/options", withSession(), {})).status).toBe(503);
  });
});

describe("one session opens every door", () => {
  const bashtEnv = { ...env, BASHT_CHAT_ACCESS_CODE: "basht-owner-code-0123456789-abcdefghijkl" };
  const basht = (method: string, path: string, headers: Record<string, string>, body?: unknown, e: Record<string, string> = bashtEnv) =>
    handleBashtChat(new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), path.split("/"), { env: e, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW });

  it("doorAccess: legacy cookie wins without a lookup; owner session needs OWNER_AUTH=on; no cookie → no API call", async () => {
    const d = deps();
    expect(await doorAccess(new Request(`https://${HOST}/x`), d, { on: false, ok: true })).toEqual({ enabled: true, authenticated: true, account: null , outage: false });
    expect(await doorAccess(new Request(`https://${HOST}/x`), d, { on: false, ok: false })).toEqual({ enabled: true, authenticated: false, account: null , outage: false });
    expect(backend).not.toHaveBeenCalled();
    expect(await doorAccess(new Request(`https://${HOST}/x`, { headers: withSession() }), d, { on: false, ok: false })).toEqual({ enabled: true, authenticated: true, account: ACCOUNT , outage: false });
    expect(await doorAccess(new Request(`https://${HOST}/x`, { headers: withSession() }), deps({ env: base }), { on: false, ok: false })).toEqual({ enabled: false, authenticated: false, account: null , outage: false });
  });
  it("the BASHT chat door accepts the owner session and ignores it when the switch is off", async () => {
    expect(await (await basht("GET", "status", withSession())).json()).toEqual({ enabled: true, authenticated: true });
    expect(await (await basht("GET", "status", withSession(OTHER))).json()).toEqual({ enabled: true, authenticated: false });
    const { OWNER_AUTH: _off, ...legacyOnly } = bashtEnv;
    expect(await (await basht("GET", "status", withSession(), undefined, legacyOnly)).json()).toEqual({ enabled: true, authenticated: false });
  });
  it("the legacy unlock form signs in to the unified session when it is on (one code for the app)", async () => {
    const r = await basht("POST", "session", same, { code: api.code });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=${SECRET};`));
    expect(onlyAuthPaths()).toContain("login/code");
  });
});

describe("review fixes (gate): an outage is never a sign-out", () => {
  const sessionDown = () => deps({ callBackend: (async (a: Call) => (a.path.endsWith("config") ? ok(200, api.config) : a.path.endsWith("/session") ? ok(503, {}) : backend(a))) as unknown as Deps["callBackend"] });
  it("status: the database is down → unavailable, not signed out (the watcher stays put)", async () => {
    expect(await (await call("GET", "status", withSession(), undefined, sessionDown())).json()).toMatchObject({ authenticated: false, unavailable: true });
  });
  it("doors answer 503 unavailable (shown as offline), not 401", async () => {
    const d = { env: { ...env, BASHT_CHAT_ACCESS_CODE: "basht-owner-code-0123456789-abcdefghijkl" }, callBackend: sessionDown().callBackend, now: () => NOW };
    const r = await handleBashtChat(new Request(`https://${HOST}/api/basht/sessions`, { headers: withSession() }), ["sessions"], d);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "unavailable" });
  });
  it("signed-in routes: 503 during an outage, 401 only when the API said no", async () => {
    expect((await call("GET", "passkeys", withSession(), undefined, sessionDown())).status).toBe(503);
    expect((await call("GET", "passkeys", withSession(OTHER))).status).toBe(401);
  });
});
