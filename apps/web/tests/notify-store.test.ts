import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStore } from "@/server/notify/memory-store";
import { createPgStore } from "@/server/notify/pg-store";
import { parseServerPrefs } from "@/lib/notify-prefs";
import { alertAt, fire, snoozeReminder } from "@/lib/reminders";
import type { NotifyStore, NewDelivery } from "@/server/notify/types";
import { makeSubscription, mkReminder, riyadh } from "./notify-helpers";

const PG = process.env.NOTIFY_TEST_DATABASE_URL;
const impls: [string, () => NotifyStore][] = [["memory", createMemoryStore]];
if (PG) impls.push(["postgres", () => createPgStore(PG)]);

const NOW = riyadh(2026, 11, 2, 2, 0);
const del = (key: string, over: Partial<NewDelivery> = {}): NewDelivery => ({ key, reminderId: "r", kind: "reminder", payload: "{}", priority: "normal", createdAt: NOW, expiresAt: NOW + 6 * 3600_000, ...over });

describe.each(impls)("NotifyStore contract — %s", (_name, make) => {
  let store: NotifyStore;
  beforeAll(() => { store = make(); });
  afterAll(async () => { await store.close(); });
  const newDevice = async (subscribed = true) => {
    const id = randomUUID();
    await store.createDevice({ id, tokenHash: "ab".repeat(32), prefs: parseServerPrefs({}), now: NOW });
    if (subscribed) await store.setSubscription(id, makeSubscription().sub, NOW);
    return id;
  };

  it("creates, reads, counts and erases devices (cascade)", async () => {
    const before = await store.countDevices();
    const id = await newDevice();
    expect(await store.countDevices()).toBe(before + 1);
    const d = (await store.getDevice(id))!;
    expect(d).toMatchObject({ id, subscription: { endpoint: expect.stringContaining("https://") }, prefs: { lockScreenContent: false } });
    await store.syncReminders(id, [mkReminder({}, NOW, "a1")], [], NOW);
    await store.addDelivery(id, del("k1"));
    await store.deleteDevice(id);
    expect(await store.getDevice(id)).toBeNull();
    expect(await store.listReminders(id)).toEqual([]);
    expect(await store.listDeliveries(id, 10)).toEqual([]);
  });

  it("last-writer-wins by rev; tombstones delete; unknown/older writes never clobber", async () => {
    const id = await newDevice();
    const r1 = mkReminder({}, NOW, "x1");
    let list = await store.syncReminders(id, [r1], [], NOW);
    expect(list.map((r) => r.id)).toEqual(["x1"]);
    const newer = { ...r1, title: "جديد", rev: r1.rev + 1 };
    list = await store.syncReminders(id, [newer], [], NOW);
    expect(list[0].title).toBe("جديد");
    list = await store.syncReminders(id, [{ ...r1, title: "قديم" }], [], NOW); // older rev
    expect(list[0].title).toBe("جديد");
    list = await store.syncReminders(id, [], ["x1"], NOW);
    expect(list).toEqual([]);
    list = await store.syncReminders(id, [newer], ["x1"], NOW); // tombstone wins within the same call
    expect(list).toEqual([]);
  });

  it("only subscribed devices have due reminders; unsubscribing erases their reminders", async () => {
    const on = await newDevice(true), off = await newDevice(false);
    const r = mkReminder({}, NOW, "d1");
    await store.syncReminders(on, [r], [], NOW); await store.syncReminders(off, [{ ...r, id: "d2" }], [], NOW);
    const due = await store.dueReminders(r.dueAt + 1000, 50);
    expect(due.some((x) => x.device.id === on && x.reminder.id === "d1")).toBe(true);
    expect(due.some((x) => x.device.id === off)).toBe(false);
    expect(await store.dueReminders(r.dueAt - 60_000, 50)).not.toContainEqual(expect.objectContaining({ reminder: expect.objectContaining({ id: "d1" }) }));
    await store.setSubscription(on, null, NOW);
    expect(await store.listReminders(on)).toEqual([]);
  });

  it("commitFire is compare-and-set on rev and inserts deliveries atomically & idempotently", async () => {
    const id = await newDevice();
    const r = mkReminder({ repeat: "daily" }, NOW, "c1");
    await store.syncReminders(id, [r], [], NOW);
    const { reminder: next, fired } = fire(r, r.dueAt + 1000);
    expect(await store.commitFire(id, next, r.rev, [del(fired[0].key)])).toBe(true);
    // second instance with the stale revision loses
    expect(await store.commitFire(id, next, r.rev, [del(fired[0].key)])).toBe(false);
    expect((await store.listReminders(id))[0].dueAt).toBe(next.dueAt);
    expect((await store.listDeliveries(id, 10)).filter((d) => d.key === fired[0].key)).toHaveLength(1);
    expect(await store.addDelivery(id, del(fired[0].key))).toBe(false); // unique key
    expect(alertAt((await store.listReminders(id))[0])).toBe(alertAt(next));
  });

  it("deferAlert moves only the due time", async () => {
    const id = await newDevice();
    const r = mkReminder({}, NOW, "q1");
    await store.syncReminders(id, [r], [], NOW);
    await store.deferAlert(id, "q1", r.dueAt + 3_600_000);
    expect((await store.dueReminders(r.dueAt + 1000, 50)).some((x) => x.device.id === id)).toBe(false);
    expect((await store.dueReminders(r.dueAt + 3_700_000, 50)).some((x) => x.device.id === id)).toBe(true);
    expect((await store.listReminders(id))[0].dueAt).toBe(r.dueAt);
  });

  it("snooze alerts are due via their own time", async () => {
    const id = await newDevice();
    const fired = fire(mkReminder({}, NOW, "s1"), riyadh(2026, 11, 3, 9, 0) + 1).reminder;
    const snoozed = snoozeReminder(fired, 10, riyadh(2026, 11, 3, 9, 1));
    await store.syncReminders(id, [snoozed], [], NOW);
    expect((await store.dueReminders(riyadh(2026, 11, 3, 9, 5), 50)).some((x) => x.device.id === id)).toBe(false);
    expect((await store.dueReminders(riyadh(2026, 11, 3, 9, 12), 50)).some((x) => x.device.id === id)).toBe(true);
  });

  it("delivery lifecycle: due → mark → retry window → purge keeps pending", async () => {
    const id = await newDevice();
    await store.addDelivery(id, del("L1"));
    expect((await store.dueDeliveries(NOW, 500)).some((x) => x.delivery.key === "L1" && x.device.id === id)).toBe(true);
    await store.markDelivery(id, "L1", { status: "pending", attempts: 1, nextAttemptAt: NOW + 60_000, lastError: "http_503" });
    expect((await store.dueDeliveries(NOW, 500)).some((x) => x.delivery.key === "L1" && x.device.id === id)).toBe(false);
    expect((await store.dueDeliveries(NOW + 61_000, 500)).some((x) => x.delivery.key === "L1" && x.device.id === id)).toBe(true);
    await store.markDelivery(id, "L1", { status: "sent", attempts: 2, sentAt: NOW + 61_000 });
    const rec = (await store.listDeliveries(id, 10)).find((d) => d.key === "L1")!;
    expect(rec).toMatchObject({ status: "sent", attempts: 2, lastError: "http_503" });
    await store.addDelivery(id, del("L2"));
    await store.purge(NOW + 30 * 24 * 3600_000);
    const keys = (await store.listDeliveries(id, 10)).map((d) => d.key);
    expect(keys).toContain("L2"); expect(keys).not.toContain("L1");
  });

  it("B4: BASHT alert links need a subscription and fall with it; named cursors persist", async () => {
    const id = await newDevice(true), bare = await newDevice(false);
    await store.setBashtAlerts(id, true); await store.setBashtAlerts(bare, true);
    const linked = (await store.bashtDevices(1000)).map((d) => d.id);
    expect(linked).toContain(id); expect(linked).not.toContain(bare);
    expect((await store.getDevice(id))!.bashtAlerts).toBe(true);
    await store.setSubscription(id, null, NOW);
    expect((await store.bashtDevices(1000)).map((d) => d.id)).not.toContain(id);
    await store.setSubscription(id, makeSubscription().sub, NOW);
    expect((await store.bashtDevices(1000)).map((d) => d.id)).not.toContain(id); // re-subscribing does not silently re-link
    const name = `c-${randomUUID()}`;
    expect(await store.getCursor(name)).toBeNull();
    await store.setCursor(name, "{\"after\":1}", NOW); await store.setCursor(name, "{\"after\":2}", NOW + 1);
    expect(await store.getCursor(name)).toBe("{\"after\":2}");
    expect((await store.addDelivery(id, del("basht:approval:x", { kind: "basht", reminderId: null }))) ).toBe(true);
    expect((await store.listDeliveries(id, 5))[0].kind).toBe("basht");
  });

  it("withLock is exclusive", async () => {
    let inner: unknown = "unset";
    const out = await store.withLock(async () => { inner = await store.withLock(async () => "nested"); return "outer"; });
    // memory: nested call refused; postgres: a different pooled connection also cannot take the advisory lock
    expect(out).toBe("outer"); expect(inner).toBeNull();
    expect(await store.withLock(async () => "again")).toBe("again");
  });
});
