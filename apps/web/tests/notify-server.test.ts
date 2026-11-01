import { describe, expect, it } from "vitest";
import { readNotifyConfig } from "@/server/notify/config";
import { isAllowedEndpoint, parseSubscription, parseSyncBody } from "@/server/notify/validate";
import { dispatchTick, MAX_ATTEMPTS } from "@/server/notify/dispatch";
import { handleNotify, createLimiter } from "@/server/notify/api";
import { buildRuntime } from "@/server/notify/runtime";
import { GENERIC_BODY, GENERIC_TITLE, type PushPayload } from "@/server/notify/push";
import { hashToken, safeEqualHex } from "@/server/notify/auth";
import { fakeSender, makeRuntime, makeSubscription, mkReminder, registerDevice, req, riyadh, testEnv, vapid } from "./notify-helpers";

const NOW = riyadh(2026, 11, 2, 2, 0);
const call = (rt: ReturnType<typeof makeRuntime>, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  handleNotify(req(method, body, headers), path.split("/").filter(Boolean), rt);

describe("configuration fails closed", () => {
  it("no keys → push unconfigured", () => {
    expect(readNotifyConfig({ NODE_ENV: "production" }).push).toBeNull();
    expect(readNotifyConfig({ ...testEnv(), VAPID_PUBLIC_KEY: "short" }).push).toBeNull();
    expect(readNotifyConfig({ ...testEnv(), VAPID_SUBJECT: "ops@example.com" }).push).toBeNull();
    expect(readNotifyConfig({ ...testEnv(), VAPID_SUBJECT: "http://insecure.example" }).push).toBeNull();
    expect(readNotifyConfig(testEnv()).push).toMatchObject({ publicKey: vapid.publicKey });
  });
  it("memory store is refused in production unless explicitly allowed; weak dispatch secrets are ignored", () => {
    expect(readNotifyConfig({ ...testEnv(), NODE_ENV: "production" }).allowMemory).toBe(false);
    expect(readNotifyConfig({ ...testEnv(), NODE_ENV: "production", NOTIFY_ALLOW_MEMORY: "1" }).allowMemory).toBe(true);
    expect(readNotifyConfig({ ...testEnv(), NOTIFY_DISPATCH_SECRET: "short" }).dispatchSecret).toBeNull();
    const rt = buildRuntime(readNotifyConfig({ ...testEnv(), NODE_ENV: "production" }));
    expect(rt.store).toBeNull(); expect(rt.storeKind).toBe("none");
  });
  it("API reports not_configured instead of pretending", async () => {
    const rt = buildRuntime(readNotifyConfig({ NODE_ENV: "production" }));
    expect(await (await call(rt, "GET", "/config")).json()).toMatchObject({ push: false, publicKey: null });
    const r = await call(rt, "POST", "/devices");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "not_configured" });
  });
});

