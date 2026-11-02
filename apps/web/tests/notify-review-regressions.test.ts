/**
 * Regression tests for the four code-review findings on PR #34 (P1 + 3×P2). Each test fails on the pre-fix behaviour.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStore } from "@/server/notify/memory-store";
import { createPgStore } from "@/server/notify/pg-store";
import { parseServerPrefs } from "@/lib/notify-prefs";
import { createReminder, fire, parseReminderValue, updateReminder } from "@/lib/reminders";
import { parseReminderText } from "@/lib/reminder-parser";
import { runCommand, runQuickCommand } from "@/lib/commands";
import { applyPrivacy, GENERIC_BODY, GENERIC_TITLE } from "@/server/notify/push";
import { dispatchTick } from "@/server/notify/dispatch";
import { handleNotify } from "@/server/notify/api";
import { enablePush, schedulePrefsSync, syncReminders, urlBase64ToUint8Array } from "@/lib/push-client";
import { prefsStore, pushDeviceStore, remindersStore, tombstonesStore } from "@/lib/stores";
import type { NotifyStore, NewDelivery } from "@/server/notify/types";
import { installBrowser } from "./setup";
import { fakeSender, makeRuntime, makeSubscription, mkReminder, req, riyadh, registerDevice, vapid } from "./notify-helpers";

const PG = process.env.NOTIFY_TEST_DATABASE_URL;
const impls: [string, () => NotifyStore][] = [["memory", createMemoryStore]];
if (PG) impls.push(["postgres", () => createPgStore(PG)]);
const NOW = riyadh(2026, 11, 2, 2, 0);
const del = (key: string, reminderId: string, over: Partial<NewDelivery> = {}): NewDelivery =>
  ({ key, reminderId, kind: "reminder", payload: "{}", priority: "normal", createdAt: NOW, expiresAt: NOW + 6 * 3600_000, ...over });

describe.each(impls)("review fixes on the store — %s", (_n, make) => {
  let store: NotifyStore;
  beforeAll(() => { store = make(); });
  afterAll(async () => { await store.close(); });
  const device = async () => {
    const id = randomUUID();
    await store.createDevice({ id, tokenHash: "ab".repeat(32), prefs: parseServerPrefs({}), now: NOW });
    await store.setSubscription(id, makeSubscription().sub, NOW);
    return id;
  };

  it("P1: equal revision, different content → the user's change (client) wins over the server's schedule advance", async () => {
    const id = await device();
    const r = mkReminder({ repeat: "daily" }, NOW, "p1");
    await store.syncReminders(id, [r], [], NOW);
    // the dispatcher fires the recurring reminder: server rev = r.rev + 1, next occurrence scheduled
    const { reminder: advanced } = fire(r, r.dueAt + 1000);
    expect(advanced.rev).toBe(r.rev + 1);
    expect(await store.commitFire(id, advanced, r.rev, [])).toBe(true);
    // meanwhile the user paused the reminder on the device (client still at r.rev → pause = r.rev + 1: the SAME revision number)
    const paused = { ...r, status: "paused" as const, rev: r.rev + 1, updated: NOW + 5 };
    const back = await store.syncReminders(id, [paused], [], NOW + 10);
    expect(back.find((x) => x.id === "p1")!.status).toBe("paused");
    // ... and the server really stops: nothing is due any more for this reminder
    expect((await store.dueReminders(r.dueAt + 10 * 86_400_000, 500)).filter((x) => x.device.id === id)).toHaveLength(0);
  });
  it("P1: identical content at an equal revision is a no-op; an older revision never wins", async () => {
    const id = await device();
    const r = { ...mkReminder({}, NOW, "p1b"), rev: 3 };
    await store.syncReminders(id, [r], [], NOW);
    await store.deferAlert(id, r.id, r.dueAt + 999_000);                       // server-side hold on the alert time
    await store.syncReminders(id, [r], [], NOW + 1);                            // same rev + same body: must not reset the hold
    expect((await store.dueReminders(r.dueAt + 1000, 500)).some((x) => x.device.id === id)).toBe(false);
    const back = await store.syncReminders(id, [{ ...r, title: "stale", rev: 2 }], [], NOW + 2);
    expect(back.find((x) => x.id === r.id)!.title).toBe(r.title);
  });
  it("P2: deleting a reminder cancels its pending deliveries (a queued retry can never fire afterwards)", async () => {
    const id = await device();
    const r = mkReminder({}, NOW, "p2del");
    await store.syncReminders(id, [r], [], NOW);
    const { reminder: next } = fire(r, r.dueAt + 1);
    await store.commitFire(id, next, r.rev, [del("k-del", "p2del")]);
    await store.addDelivery(id, del("k-other", "someone-else"));
    expect((await store.dueDeliveries(NOW + 10 * 3600_000, 500)).filter((x) => x.device.id === id)).toHaveLength(2);
    await store.syncReminders(id, [], ["p2del"], NOW + 20);
    const due = (await store.dueDeliveries(NOW + 10 * 3600_000, 500)).filter((x) => x.device.id === id);
    expect(due.map((x) => x.delivery.key)).toEqual(["k-other"]);
    expect((await store.listDeliveries(id, 10)).find((x) => x.key === "k-del")).toMatchObject({ status: "cancelled" });
  });
  it("P2: completing/pausing on the device also cancels the pending retry of that reminder", async () => {
    const id = await device();
    const r = mkReminder({}, NOW, "p2c");
    await store.syncReminders(id, [r], [], NOW);
    const { reminder: next } = fire(r, r.dueAt + 1);
    await store.commitFire(id, next, r.rev, [del("k-c", "p2c")]);
    await store.syncReminders(id, [{ ...next, status: "completed", rev: next.rev + 1, completedAt: NOW }], [], NOW + 30);
    expect((await store.listDeliveries(id, 10)).find((x) => x.key === "k-c")).toMatchObject({ status: "cancelled" });
  });
});

describe.each(impls)("review fixes on the store (round 5) — %s", (_n, make) => {
  let store: NotifyStore;
  beforeAll(() => { store = make(); });
  afterAll(async () => { await store.close(); });
  const device = async () => {
    const id = randomUUID();
    await store.createDevice({ id, tokenHash: "ab".repeat(32), prefs: parseServerPrefs({}), now: NOW });
    await store.setSubscription(id, makeSubscription().sub, NOW);
    return id;
  };
  it("rescheduling a reminder cancels the queued push for the OLD occurrence; an identical echo does not", async () => {
    const id = await device();
    const r = mkReminder({}, NOW, "rs1");
    await store.syncReminders(id, [r], [], NOW);
    const { reminder: next } = fire(r, r.dueAt + 1);
    await store.commitFire(id, next, r.rev, [del("k-rs", "rs1")]);
    await store.syncReminders(id, [next], [], NOW + 5);                                    // client echoes the server's own state
    expect((await store.listDeliveries(id, 5))[0]).toMatchObject({ key: "k-rs", status: "pending" });
    const moved = { ...next, rev: next.rev + 1, status: "active" as const, dueAt: r.dueAt + 86_400_000 };
    await store.syncReminders(id, [moved], [], NOW + 10);                                  // user moved it to tomorrow
    expect((await store.listDeliveries(id, 5))[0]).toMatchObject({ key: "k-rs", status: "cancelled" });
  });
});

describe("P2: quiet hours are re-checked when a queued delivery is about to be sent", () => {
  const quiet = { enabled: true, from: "22:00", to: "07:00", allowCritical: false };
  it("a failed push whose retry lands inside quiet hours waits until they end", async () => {
    let now = NOW;
    const s = fakeSender((n) => (n === 1 ? { status: 503, error: "http_503" } : 201));
    const rt = makeRuntime({ send: s.send, now: () => now });
    const dev = await registerDevice(rt, makeSubscription().sub, { quiet });
    const early = mkReminder({ time: "21:59", date: "2026-11-03" }, riyadh(2026, 11, 3, 12, 0), "q1");
    await rt.store!.syncReminders(dev.deviceId, [early], [], now);
    now = early.dueAt + 1000;                               // 21:59:01 — still allowed
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ fired: 1, sent: 0, retried: 1 });
    now = early.dueAt + 121_000;                            // backoff (30 s) elapsed, but it is now 22:01 → inside quiet hours
    expect(now).toBeGreaterThan(riyadh(2026, 11, 3, 22, 0));
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ held: 1, sent: 0 });
    expect(s.sent).toHaveLength(1);                         // only the failed first attempt: nothing was pushed during quiet hours
    now = riyadh(2026, 11, 4, 7, 0) + 1000;                 // quiet hours over — the 1 h TTL has passed, so the stale push is dropped
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ sent: 0, expired: 1 });
    expect(s.sent).toHaveLength(1);
  });
  it("quiet hours switched on AFTER the push was queued still hold it; test pushes are exempt", async () => {
    const now = NOW;
    const s = fakeSender();
    const rt = makeRuntime({ send: s.send, now: () => now });
    const dev = await registerDevice(rt, makeSubscription().sub, {});
    const r = mkReminder({ time: "09:00", date: "2026-11-03" }, NOW, "q2");
    await rt.store!.syncReminders(dev.deviceId, [r], [], now);
    await rt.store!.addDelivery(dev.deviceId, { key: "k1", reminderId: "q2", kind: "reminder", payload: JSON.stringify({ key: "k1" }), priority: "normal", createdAt: now, expiresAt: now + 30 * 3600_000 });
    await rt.store!.addDelivery(dev.deviceId, { key: "k2", reminderId: null, kind: "test", payload: JSON.stringify({ key: "k2" }), priority: "normal", createdAt: now, expiresAt: now + 30 * 3600_000 });
    await rt.store!.setPrefs(dev.deviceId, parseServerPrefs({ quiet: { enabled: true, from: "00:00", to: "08:00", allowCritical: false } }));
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ held: 1, sent: 1 });
    expect(s.sent.map((x) => JSON.parse(x.payload).key)).toEqual(["k2"]);
  });
});

describe("P2: an idle device does not sync forever", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const stub = (k: string, v: unknown) => { saved[k] ??= Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
  let calls = 0;
  let rt: ReturnType<typeof makeRuntime>;
  beforeEach(() => {
    installBrowser(); calls = 0;
    rt = makeRuntime({ send: fakeSender().send, now: () => NOW });
    for (const s of [remindersStore, tombstonesStore, pushDeviceStore, prefsStore]) s.reset();
    const sub = makeSubscription().sub; let existing: unknown = null;
    const subscription = () => ({ endpoint: sub.endpoint, toJSON: () => sub, options: { applicationServerKey: urlBase64ToUint8Array(vapid.publicKey).buffer }, unsubscribe: async () => true });
    const pushManager = { getSubscription: async () => existing, subscribe: async () => (existing = subscription()) };
    stub("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/126", platform: "Linux", maxTouchPoints: 0, serviceWorker: { register: async () => ({ pushManager }), ready: Promise.resolve({}), getRegistration: async () => ({ pushManager }) } });
    stub("Notification", { permission: "granted", requestPermission: async () => "granted" });
    stub("PushManager", class {});
    const w = g.window as Record<string, unknown>;
    w.navigator = g.navigator; w.PushManager = g.PushManager; w.Notification = g.Notification; w.matchMedia = () => ({ matches: false }); w.isSecureContext = true;
    stub("fetch", async (url: string, init: RequestInit = {}) => { if (url.includes("/reminders/sync")) calls++; return handleNotify(new Request(`http://localhost${url}`, init), url.replace("/api/notify", "").split("/").filter(Boolean), rt); });
  });
  afterEach(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete g[k]; } vi.restoreAllMocks(); });

  it("a sync that changes nothing does not write the reminders store (so the runtime does not schedule another sync)", async () => {
    await enablePush();
    remindersStore.set([mkReminder({}, NOW, "idle1")]);
    await syncReminders();                         // first sync: server learns the reminder, nothing new comes back
    let writes = 0;
    const off = remindersStore.subscribe(() => { writes++; });
    expect(await syncReminders()).toBe(true);
    expect(await syncReminders()).toBe(true);
    off();
    expect(writes).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
    // an empty list is also stable
    remindersStore.set([]); await syncReminders();
    let w2 = 0; const off2 = remindersStore.subscribe(() => { w2++; });
    await syncReminders(); off2();
    expect(w2).toBe(0);
  });
  it("a preference change made while offline reaches the server with the next sync (nothing is lost)", async () => {
    await enablePush();
    const d = pushDeviceStore.getSnapshot()!;
    prefsStore.set((p) => ({ ...p, lockScreenContent: true })); await syncReminders();
    expect((await rt.store!.getDevice(d.deviceId))!.prefs.lockScreenContent).toBe(true);
    const online = g.fetch as (u: string, i?: RequestInit) => Promise<Response>;
    stub("fetch", async () => { throw new Error("offline"); });
    prefsStore.set((p) => ({ ...p, lockScreenContent: false, quiet: { ...p.quiet, enabled: true } }));
    schedulePrefsSync(0); await new Promise((r) => setTimeout(r, 20));          // the dedicated prefs request fails silently
    expect((await rt.store!.getDevice(d.deviceId))!.prefs.lockScreenContent).toBe(true);
    stub("fetch", online);
    expect(await syncReminders()).toBe(true);                                    // reconnect / startup / focus → plain reminder sync
    expect((await rt.store!.getDevice(d.deviceId))!.prefs).toMatchObject({ lockScreenContent: false, quiet: { enabled: true } });
  });
  it("a sync that DOES bring changes still adopts them", async () => {
    await enablePush();
    const r = mkReminder({}, NOW, "idle2");
    remindersStore.set([r]); await syncReminders();
    const d = pushDeviceStore.getSnapshot()!;
    remindersStore.set([{ ...r, title: "edited", rev: r.rev + 1 }]);
    await syncReminders();
    expect(remindersStore.getSnapshot()[0].title).toBe("edited");
    expect(d.subscribed).toBe(true);
  });
});

describe("P2: lock-screen privacy is applied when a queued push is finally sent", () => {
  it("a rich push queued while the option was ON is redacted after the user turns it OFF", async () => {
    let now = NOW;
    const s = fakeSender((n) => (n === 1 ? { status: 503, error: "http_503" } : 201));
    const rt = makeRuntime({ send: s.send, now: () => now });
    const dev = await registerDevice(rt, makeSubscription().sub, { lockScreenContent: true });
    const r = mkReminder({ title: "موعد الطبيب السري", time: "09:00", date: "2026-11-03" }, NOW, "pv1");
    await rt.store!.syncReminders(dev.deviceId, [r], [], now);
    now = r.dueAt + 1000;
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ fired: 1, retried: 1 });
    expect(s.sent[0].payload).toContain("الطبيب السري");                       // first attempt was rich (the user had opted in)
    await rt.store!.setPrefs(dev.deviceId, parseServerPrefs({ lockScreenContent: false }));
    now += 60_000;                                                             // retry window
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ sent: 1 });
    const retry = JSON.parse(s.sent[1].payload);
    expect(s.sent[1].payload).not.toContain("الطبيب السري");
    expect(retry).toMatchObject({ title: GENERIC_TITLE, body: GENERIC_BODY, generic: true });
  });
  it("applyPrivacy: never upgrades generic → rich, leaves test pushes and junk alone", () => {
    const off = parseServerPrefs({ lockScreenContent: false }), on = parseServerPrefs({ lockScreenContent: true });
    const rich = JSON.stringify({ kind: "reminder", generic: false, title: "سر", body: "سر", key: "k" });
    expect(JSON.parse(applyPrivacy(rich, off))).toMatchObject({ title: GENERIC_TITLE, generic: true, key: "k" });
    expect(applyPrivacy(rich, on)).toBe(rich);
    const gen = JSON.stringify({ kind: "reminder", generic: true, title: GENERIC_TITLE, body: GENERIC_BODY });
    expect(applyPrivacy(gen, on)).toBe(gen);
    const test = JSON.stringify({ kind: "test", generic: true, title: "t", body: "b" });
    expect(applyPrivacy(test, off)).toBe(test);
    expect(applyPrivacy("not json", off)).toBe("not json");
  });
});

describe("P2: a recurring reminder whose first day has passed stays editable", () => {
  it("title-only edit of a daily reminder with a past anchor is accepted and keeps the schedule", () => {
    const created = riyadh(2026, 10, 1, 12, 0);
    const r = mkReminder({ repeat: "daily", time: "20:00", date: "2026-10-01" }, created, "ed1");
    const later = riyadh(2026, 11, 2, 12, 0);                                  // a month later: the anchor is long past
    const out = updateReminder(r, { title: "عنوان جديد", date: r.anchor }, later);
    expect(out.title).toBe("عنوان جديد");
    expect(out.anchor).toBe("2026-10-01");                                     // weekday/day-of-month basis unchanged
    expect(out.dueAt).toBeGreaterThan(later);                                  // next occurrence is in the future
  });
});

describe("P2: the sync endpoint accepts the full supported collection", () => {
  const put = (rt: ReturnType<typeof makeRuntime>, auth: Record<string, string>, body: unknown) =>
    handleNotify(req("PUT", body, auth), ["reminders", "sync"], rt);
  it("500 reminders with 2000-char Arabic notes (≈2 MB) sync fine; prefs ride along; absurd bodies are still refused", async () => {
    const rt = makeRuntime({ send: fakeSender().send, now: () => NOW });
    const dev = await registerDevice(rt, makeSubscription().sub, { lockScreenContent: true });
    const notes = "ملاحظة ".repeat(285).slice(0, 2000);
    const many = Array.from({ length: 500 }, (_, i) => mkReminder({ notes, title: `تذكير ${i}` }, NOW, `big${i}`));
    const bytes = JSON.stringify({ reminders: many, deleted: [] }).length;
    expect(bytes).toBeGreaterThan(256 * 1024);                                   // would have been rejected by the old default cap
    const ok = await put(rt, dev.auth, { reminders: many, deleted: [], prefs: { lockScreenContent: false } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { reminders: unknown[] }).reminders).toHaveLength(500);
    expect((await rt.store!.getDevice(dev.deviceId))!.prefs.lockScreenContent).toBe(false);
    const huge = await put(rt, dev.auth, { reminders: [], deleted: [], pad: "x".repeat(5 * 1024 * 1024 + 10) });
    expect(huge.status).toBe(400);
    const tooMany = await put(rt, dev.auth, { reminders: [...many, mkReminder({}, NOW, "one-more")], deleted: [] });
    expect(tooMany.status).toBe(400);
  });
});

describe("P2: monthly «يوم 31» keeps the requested day in the anchor", () => {
  it("parsed on Feb 2 → first alert Feb 28, then Mar 31 (not Mar 28), then Apr 30", () => {
    const now = riyadh(2026, 2, 2, 9, 0);
    const out = parseReminderText("ذكرني كل شهر يوم 31 الساعة 10 صباحا بدفع الإيجار", now);
    expect(out.kind).toBe("ready");
    if (out.kind !== "ready") return;
    expect(out.draft.date).toBe("2026-01-31");                                   // anchor carries day 31 (past anchors are valid for series)
    let r = createReminder(out.draft, now, "m31");
    expect(r.dueAt).toBe(riyadh(2026, 2, 28, 10, 0));                            // this month, clamped
    r = fire(r, r.dueAt + 1000).reminder; expect(r.dueAt).toBe(riyadh(2026, 3, 31, 10, 0));
    r = fire(r, r.dueAt + 1000).reminder; expect(r.dueAt).toBe(riyadh(2026, 4, 30, 10, 0));
    r = fire(r, r.dueAt + 1000).reminder; expect(r.dueAt).toBe(riyadh(2026, 5, 31, 10, 0));
  });
  it("months that have the day are unchanged; a one-off «يوم 31» is still just clamped", () => {
    const now = riyadh(2026, 3, 2, 9, 0);
    const m = parseReminderText("ذكرني كل شهر يوم 31 الساعة 10 صباحا بدفع الإيجار", now);
    expect(m.kind === "ready" && m.draft.date).toBe("2026-03-31");
    const once = parseReminderText("ذكرني يوم 31 الساعة 10 صباحا بدفع الإيجار", riyadh(2026, 2, 2, 9, 0));
    expect(once.kind === "ready" && once.draft.date).toBe("2026-02-28");
  });
});

describe("P2: chat reminders use the configured time zone", () => {
  beforeEach(() => { installBrowser(); prefsStore.reset(); remindersStore.reset(); });
  it("«ذكرني بكرة الساعة 9 صباحا …» is saved in the user's zone, not hard-wired to Riyadh", async () => {
    prefsStore.set((p) => ({ ...p, tz: "America/New_York" }));
    const q = await runQuickCommand("ذكرني بكرة الساعة 9 صباحا بالاجتماع");
    expect(q.handled).toBe(true);
    expect(q.reminderCreated?.tz).toBe("America/New_York");
    expect(remindersStore.getSnapshot()[0].tz).toBe("America/New_York");
  });
});

describe("P1: one malformed reminder cannot stop the dispatcher", () => {
  it("timestamps outside the supported range are rejected by the parser", () => {
    const ok = mkReminder({}, NOW, "ts");
    expect(parseReminderValue(ok)).not.toBeNull();
    for (const bad of [-8_640_000_000_000_001, 8_640_000_000_000_001, 1e14, -1, Number.MAX_SAFE_INTEGER]) {
      expect(parseReminderValue({ ...ok, dueAt: bad })).toBeNull();
      expect(parseReminderValue({ ...ok, created: bad })).toBeNull();
    }
    expect(parseReminderValue({ ...ok, anchor: "9999-01-01" })).toBeNull();
    expect(parseReminderValue({ ...ok, rev: 9e15 })!.rev).toBeLessThanOrEqual(1_000_000_000);
  });
  it("a poisoned row that slipped past validation is parked; healthy reminders (this device and others) still fire", async () => {
    const now = NOW;
    const s = fakeSender();
    const rt = makeRuntime({ send: s.send, now: () => now });
    const evil = await registerDevice(rt, makeSubscription().sub, {});
    const good = await registerDevice(rt, makeSubscription().sub, {});
    const poison = { ...mkReminder({}, NOW, "poison"), dueAt: -8_640_000_000_000_001 };
    const fine = mkReminder({}, NOW, "fine");
    await rt.store!.syncReminders(evil.deviceId, [poison], [], now);
    await rt.store!.syncReminders(good.deviceId, [fine], [], now);
    const t = fine.dueAt + 1000;
    const rep = await dispatchTick(rt.store!, rt.send!, t);
    expect(rep.errors).toBe(1);
    expect(rep).toMatchObject({ fired: 1, sent: 1 });
    expect((await dispatchTick(rt.store!, rt.send!, t + 1000)).errors).toBe(0);            // parked, not retried every tick
  });
});

describe("P2: a sync response that arrives after a wipe is discarded", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const stub = (k: string, v: unknown) => { saved[k] ??= Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
  afterEach(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete g[k]; } vi.restoreAllMocks(); });
  it("deleted reminders do not reappear when the old in-flight answer lands after «مسح كل البيانات»", async () => {
    installBrowser();
    const rt = makeRuntime({ send: fakeSender().send, now: () => NOW });
    for (const st of [remindersStore, tombstonesStore, pushDeviceStore, prefsStore]) st.reset();
    const sub = makeSubscription().sub; let existing: unknown = null;
    const subscription = () => ({ endpoint: sub.endpoint, toJSON: () => sub, options: { applicationServerKey: urlBase64ToUint8Array(vapid.publicKey).buffer }, unsubscribe: async () => true });
    const pushManager = { getSubscription: async () => existing, subscribe: async () => (existing = subscription()) };
    stub("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/126", platform: "Linux", maxTouchPoints: 0, serviceWorker: { register: async () => ({ pushManager }), ready: Promise.resolve({}), getRegistration: async () => ({ pushManager }) } });
    stub("Notification", { permission: "granted", requestPermission: async () => "granted" });
    stub("PushManager", class {});
    const w = g.window as Record<string, unknown>;
    w.navigator = g.navigator; w.PushManager = g.PushManager; w.Notification = g.Notification; w.matchMedia = () => ({ matches: false }); w.isSecureContext = true;
    const online = async (url: string, init: RequestInit = {}) => handleNotify(new Request(`http://localhost${url}`, init), url.replace("/api/notify", "").split("/").filter(Boolean), rt);
    stub("fetch", online);
    await enablePush();
    remindersStore.set([mkReminder({}, NOW, "inflight1")]); await syncReminders();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    stub("fetch", async (url: string, init: RequestInit = {}) => { const res = await online(url, init); if (url.includes("/reminders/sync")) await gate; return res; });
    const pending = syncReminders();                                              // the server already answered with the reminder, the answer is held back
    await new Promise((r) => setTimeout(r, 10));
    stub("fetch", online);
    const wipe = await runCommand("data.erase_all", {}, { approved: true });
    expect(wipe).toMatchObject({ status: "executed", data: { serverErased: true } });
    release(); await pending;
    expect(remindersStore.getSnapshot()).toEqual([]);
    expect(pushDeviceStore.getSnapshot()).toBeNull();
  });
});
