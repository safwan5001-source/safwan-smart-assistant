import "server-only";
import type { Reminder, ReminderPriority } from "@/lib/reminders";
import type { ServerPrefs } from "@/lib/notify-prefs";

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type DeviceRec = {
  id: string;
  /** sha-256 of the bearer secret; the secret itself is never stored */
  tokenHash: string;
  subscription: PushSub | null;
  prefs: ServerPrefs;
  createdAt: number;
  lastSeenAt: number;
};
/** Thrown by syncReminders when the resulting collection would exceed REMINDER_LIMITS.perDevice (nothing is written). */
export class ReminderLimitError extends Error {}
export type DeliveryStatus = "pending" | "sent" | "failed" | "gone" | "expired" | "cancelled";
export type NewDelivery = {
  key: string; reminderId: string | null; kind: "reminder" | "test"; payload: string; priority: ReminderPriority; createdAt: number; expiresAt: number;
};
export type DeliveryRec = NewDelivery & { deviceId: string; status: DeliveryStatus; attempts: number; nextAttemptAt: number; sentAt?: number; lastError?: string };

/** Persistence contract shared by the in-memory (dev/tests) and PostgreSQL implementations (see tests/notify-store.contract). */
export interface NotifyStore {
  countDevices(): Promise<number>;
  createDevice(d: { id: string; tokenHash: string; prefs: ServerPrefs; now: number }): Promise<void>;
  getDevice(id: string): Promise<DeviceRec | null>;
  touchDevice(id: string, now: number): Promise<void>;
  /** null unsubscribes AND deletes the device's reminders (data minimisation). */
  setSubscription(id: string, sub: PushSub | null, now: number): Promise<void>;
  setPrefs(id: string, prefs: ServerPrefs): Promise<void>;
  /** erases the device and everything attached to it */
  deleteDevice(id: string): Promise<void>;
  /** last-writer-wins by `rev`; returns the merged list the device should adopt */
  syncReminders(deviceId: string, incoming: Reminder[], deleted: string[], now: number): Promise<Reminder[]>;
  listReminders(deviceId: string): Promise<Reminder[]>;
  dueReminders(now: number, limit: number): Promise<{ device: DeviceRec; reminder: Reminder }[]>;
  /** moves the next alert of a reminder (quiet hours) without touching its content */
  deferAlert(deviceId: string, reminderId: string, until: number): Promise<void>;
  /** compare-and-set on rev: stores `next` and the deliveries atomically; false if someone else advanced it first */
  commitFire(deviceId: string, next: Reminder, expectedRev: number, deliveries: NewDelivery[]): Promise<boolean>;
  /** idempotent insert (unique per device+key); returns whether it was new */
  addDelivery(deviceId: string, d: NewDelivery): Promise<boolean>;
  dueDeliveries(now: number, limit: number): Promise<{ device: DeviceRec; delivery: DeliveryRec }[]>;
  markDelivery(deviceId: string, key: string, patch: { status: DeliveryStatus; attempts: number; nextAttemptAt?: number; sentAt?: number; lastError?: string }): Promise<void>;
  /** True while the delivery is still `pending` — re-checked right before each send so a cancellation accepted meanwhile is honoured. */
  isDeliveryPending(deviceId: string, key: string): Promise<boolean>;
  listDeliveries(deviceId: string, limit: number): Promise<DeliveryRec[]>;
  /** retention: drops finished deliveries older than 14 days and devices idle for 180 days */
  purge(now: number): Promise<number>;
  /** runs `fn` while holding a cluster-wide dispatcher lock; null when another instance holds it */
  withLock<T>(fn: () => Promise<T>): Promise<T | null>;
  close(): Promise<void>;
}
