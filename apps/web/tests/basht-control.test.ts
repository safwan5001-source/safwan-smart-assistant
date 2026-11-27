import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASHT_COOKIE, handleBashtChat, readBashtGate, resetBashtLimits, type Deps } from "@/server/basht-chat";
import { issueCookieValue } from "@/server/assistant-chat-gate";
import { channelState, clock, count, createControlClient, duration, everyLabel, formatCost, formatTokens, latestOnly, missingText, relative, scheduleLabel, toolGroupLabel } from "@/lib/basht-control";
import { morePathsFor, navFor } from "@/lib/nav";

const CODE = "basht-owner-code-0123456789-abcdefghijkl";
const HOST = "app.example.test";
const JOB = "e1e667e6-3167-4e9e-82e6-eeeda67c9afc";
const REF = "0123456789abcdef01234567";
const env = { BASHT_CHAT_ACCESS_CODE: CODE, BACKEND_URL: "https://api.internal.example", SERVICE_AUTH_SECRET: "s".repeat(48), NODE_ENV: "production" };
const gate = readBashtGate(env)!;
const NOW = 1_800_000_000_000;
const same = { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" };
const authed = { ...same, cookie: `${BASHT_COOKIE}=${issueCookieValue(gate, NOW)}` };
const ok = (status: number, body: unknown) => ({ kind: "ok" as const, status, json: body });
let backend: ReturnType<typeof vi.fn>;
const deps = (): Deps => ({ env, callBackend: backend as unknown as Deps["callBackend"], now: () => NOW });
const call = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = { headers: authed }) =>
  handleBashtChat(new Request(`https://${HOST}/api/basht/${path}`, { method, headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) }), path.split("?")[0].split("/"), deps());
const lastCall = () => backend.mock.calls.at(-1)![0] as { path: string; method: string; body?: unknown; timeoutMs: number };
beforeEach(() => { backend = vi.fn(async () => ok(200, { ok: true })); resetBashtLimits(); });