describe("subscription endpoint validation (SSRF defence)", () => {
  const policy = { extraHosts: [], production: true };
  it("accepts only real push services over https", () => {
    for (const ok of ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(isAllowedEndpoint(ok, policy)).toBe(true);
    for (const bad of [
      "http://web.push.apple.com/x", "https://evil.example.com/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "http://127.0.0.1:8080/x",
      "https://web.push.apple.com.evil.com/x", "https://user:pw@web.push.apple.com/x", "https://web.push.apple.com:8443/x", "ftp://web.push.apple.com/x", "javascript:alert(1)", "not a url", "https://[::1]/x",
    ]) expect(isAllowedEndpoint(bad, policy)).toBe(false);
  });
  it("loopback mock hosts only outside production and only when explicitly listed", () => {
    expect(isAllowedEndpoint("http://127.0.0.1:9/x", { extraHosts: ["127.0.0.1"], production: false })).toBe(true);
    expect(isAllowedEndpoint("http://127.0.0.1:9/x", { extraHosts: ["127.0.0.1"], production: true })).toBe(false);
    expect(isAllowedEndpoint("http://127.0.0.1:9/x", { extraHosts: [], production: false })).toBe(false);
    expect(isAllowedEndpoint("https://10.0.0.5/x", { extraHosts: ["10.0.0.5"], production: false })).toBe(false); // private ranges never
  });
  it("keys must have the exact P-256 / auth sizes", () => {
    const { sub } = makeSubscription();
    expect(parseSubscription(sub, policy)).toEqual(sub);
    expect(parseSubscription({ ...sub, keys: { ...sub.keys, auth: "short" } }, policy)).toBeNull();
    expect(parseSubscription({ ...sub, keys: { ...sub.keys, p256dh: "x".repeat(87) + "!" } }, policy)).toBeNull();
    expect(parseSubscription(null, policy)).toBeNull();
    expect(parseSyncBody({ reminders: "no" })).toBeNull();
    expect(parseSyncBody({ reminders: [mkReminder(), { id: "bad" }], deleted: ["a", 5, ""] })).toMatchObject({ deleted: ["a"] });
  });
  it("auth helpers are constant-time safe on malformed input", () => {
    expect(safeEqualHex("zz", "zz")).toBe(false);
    expect(safeEqualHex(hashToken("a"), hashToken("a"))).toBe(true);
    expect(safeEqualHex(hashToken("a"), hashToken("b"))).toBe(false);
  });
});

describe("HTTP API", () => {
  it("registers a device and issues a one-time secret; stores only its hash", async () => {
    const rt = makeRuntime();
    const r = await call(rt, "POST", "/devices");
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { deviceId, token } = await r.json();
    const dev = (await rt.store!.getDevice(deviceId))!;
    expect(dev.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(dev)).not.toContain(token);
  });
  it("rejects missing / wrong / malformed credentials with one generic 401", async () => {
    const rt = makeRuntime(); const { deviceId, token } = await registerDevice(rt);
    for (const h of [{}, { Authorization: "Bearer nope" }, { Authorization: `Bearer ${deviceId}.${"A".repeat(43)}` }, { Authorization: `Bearer ${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.${token}` }, { Authorization: `Basic ${token}` }]) {
      const r = await call(rt, "GET", "/devices/me", undefined, h as Record<string, string>);
      expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: "unauthorized" });
    }
  });
  it("subscription: validates endpoint, saves prefs, can be removed", async () => {
    const rt = makeRuntime(); const { auth } = await registerDevice(rt);
    const bad = await call(rt, "PUT", "/devices/me/subscription", { subscription: { endpoint: "https://evil.example.com/x", keys: makeSubscription().sub.keys } }, auth);
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: "invalid_subscription" });
    const ok = await call(rt, "PUT", "/devices/me/subscription", { subscription: makeSubscription().sub, prefs: { lockScreenContent: true, quiet: { enabled: true, from: "23:00", to: "06:00" }, tz: "Asia/Riyadh" } }, auth);
    expect(ok.status).toBe(200);
    expect(await (await call(rt, "GET", "/devices/me", undefined, auth)).json()).toMatchObject({ subscribed: true, prefs: { lockScreenContent: true, quiet: { enabled: true, from: "23:00" } } });
    expect((await call(rt, "DELETE", "/devices/me/subscription", undefined, auth)).status).toBe(200);
    expect(await (await call(rt, "GET", "/devices/me", undefined, auth)).json()).toMatchObject({ subscribed: false });
  });
  it("bodies: wrong content type, oversized, malformed JSON → 400", async () => {
    const rt = makeRuntime(); const { auth } = await registerDevice(rt, makeSubscription().sub);
    expect((await handleNotify(new Request("http://x", { method: "PUT", headers: { ...auth, "content-type": "text/plain" }, body: "{}" }), ["reminders", "sync"], rt)).status).toBe(400);
    expect((await handleNotify(new Request("http://x", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: "{oops" }), ["reminders", "sync"], rt)).status).toBe(400);
    const big = JSON.stringify({ reminders: [], pad: "x".repeat(300 * 1024) });
    expect((await handleNotify(new Request("http://x", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: big }), ["reminders", "sync"], rt)).status).toBe(400);
  });
  it("sync requires push to be enabled, then merges last-writer-wins and honours tombstones", async () => {
    const rt = makeRuntime(); const dev = await registerDevice(rt);
    expect((await call(rt, "PUT", "/reminders/sync", { reminders: [], deleted: [] }, dev.auth)).status).toBe(409);
    await call(rt, "PUT", "/devices/me/subscription", { subscription: makeSubscription().sub }, dev.auth);
    const r1 = mkReminder({}, NOW, "s1");
    const a = await (await call(rt, "PUT", "/reminders/sync", { reminders: [r1], deleted: [] }, dev.auth)).json();
    expect(a.reminders).toHaveLength(1);
    const b = await (await call(rt, "PUT", "/reminders/sync", { reminders: [{ ...r1, title: "x", rev: 5 }], deleted: [] }, dev.auth)).json();
    expect(b.reminders[0]).toMatchObject({ title: "x", rev: 5 });
    const c = await (await call(rt, "PUT", "/reminders/sync", { reminders: [], deleted: ["s1"] }, dev.auth)).json();
    expect(c.reminders).toEqual([]);
  });
  it("devices are isolated from each other", async () => {
    const rt = makeRuntime(); const A = await registerDevice(rt, makeSubscription().sub); const B = await registerDevice(rt, makeSubscription().sub);
    await call(rt, "PUT", "/reminders/sync", { reminders: [mkReminder({}, NOW, "mine")], deleted: [] }, A.auth);
    expect((await (await call(rt, "PUT", "/reminders/sync", { reminders: [], deleted: [] }, B.auth)).json()).reminders).toEqual([]);
    await call(rt, "PUT", "/reminders/sync", { reminders: [], deleted: ["mine"] }, B.auth); // cannot delete another device's data
    expect(await rt.store!.listReminders(A.deviceId)).toHaveLength(1);
  });
  it("erasing the device removes everything", async () => {
    const rt = makeRuntime(); const d = await registerDevice(rt, makeSubscription().sub);
    await call(rt, "PUT", "/reminders/sync", { reminders: [mkReminder({}, NOW, "e1")], deleted: [] }, d.auth);
    expect((await call(rt, "DELETE", "/devices/me", undefined, d.auth)).status).toBe(200);
    expect(await rt.store!.getDevice(d.deviceId)).toBeNull();
    expect((await call(rt, "GET", "/devices/me", undefined, d.auth)).status).toBe(401);
  });
  it("test push: sends a generic message, handles dead subscriptions, rate-limits", async () => {
    const f = fakeSender(); const rt = makeRuntime({ send: f.send }); const d = await registerDevice(rt, makeSubscription().sub);
    const r = await call(rt, "POST", "/devices/me/test", undefined, d.auth);
    expect(await r.json()).toMatchObject({ sent: true });
    expect(JSON.parse(f.sent[0].payload)).toMatchObject({ kind: "test", title: GENERIC_TITLE, generic: true });
    for (let i = 0; i < 4; i++) await call(rt, "POST", "/devices/me/test", undefined, d.auth);
    expect((await call(rt, "POST", "/devices/me/test", undefined, d.auth)).status).toBe(429);
    const f2 = fakeSender(() => 410); const rt2 = makeRuntime({ send: f2.send }); const d2 = await registerDevice(rt2, makeSubscription().sub);
    expect(await (await call(rt2, "POST", "/devices/me/test", undefined, d2.auth)).json()).toMatchObject({ sent: false, subscriptionExpired: true });
    expect((await rt2.store!.getDevice(d2.deviceId))!.subscription).toBeNull();
  });
  it("dispatch endpoint needs the shared secret (constant-time) and never works without one", async () => {
    const f = fakeSender(); const rt = makeRuntime({ send: f.send });
    expect((await call(rt, "POST", "/dispatch")).status).toBe(401);
    expect((await call(rt, "POST", "/dispatch", undefined, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call(rt, "POST", "/dispatch", undefined, { Authorization: `Bearer ${"s".repeat(32)}` })).status).toBe(200);
    const rt2 = makeRuntime({ env: { NOTIFY_DISPATCH_SECRET: "" } });
    expect((await call(rt2, "POST", "/dispatch", undefined, { Authorization: "Bearer " })).status).toBe(503);
  });
  it("unknown routes 404; limiter is bounded", async () => {
    const rt = makeRuntime(); const d = await registerDevice(rt);
    expect((await call(rt, "GET", "/nope", undefined, d.auth)).status).toBe(404);
    const lim = createLimiter(2, 1000, 3);
    expect([lim("a", 0), lim("a", 1), lim("a", 2), lim("a", 1500)]).toEqual([true, true, false, true]);
    for (let i = 0; i < 20; i++) lim(`k${i}`, 0);
    expect(lim("fresh", 0)).toBe(true);
  });
});

