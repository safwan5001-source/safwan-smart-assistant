import "server-only";
import { alertAt, type Reminder } from "@/lib/reminders";
import type { ServerPrefs } from "@/lib/notify-prefs";
import { REMINDER_LIMITS } from "@/lib/reminders";
import { ReminderLimitError, type DeliveryRec, type DeliveryStatus, type DeviceRec, type NewDelivery, type NotifyStore, type PushSub } from "./types";

/** key-order independent serialisation, used to detect real content differences */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const RETENTION_DELIVERIES = 14 * 24 * 3600_000;
const RETENTION_DEVICES = 180 * 24 * 3600_000;

/** Reference implementation + dev/test store. State is lost on restart (the config layer refuses it in production by default). */
export function createMemoryStore(): NotifyStore {
  const devices = new Map<string, DeviceRec>();
  const reminders = new Map<string, Map<string, { r: Reminder; alertAt: number | null }>>();
  const deliveries = new Map<string, Map<string, DeliveryRec>>();
  let locked = false;
  const clone = <T,>(v: T): T => structuredClone(v);
  const bucket = (id: string) => { let m = reminders.get(id); if (!m) reminders.set(id, (m = new Map())); return m; };
  const dbucket = (id: string) => { let m = deliveries.get(id); if (!m) deliveries.set(id, (m = new Map())); return m; };

  return {
    async countDevices() { return devices.size; },
    async createDevice({ id, tokenHash, prefs, now }) {
      devices.set(id, { id, tokenHash, subscription: null, prefs: clone(prefs), createdAt: now, lastSeenAt: now });
    },
    async getDevice(id) { const d = devices.get(id); return d ? clone(d) : null; },
    async touchDevice(id, now) { const d = devices.get(id); if (d) d.lastSeenAt = now; },
    async setSubscription(id: string, sub: PushSub | null, now: number) {
      const d = devices.get(id); if (!d) return;
      d.subscription = sub ? clone(sub) : null; d.lastSeenAt = now;
      if (!sub) { reminders.delete(id); }
    },
    async setPrefs(id: string, prefs: ServerPrefs) { const d = devices.get(id); if (d) d.prefs = clone(prefs); },
    async deleteDevice(id) { devices.delete(id); reminders.delete(id); deliveries.delete(id); },
    async syncReminders(deviceId, incoming, deleted, now) {
      const b = bucket(deviceId);
      // the stored collection (not just this request) is capped: repeated batches with fresh ids must not grow a device without bound
      const resulting = new Set(b.keys()); for (const id of deleted) resulting.delete(id); for (const r of incoming) if (!deleted.includes(r.id)) resulting.add(r.id);
      if (resulting.size > REMINDER_LIMITS.perDevice) throw new ReminderLimitError("reminder_limit");
      const cancelPending = (reminderId: string, why: string) => {
        for (const dl of deliveries.get(deviceId)?.values() ?? []) if (dl.reminderId === reminderId && dl.status === "pending") { dl.status = "cancelled"; dl.lastError = why; }
      };
      for (const id of deleted) { b.delete(id); cancelPending(id, "reminder_deleted"); }
      for (const r of incoming) {
        if (deleted.includes(r.id)) continue;
        const cur = b.get(r.id);
        // newer revision wins; on an EQUAL revision with different content the client (the user's explicit action) wins over the
        // server's own schedule advance, otherwise a pause/complete made while the dispatcher fired would be silently lost
        if (!cur || r.rev > cur.r.rev || (r.rev === cur.r.rev && stable(r) !== stable(cur.r))) {
          b.set(r.id, { r: clone(r), alertAt: alertAt(r) });
          cancelPending(r.id, "reminder_changed"); // the user acted/rescheduled: a queued push for the old occurrence is stale
        }
      }
      const d = devices.get(deviceId); if (d) d.lastSeenAt = now;
      return [...b.values()].map((x) => clone(x.r));
    },
    async listReminders(deviceId) { return [...(reminders.get(deviceId)?.values() ?? [])].map((x) => clone(x.r)); },
    async dueReminders(now, limit) {
      const out: { device: DeviceRec; reminder: Reminder }[] = [];
      for (const [did, b] of reminders) {
        const device = devices.get(did);
        if (!device?.subscription) continue;
        for (const x of b.values()) if (x.alertAt !== null && x.alertAt <= now) out.push({ device: clone(device), reminder: clone(x.r) });
      }
      return out.sort((a, b) => (alertAt(a.reminder) ?? 0) - (alertAt(b.reminder) ?? 0)).slice(0, limit);
    },
    async deferAlert(deviceId, reminderId, until) { const x = reminders.get(deviceId)?.get(reminderId); if (x) x.alertAt = until; },
    async commitFire(deviceId, next, expectedRev, list) {
      const x = reminders.get(deviceId)?.get(next.id);
      if (!x || x.r.rev !== expectedRev) return false;
      x.r = clone(next); x.alertAt = alertAt(next);
      for (const d of list) await this.addDelivery(deviceId, d);
      return true;
    },
    async addDelivery(deviceId, d: NewDelivery) {
      const b = dbucket(deviceId);
      if (b.has(d.key)) return false;
      b.set(d.key, { ...clone(d), deviceId, status: "pending", attempts: 0, nextAttemptAt: d.createdAt });
      return true;
    },
    async dueDeliveries(now, limit) {
      const out: { device: DeviceRec; delivery: DeliveryRec }[] = [];
      for (const [did, b] of deliveries) {
        const device = devices.get(did); if (!device) continue;
        for (const dl of b.values()) if (dl.status === "pending" && dl.nextAttemptAt <= now) out.push({ device: clone(device), delivery: clone(dl) });
      }
      return out.sort((a, b) => a.delivery.nextAttemptAt - b.delivery.nextAttemptAt).slice(0, limit);
    },
    async markDelivery(deviceId, key, patch) {
      const dl = deliveries.get(deviceId)?.get(key); if (!dl || !(dl.status === "pending" || (dl.status === "cancelled" && patch.status === "sent"))) return; // never resurrect a cancelled/finished delivery (a push already on the wire may still be recorded as sent)
      dl.status = patch.status as DeliveryStatus; dl.attempts = patch.attempts;
      if (patch.nextAttemptAt !== undefined) dl.nextAttemptAt = patch.nextAttemptAt;
      if (patch.sentAt !== undefined) dl.sentAt = patch.sentAt;
      if (patch.lastError !== undefined) dl.lastError = patch.lastError;
    },
    async isDeliveryPending(deviceId, key) { return deliveries.get(deviceId)?.get(key)?.status === "pending"; },
    async listDeliveries(deviceId, limit) {
      return [...(deliveries.get(deviceId)?.values() ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(clone);
    },
    async purge(now) {
      let n = 0;
      for (const [did, d] of devices) if (now - d.lastSeenAt > RETENTION_DEVICES) { devices.delete(did); reminders.delete(did); deliveries.delete(did); n++; }
      for (const b of deliveries.values()) for (const [k, dl] of b) if (dl.status !== "pending" && now - dl.createdAt > RETENTION_DELIVERIES) { b.delete(k); n++; }
      return n;
    },
    async withLock(fn) {
      if (locked) return null;
      locked = true;
      try { return await fn(); } finally { locked = false; }
    },
    async close() { /* nothing to release */ },
  };
}
