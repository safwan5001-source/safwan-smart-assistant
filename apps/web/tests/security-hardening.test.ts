/** Fixes of the independent security review (2026-11): client IP (L1), tagged session cookies + bounded lookups (M2),
 *  revocation latency (L2), passkey step-up and "remove all" (M3), device registration behind the owner session (M4). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/server/client-ip";
import { handleAuth, resetAuthLimits, type Deps } from "@/server/owner-auth";
import { checkOwnerSession, doorAccess, readSessionCookie, resetOwnerSessionCache, SESSION_CACHE_MS, SESSION_COOKIE, sessionCookieValue } from "@/server/owner-session";
import { handleNotify } from "@/server/notify/api";
import { buildRuntime, sessionOwnerGate } from "@/server/notify/runtime";
import { readNotifyConfig } from "@/server/notify/config";
import { createMemoryStore } from "@/server/notify/memory-store";
import { testEnv } from "./notify-helpers";

const HOST = "app.example.test";
const env = { BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production", OWNER_AUTH: "on" };
const ACCOUNT = "0b5c1d0e-1111-4222-8333-444455556666";
const SECRET = "A".repeat(43);
const secretN = (n: number) => n.toString(36).padStart(43, "x");
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const cookieOf = (s: string) => `${SESSION_COOKIE}=${sessionCookieValue(s, env)}`;

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[];
let live: Set<string>;
const ok = (status: number, json: unknown) => ({ kind: "ok" as const, status, json });
const backend = vi.fn(async ({ path, body }: Call) => {
  calls.push({ path, body });
  const p = path.replace("/internal/v1/auth/", "");
  if (p === "config") return ok(200, { owner_auth: true, passkeys: true });
  if (p === "session") return live.has(body.session as string) ? ok(200, { account_id: ACCOUNT }) : ok(400, { detail: { code: "unauthorized" } });
  if (p === "passkeys/register/options") return body.code === "right-code" ? ok(200, { options: { challenge: "Y2hhbA" }, challenge: "sealed" }) : ok(400, { detail: { code: "reauth_failed" } });
  if (p === "passkeys/delete-all") return ok(200, { ok: true, removed: 2 });
  if (p === "sessions/revoke") return ok(200, { ok: true, current: false });
  return ok(404, {});
});
let clock = 1_800_000_000_000;
const deps = (over: Partial<Deps> = {}): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => clock, ...over });
const req = (path: string, headers: Record<string, string>, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  new Request(`https://${HOST}/api/auth/${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const sessionLookups = () => calls.filter((c) => c.path.endsWith("/session")).length;

beforeEach(() => {
  calls = []; backend.mockClear(); resetOwnerSessionCache(); resetAuthLimits(); clock = 1_800_000_000_000;
  live = new Set([SECRET]);
});

describe("L1: one client-IP helper for every limiter", () => {
  const r = (h: Record<string, string>) => new Request("https://x/", { headers: h });
  it("trusts the edge-set X-Real-IP, then only the LAST X-Forwarded-For hop; a client-written first hop is ignored", () => {
    expect(clientIp(r({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(r({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(r({ "x-real-ip": "not an ip<script>" }))).toBe("unknown");
    expect(clientIp(r({}))).toBe("unknown");
  });
});

describe("M2: made-up session cookies never reach the API", () => {
  it("only a cookie tagged by this BFF is read; a bare or forged secret costs no lookup", async () => {
    const tagged = sessionCookieValue(SECRET, env)!;
    expect(tagged).toMatch(/^A{43}\.[A-Za-z0-9_-]{22}$/);
    expect(readSessionCookie(new Request("https://x/", { headers: { cookie: `${SESSION_COOKIE}=${tagged}` } }), env)).toBe(SECRET);
    for (const v of [SECRET, `${SECRET}.${"A".repeat(22)}`, `${secretN(7)}.${tagged.split(".")[1]}`, `${tagged}x`]) {
      const forged = new Request("https://x/", { headers: { cookie: `${SESSION_COOKIE}=${v}` } });
      expect(readSessionCookie(forged, env), v).toBeUndefined();
      expect(await doorAccess(forged, deps(), { on: false, ok: false })).toMatchObject({ authenticated: false, outage: false });
    }
    expect(readSessionCookie(new Request("https://x/", { headers: { cookie: `${SESSION_COOKIE}=${tagged}` } }), { ...env, SERVICE_AUTH_SECRET: "t".repeat(48) })).toBeUndefined();
    expect(backend).not.toHaveBeenCalled();
  });
  it("uncached lookups are limited per client (an outage answer, never 'signed out'), others are unaffected", async () => {
    const at = (n: number, ip: string) => new Request("https://x/", { headers: { cookie: cookieOf(secretN(n)), "x-real-ip": ip } });
    for (let i = 0; i < 60; i++) expect((await checkOwnerSession(at(i, "203.0.113.9"), deps())).outage).toBe(false);
    expect(await checkOwnerSession(at(99, "203.0.113.9"), deps())).toEqual({ account: null, outage: true });
    expect(sessionLookups()).toBe(60);
    expect(await checkOwnerSession(new Request("https://x/", { headers: { cookie: cookieOf(SECRET), "x-real-ip": "198.51.100.1" } }), deps())).toEqual({ account: ACCOUNT, outage: false });
  });
  it("the cache is a bounded LRU: a flood of other sessions never evicts the owner's recent entry", async () => {
    const owner = new Request("https://x/", { headers: { cookie: cookieOf(SECRET), "x-real-ip": "198.51.100.1" } });
    await checkOwnerSession(owner, deps());
    for (let i = 0; i < 1200; i++) {
      await checkOwnerSession(new Request("https://x/", { headers: { cookie: cookieOf(secretN(i)), "x-real-ip": `10.0.${i >> 8}.${i & 255}` } }), deps());
      if (i % 200 === 0) await checkOwnerSession(owner, deps()); // the owner keeps using the app
    }
    const before = sessionLookups();
    expect((await checkOwnerSession(owner, deps())).account).toBe(ACCOUNT);
    expect(sessionLookups()).toBe(before); // still cached
  });
});

describe("L2: revocation is seen at once on this instance", () => {
  it("ending another device's session drops the cached answers; the cache lives only a few seconds anyway", async () => {
    const other = secretN(5); live.add(other);
    const otherReq = new Request("https://x/", { headers: { cookie: cookieOf(other) } });
    expect((await checkOwnerSession(otherReq, deps())).account).toBe(ACCOUNT);
    await handleAuth(req("sessions/revoke", { ...same, cookie: cookieOf(SECRET) }, { id: ACCOUNT }), ["sessions", "revoke"], deps());
    live.delete(other);
    expect((await checkOwnerSession(otherReq, deps())).account).toBeNull();
    expect(SESSION_CACHE_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("M3: adding Face ID needs the owner code again; all passkeys can be removed", () => {
  const signedIn = { ...same, cookie: cookieOf(SECRET) };
  it("register/options requires the code (step-up), passes it with the client key, and a wrong code is 403, never a sign-out", async () => {
    expect((await handleAuth(req("passkeys/register/options", signedIn, {}), ["passkeys", "register", "options"], deps())).status).toBe(400);
    const wrong = await handleAuth(req("passkeys/register/options", { ...signedIn, "x-real-ip": "203.0.113.4" }, { code: "nope" }), ["passkeys", "register", "options"], deps());
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "wrong_code" });
    expect(calls.find((c) => c.path.endsWith("register/options"))!.body).toEqual({ session: SECRET, code: "nope", client: "203.0.113.4" });
    const right = await handleAuth(req("passkeys/register/options", signedIn, { code: "right-code" }), ["passkeys", "register", "options"], deps());
    expect(right.status).toBe(200);
  });
  it("wrong step-up codes are throttled per client like the login", async () => {
    const h = { ...signedIn, "x-real-ip": "203.0.113.4" };
    for (let i = 0; i < 5; i++) await handleAuth(req("passkeys/register/options", h, { code: "nope" }), ["passkeys", "register", "options"], deps());
    expect((await handleAuth(req("passkeys/register/options", h, { code: "right-code" }), ["passkeys", "register", "options"], deps())).status).toBe(429);
    expect((await handleAuth(req("passkeys/register/options", { ...signedIn, "x-real-ip": "198.51.100.2" }, { code: "right-code" }), ["passkeys", "register", "options"], deps())).status).toBe(200);
  });
  it("passkeys/delete-all needs a session and removes every passkey", async () => {
    expect((await handleAuth(req("passkeys/delete-all", same, {}), ["passkeys", "delete-all"], deps())).status).toBe(401);
    const r = await handleAuth(req("passkeys/delete-all", signedIn, {}), ["passkeys", "delete-all"], deps());
    expect(await r.json()).toEqual({ ok: true, removed: 2 });
    expect(calls.find((c) => c.path.endsWith("delete-all"))!.body).toEqual({ session: SECRET });
  });
});

describe("M4: device registration is behind the owner session when the login gate is on", () => {
  const rt = (gate: "ok" | "unauthorized" | "unavailable") =>
    buildRuntime(readNotifyConfig(testEnv()), { store: createMemoryStore(), send: async () => ({ status: 201 }), ownerGate: async () => gate });
  it("POST /devices: 401 without the owner session, 503 when it cannot be checked, 201 with it", async () => {
    const post = () => new Request("http://x/api/notify/devices", { method: "POST" });
    for (const [gate, status] of [["unauthorized", 401], ["unavailable", 503], ["ok", 201]] as const) {
      const r = rt(gate);
      expect((await handleNotify(post(), ["devices"], r)).status, gate).toBe(status);
      expect(await r.store!.countDevices(), gate).toBe(status === 201 ? 1 : 0);
    }
  });
  it("the gate: off → open (behaviour unchanged); on → only a valid owner session", async () => {
    const call = backend as unknown as Deps["callBackend"];
    expect(await sessionOwnerGate({ ...env, OWNER_AUTH: "" }, call)(new Request("http://x/"))).toBe("ok");
    expect(await sessionOwnerGate(env, call)(new Request("http://x/"))).toBe("unauthorized");
    expect(await sessionOwnerGate(env, call)(new Request("http://x/", { headers: { cookie: cookieOf(secretN(3)) } }))).toBe("unauthorized");
    expect(await sessionOwnerGate(env, call)(new Request("http://x/", { headers: { cookie: cookieOf(SECRET) } }))).toBe("ok");
    const down = (async () => ({ kind: "unreachable" })) as unknown as Deps["callBackend"];
    resetOwnerSessionCache();
    expect(await sessionOwnerGate(env, down)(new Request("http://x/", { headers: { cookie: cookieOf(SECRET) } }))).toBe("unavailable");
  });
});