describe("BFF: BASHT control routes (B5–B7)", () => {
  it("sit behind the owner gate: no cookie → 401 and the API is never called", async () => {
    for (const [m, p, body] of [["GET", "automations"], ["POST", `automations/${JOB}/run`, {}], ["GET", "usage"], ["GET", "memory/search?q=x"], ["GET", "capabilities"]] as const) {
      expect((await call(m, p, { headers: same, body })).status, `${m} ${p}`).toBe(401);
    }
    expect(backend).not.toHaveBeenCalled();
  });
  it("cross-site writes are refused before the API", async () => {
    const r = await call("POST", `automations/${JOB}/run`, { headers: { ...authed, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: {} });
    expect(r.status).toBe(403);
    expect(backend).not.toHaveBeenCalled();
  });
  it("maps every route to a fixed API path; parameterised reads become JSON bodies (no query strings)", async () => {
    await call("GET", "automations"); expect(lastCall()).toMatchObject({ path: "/internal/v1/basht/automations", method: "GET" });
    await call("GET", `automations/${JOB}/runs`); expect(lastCall().path).toBe(`/internal/v1/basht/automations/${JOB}/runs`);
    await call("POST", `automations/${JOB}/run`, { headers: authed, body: { mode: "due" } });
    expect(lastCall()).toMatchObject({ path: `/internal/v1/basht/automations/${JOB}/run`, method: "POST", body: {} });
    expect(lastCall().timeoutMs).toBeGreaterThanOrEqual(45_000);
    await call("POST", `automations/${JOB}/enabled`, { headers: authed, body: { enabled: false, patch: { schedule: 1 } } });
    expect(lastCall()).toMatchObject({ path: `/internal/v1/basht/automations/${JOB}/enabled`, body: { enabled: false } });
    await call("GET", "usage"); expect(lastCall().path).toBe("/internal/v1/basht/usage");
    await call("GET", "memory/status"); expect(lastCall().path).toBe("/internal/v1/basht/memory/status");
    await call("GET", `memory/search?q=${encodeURIComponent(" النخبة ")}&page=1`);
    expect(lastCall()).toMatchObject({ path: "/internal/v1/basht/memory/search", method: "POST", body: { q: "النخبة", page: 1 } });
    await call("GET", `memory/item?ref=${REF}&part=2`); expect(lastCall()).toMatchObject({ path: "/internal/v1/basht/memory/item", body: { ref: REF, part: 2 } });
    await call("GET", "memory/file?name=USER.md"); expect(lastCall()).toMatchObject({ path: "/internal/v1/basht/memory/file", body: { name: "USER.md", part: 0 } });
    await call("GET", "capabilities"); expect(lastCall().timeoutMs).toBeGreaterThanOrEqual(45_000);
  });
  it("validates inputs before the API", async () => {
    const bad = [["GET", "automations/..%2Fx/runs"], ["GET", "automations/ABC.def/runs"], ["POST", `automations/${JOB}/enabled`, { enabled: "false" }],
      ["GET", "memory/search?q="], ["GET", `memory/search?q=${"x".repeat(201)}`], ["GET", "memory/search?q=x&page=3"], ["GET", "memory/item?ref=memory/a.md"],
      ["GET", `memory/item?ref=${REF}&part=10`], ["GET", "memory/file?name=AGENTS.md"], ["GET", "memory/file?name=../openclaw.json"]] as const;
    for (const [m, p, body] of bad) expect([400, 404], `${m} ${p}`).toContain((await call(m, p, { headers: authed, body })).status);
    expect(backend).not.toHaveBeenCalled();
    expect((await call("DELETE", `automations/${JOB}/run`)).status).toBe(404);
  });
  it("passes only the fixed refusal codes; anything else is generic", async () => {
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "system_job" } }));
    expect(await (await call("POST", `automations/${JOB}/run`, { headers: authed, body: {} })).json()).toEqual({ error: "system_job" });
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "control_unavailable" } }));
    expect(await (await call("GET", "automations")).json()).toEqual({ error: "control_unavailable" });
    backend.mockResolvedValueOnce(ok(400, { detail: { code: "path /data/x leaked" } }));
    expect(await (await call("GET", "usage")).json()).toEqual({ error: "bad_request" });
    backend.mockResolvedValueOnce(ok(409, { detail: { code: "busy" } }));
    expect((await call("POST", `automations/${JOB}/run`, { headers: authed, body: {} })).status).toBe(409);
    backend.mockResolvedValueOnce({ kind: "unreachable" });
    expect((await call("GET", "capabilities")).status).toBe(503);
  });
});

describe("browser control client", () => {
  it("turns refusals into BashtError codes and builds same-origin paths", async () => {
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("enabled") ? { error: "system_job" } : { jobs: [] }), { status: url.includes("enabled") ? 400 : 200 }));
    const c = createControlClient(f as unknown as typeof fetch);
    expect(await c.automations()).toEqual([]);
    await expect(c.setEnabled(JOB, false)).rejects.toMatchObject({ code: "system_job" });
    expect(f.mock.calls[1][0]).toBe(`/api/basht/automations/${JOB}/enabled`);
  });
});

