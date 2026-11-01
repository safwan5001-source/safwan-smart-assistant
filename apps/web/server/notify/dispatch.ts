/**
 * Server dispatcher: the half that works when the app is CLOSED.
 *   1. reminders whose alert time arrived → advance state with the shared `fire()` maths → persist state + delivery rows atomically
 *      (compare-and-set on `rev`, unique delivery key ⇒ no double alert even with several instances / retries / client races)
 *   2. pending deliveries → Web Push, with retry/backoff; dead subscriptions (404/410) are removed together with the device's reminders
 * Quiet hours are enforced here, per device, in the device's time zone.
 */
import { fire } from "@/lib/reminders";
import { shouldHold, quietEnd } from "@/lib/quiet-hours";
import { deliveryOf, reminderPayload, topicOf, ttlOf, urgencyOf, type PushSender } from "./push";
import type { NotifyStore } from "./types";

export const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const BATCH = 200;
const PURGE_EVERY_MS = 3600_000;
let lastPurge = 0;

export type TickReport = { fired: number; held: number; sent: number; retried: number; failed: number; gone: number; expired: number; skipped: boolean };

export async function dispatchTick(store: NotifyStore, send: PushSender, now: number): Promise<TickReport> {
  const rep: TickReport = { fired: 0, held: 0, sent: 0, retried: 0, failed: 0, gone: 0, expired: 0, skipped: false };
  const res = await store.withLock(async () => {
    // 1) reminders → deliveries
    for (const { device, reminder } of await store.dueReminders(now, BATCH)) {
      if (shouldHold(now, device.prefs.quiet, device.prefs.tz, reminder.priority)) {
        await store.deferAlert(device.id, reminder.id, quietEnd(now, device.prefs.quiet, device.prefs.tz));
        rep.held++; continue;
      }
      const { reminder: next, fired } = fire(reminder, now);
      if (!fired.length) { await store.deferAlert(device.id, reminder.id, now + 3_600_000); continue; }
      const ok = await store.commitFire(device.id, next, reminder.rev, fired.map((f) => deliveryOf(reminderPayload(f, device.prefs), now)));
      if (ok) rep.fired += fired.length;
    }
    // 2) deliveries → push
    for (const { device, delivery } of await store.dueDeliveries(now, BATCH)) {
      if (!device.subscription) { await store.markDelivery(device.id, delivery.key, { status: "gone", attempts: delivery.attempts }); rep.gone++; continue; }
      if (now > delivery.expiresAt) { await store.markDelivery(device.id, delivery.key, { status: "expired", attempts: delivery.attempts }); rep.expired++; continue; }
      const r = await send(device.subscription, delivery.payload, { ttl: ttlOf(delivery.kind), urgency: urgencyOf(delivery.priority), topic: topicOf(delivery.key) });
      const attempts = delivery.attempts + 1;
      if (r.status >= 200 && r.status < 300) { await store.markDelivery(device.id, delivery.key, { status: "sent", attempts, sentAt: now }); rep.sent++; }
      else if (r.status === 404 || r.status === 410) {
        // the user removed the app / revoked permission: forget the subscription and the data tied to it
        await store.markDelivery(device.id, delivery.key, { status: "gone", attempts, lastError: `http_${r.status}` });
        await store.setSubscription(device.id, null, now); rep.gone++;
      } else if (r.status === 400 || r.status === 413) { await store.markDelivery(device.id, delivery.key, { status: "failed", attempts, lastError: r.error ?? `http_${r.status}` }); rep.failed++; }
      else if (attempts >= MAX_ATTEMPTS) { await store.markDelivery(device.id, delivery.key, { status: "failed", attempts, lastError: r.error ?? `http_${r.status}` }); rep.failed++; }
      else { await store.markDelivery(device.id, delivery.key, { status: "pending", attempts, nextAttemptAt: now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)], lastError: r.error ?? `http_${r.status}` }); rep.retried++; }
    }
    if (now - lastPurge > PURGE_EVERY_MS) { lastPurge = now; await store.purge(now); }
    return rep;
  });
  if (res === null) rep.skipped = true;
  return res ?? rep;
}