describe("dispatcher", () => {
  const setup = async (prefs: unknown = {}, sender = fakeSender()) => {
    let now = NOW;
    const rt = makeRuntime({ send: sender.send, now: () => now });
    const dev = await registerDevice(rt, makeSubscription().sub, prefs);
    return { rt, dev, sender, setNow: (n: number) => { now = n; }, tick: () => dispatchTick(rt.store!, rt.send!, now), sync: (r: ReturnType<typeof mkReminder>[]) => rt.store!.syncReminders(dev.deviceId, r, [], NOW) };
  };
  const payloads = (s: ReturnType<typeof fakeSender>) => s.sent.map((x) => JSON.parse(x.payload) as PushPayload);

  it("sends one push at the due time, advances state, and never sends twice", async () => {
    const t = await setup(); const r = mkReminder({}, NOW, "p1"); await t.sync([r]);
    t.setNow(r.dueAt - 1000); expect(await t.tick()).toMatchObject({ fired: 0, sent: 0 });
    t.setNow(r.dueAt + 1000);
    expect(await t.tick()).toMatchObject({ fired: 1, sent: 1 });
    expect(await t.tick()).toMatchObject({ fired: 0, sent: 0 });
    expect(t.sender.sent).toHaveLength(1);
    expect((await t.rt.store!.listReminders(t.dev.deviceId))[0].status).toBe("fired");
    expect(t.sender.sent[0].opts).toMatchObject({ ttl: 3600, urgency: "normal" });
  });
  it("privacy: generic lock-screen text by default; real text only when the user opted in", async () => {
    const a = await setup(); const r = mkReminder({ title: "موعد الطبيب" }, NOW, "g1"); await a.sync([r]); a.setNow(r.dueAt); await a.tick();
    expect(payloads(a.sender)[0]).toMatchObject({ title: GENERIC_TITLE, body: GENERIC_BODY, generic: true });
    expect(a.sender.sent[0].payload).not.toContain("الطبيب");
    const b = await setup({ lockScreenContent: true }); await b.sync([{ ...r, id: "g2" }]); b.setNow(r.dueAt); await b.tick();
    expect(payloads(b.sender)[0]).toMatchObject({ generic: false, title: "تذكير: موعد الطبيب" });
  });
  it("critical reminders use high urgency; lead time is reflected in the text", async () => {
    const t = await setup({ lockScreenContent: true }); const r = mkReminder({ priority: "critical", leadMinutes: 30 }, NOW, "c1"); await t.sync([r]);
    t.setNow(r.dueAt - 30 * 60_000); await t.tick();
    expect(t.sender.sent[0].opts.urgency).toBe("high");
    expect(payloads(t.sender)[0].body).toContain("بعد 30 دقيقة");
  });
  it("recurring: one push per occurrence; a long outage collapses into one", async () => {
    const t = await setup(); const r = mkReminder({ repeat: "daily" }, NOW, "d1"); await t.sync([r]);
    t.setNow(r.dueAt + 1000); await t.tick();
    t.setNow(r.dueAt + 86_400_000 + 1000); await t.tick();
    expect(t.sender.sent).toHaveLength(2);
    t.setNow(r.dueAt + 6 * 86_400_000 + 1000); await t.tick();
    expect(t.sender.sent).toHaveLength(3); // days 3..6 collapsed
    expect(new Set(payloads(t.sender).map((p) => p.key)).size).toBe(3);
  });
  it("quiet hours hold the push until they end; critical bypasses only when allowed", async () => {
    const quiet = { enabled: true, from: "22:00", to: "07:00", allowCritical: false };
    const t = await setup({ quiet }); const r = mkReminder({ time: "23:30", date: "2026-11-03" }, NOW, "n1"); await t.sync([r]);
    t.setNow(r.dueAt + 1000); expect(await t.tick()).toMatchObject({ held: 1, sent: 0 });
    expect(t.sender.sent).toHaveLength(0);
    t.setNow(riyadh(2026, 11, 4, 6, 59)); expect(await t.tick()).toMatchObject({ sent: 0 });
    t.setNow(riyadh(2026, 11, 4, 7, 0) + 1000); expect(await t.tick()).toMatchObject({ fired: 1, sent: 1 });
    // critical, bypass not allowed → held; allowed → sent at once
    const c1 = await setup({ quiet }); const rc = mkReminder({ time: "23:30", date: "2026-11-03", priority: "critical" }, NOW, "n2"); await c1.sync([rc]); c1.setNow(rc.dueAt + 1000);
    expect(await c1.tick()).toMatchObject({ held: 1 });
    const c2 = await setup({ quiet: { ...quiet, allowCritical: true } }); await c2.sync([{ ...rc, id: "n3" }]); c2.setNow(rc.dueAt + 1000);
    expect(await c2.tick()).toMatchObject({ sent: 1 });
  });
  it("retries transient failures with backoff, then gives up after MAX_ATTEMPTS", async () => {
    const t = await setup({}, fakeSender(() => ({ status: 503, error: "http_503" }))); const r = mkReminder({}, NOW, "f1"); await t.sync([r]);
    let now = r.dueAt + 1000; t.setNow(now);
    expect(await t.tick()).toMatchObject({ sent: 0, retried: 1 });
    t.setNow(now + 10_000); expect(await t.tick()).toMatchObject({ retried: 0 }); // backoff not elapsed
    let total = 1;
    for (let i = 0; i < 10 && total < MAX_ATTEMPTS; i++) { now += 3_700_000; t.setNow(now); const rep = await t.tick(); total += rep.retried + rep.failed; }
    const d = (await t.rt.store!.listDeliveries(t.dev.deviceId, 5))[0];
    expect(d).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "http_503" });
  });
  it("recovers after a transient failure", async () => {
    const t = await setup({}, fakeSender((n) => (n === 1 ? 500 : 201))); const r = mkReminder({}, NOW, "f2"); await t.sync([r]);
    t.setNow(r.dueAt + 1000); await t.tick();
    t.setNow(r.dueAt + 1000 + 31_000); expect(await t.tick()).toMatchObject({ sent: 1 });
    expect((await t.rt.store!.listDeliveries(t.dev.deviceId, 5))[0].status).toBe("sent");
  });
  it("410/404 removes the dead subscription and the reminders tied to it", async () => {
    const t = await setup({}, fakeSender(() => 410)); const r = mkReminder({}, NOW, "x1"); await t.sync([r]);
    t.setNow(r.dueAt + 1000); expect(await t.tick()).toMatchObject({ gone: 1 });
    expect((await t.rt.store!.getDevice(t.dev.deviceId))!.subscription).toBeNull();
    expect(await t.rt.store!.listReminders(t.dev.deviceId)).toEqual([]);
  });
  it("stale deliveries expire instead of firing hours late", async () => {
    const t = await setup({}, fakeSender(() => 503)); const r = mkReminder({}, NOW, "e1"); await t.sync([r]);
    t.setNow(r.dueAt + 1000); await t.tick();
    t.setNow(r.dueAt + 7 * 3600_000); expect(await t.tick()).toMatchObject({ expired: 1, sent: 0 });
  });
  it("two dispatchers at once: exactly one runs, no duplicate send", async () => {
    const t = await setup(); const r = mkReminder({}, NOW, "m1"); await t.sync([r]); t.setNow(r.dueAt + 1000);
    const slow = fakeSender(); const orig = slow.send;
    const results = await Promise.all([dispatchTick(t.rt.store!, async (...a) => { await new Promise((x) => setTimeout(x, 30)); return orig(...a); }, r.dueAt + 1000), dispatchTick(t.rt.store!, orig, r.dueAt + 1000)]);
    expect(results.filter((x) => x.skipped)).toHaveLength(1);
    expect(slow.sent).toHaveLength(1);
  });
  it("client wins when it already fired the reminder (higher rev): the server does not push again", async () => {
    const t = await setup(); const r = mkReminder({}, NOW, "w1"); await t.sync([r]);
    const { fire } = await import("@/lib/reminders");
    await t.rt.store!.syncReminders(t.dev.deviceId, [fire(r, r.dueAt + 500).reminder], [], NOW); // app fired it locally and synced
    t.setNow(r.dueAt + 1000); expect(await t.tick()).toMatchObject({ fired: 0, sent: 0 });
  });
  it("paused / completed reminders never push", async () => {
    const { pauseReminder, completeReminder } = await import("@/lib/reminders");
    const t = await setup(); const a = mkReminder({}, NOW, "z1"), b = mkReminder({}, NOW, "z2");
    await t.sync([pauseReminder(a, NOW), completeReminder(b, NOW)]); t.setNow(a.dueAt + 1000);
    expect(await t.tick()).toMatchObject({ fired: 0, sent: 0 });
  });
});