describe("formatters", () => {
  it("schedules in Arabic, never a guess for unknown shapes", () => {
    expect(scheduleLabel({ kind: "cron", expr: "0 7 * * *", tz: "Asia/Riyadh" })).toBe("يوميًا الساعة 7:00 ص (بتوقيت الرياض)");
    expect(scheduleLabel({ kind: "cron", expr: "30 9 * * 0", tz: null })).toBe("كل يوم الأحد الساعة 9:30 ص");
    expect(scheduleLabel({ kind: "cron", expr: "0 18 * * 1-5", tz: null })).toBe("من الاثنين إلى الجمعة الساعة 6:00 م");
    expect(scheduleLabel({ kind: "cron", expr: "0 9 * * 0,3", tz: null })).toBe("أيام الأحد والأربعاء الساعة 9:00 ص");
    expect(scheduleLabel({ kind: "cron", expr: "*/15 * * * *", tz: null })).toBe("كل 15 دقيقة");
    expect(scheduleLabel({ kind: "cron", expr: "0 */4 * * *", tz: null })).toBe("كل 4 ساعات");
    expect(scheduleLabel({ kind: "cron", expr: "0 12 1 * *", tz: null })).toBe("يوم 1 من كل شهر الساعة 12:00 م");
    expect(scheduleLabel({ kind: "cron", expr: "0 0 L * ?", tz: null })).toBe("جدول مخصص: 0 0 L * ?");
    expect(scheduleLabel({ kind: "every", every_ms: 6 * 3_600_000 })).toBe("كل 6 ساعات");
    expect(scheduleLabel({ kind: "other" })).toBe("حسب حدث في باشت");
    expect(everyLabel(86_400_000)).toBe("كل يوم");
    expect(everyLabel(90 * 60_000)).toBe("كل ساعة و30 دقيقة");
    expect(everyLabel(2 * 3_600_000)).toBe("كل ساعتين");
  });
  it("counts, clock, relative time, duration", () => {
    expect([count(1, "ساعة", "ساعتين", "ساعات"), count(2, "ساعة", "ساعتين", "ساعات"), count(5, "ساعة", "ساعتين", "ساعات"), count(12, "ساعة", "ساعتين", "ساعات")])
      .toEqual(["ساعة", "ساعتين", "5 ساعات", "12 ساعة"]);
    expect(clock(0, 5)).toBe("12:05 ص");
    expect(clock(13, 0)).toBe("1:00 م");
    expect(relative(NOW + 3 * 3_600_000, NOW)).toBe("بعد 3 ساعات");
    expect(relative(NOW - 5 * 60_000, NOW)).toBe("قبل 5 دقائق");
    expect(relative(NOW - 10_000, NOW)).toBe("الآن");
    expect(relative(null, NOW)).toBe("");
    expect(duration(11_153)).toBe("11 ث");
    expect(duration(125_000)).toBe("2 د 5 ث");
    expect(duration(300)).toBe("أقل من ثانية");
  });
  it("tokens and cost: unknown cost is never $0", () => {
    expect(formatTokens(10953)).toBe("10,953");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatTokens(null)).toBe("—");
    expect(formatCost(null)).toBe("غير معروفة");
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(0.004)).toBe("< $0.01");
    expect(formatCost(1.5, true)).toBe("$1.50+ (جزئية)");
  });
  it("capability labels", () => {
    expect(channelState({ id: "whatsapp", label: "WhatsApp", accounts: 1, configured: true, linked: true, connected: true, last_connected_at: 1, issue: null }).label).toBe("متصل");
    expect(channelState({ id: "whatsapp", label: "WhatsApp", accounts: 1, configured: true, linked: true, connected: false, last_connected_at: 1, issue: null }).tone).toBe("warn");
    expect(missingText({ bins: ["op"], env: ["OP_TOKEN"], config: 2, os: false })).toBe("ينقصها أداة: op · متغير: OP_TOKEN · 2 إعدادات");
    expect(toolGroupLabel("fs", "Files")).toBe("الملفات");
    expect(toolGroupLabel("plugin:github", "github")).toBe("إضافة: github");
  });
  it("memory is reachable from المزيد and lights its tab", () => {
    expect(navFor(false).some((n) => n.href === "/memory")).toBe(true);
    expect(morePathsFor(false)).toContain("/memory");
  });
});

describe("memory search: latest request wins (Codex review on #63)", () => {
  it("a superseded search or page never counts as current", async () => {
    const latest = latestOnly();
    const shown: string[] = [];
    const search = async (q: string, ms: number) => {
      const t = latest.begin();
      await new Promise((r) => setTimeout(r, ms));
      if (latest.current(t)) shown.push(q);
    };
    await Promise.all([search("old", 30), search("new", 5)]); // the older request finishes last
    expect(shown).toEqual(["new"]);
    const page = latest.begin();
    const fresh = latest.begin(); // a new search started while page 2 of the previous one was loading
    expect(latest.current(page)).toBe(false);
    expect(latest.current(fresh)).toBe(true);
  });
});
