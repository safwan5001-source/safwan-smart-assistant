/**
 * Regression tests for the four code-review findings on PR #34 (P1 + 3×P2). Each test fails on the pre-fix behaviour.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStore } from "@/server/notify/memory-store";
import { createPgStore } from "@/server/notify/pg-store";
import { parseServerPrefs } from "@/lib/notify-prefs";
import { fire } from "@/lib/reminders";
import { dispatchTick } from "@/server/notify/dispatch";
import { handleNotify } from "@/server/notify/api";
import { enablePush, syncReminders, urlBase64ToUint8Array } from "@/lib/push-client";
import { prefsStore, pushDeviceStore, remindersStore, tombstonesStore } from "@/lib/stores";
import type { NotifyStore, NewDelivery } from "@/server/notify/types";
import { installBrowser } from "./setup";
import { fakeSender, makeRuntime, makeSubscription, mkReminder, riyadh, registerDevice, vapid } from "./notify-helpers";

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
  beforeEach(() => {
    installBrowser(); calls = 0;
    const rt = makeRuntime({ send: fakeSender().send, now: () => NOW });
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
