import "server-only";
import { Pool } from "pg";
import { alertAt, parseReminderValue, REMINDER_LIMITS, type Reminder } from "@/lib/reminders";
import { parseServerPrefs, type ServerPrefs } from "@/lib/notify-prefs";
import { ReminderLimitError, type DeliveryRec, type DeviceRec, type NewDelivery, type NotifyStore, type PushSub } from "./types";

const RETENTION_DELIVERIES = 14 * 24 * 3600_000;
const RETENTION_DEVICES = 180 * 24 * 3600_000;
/** Constant key for the dispatcher advisory lock (arbitrary, namespaced to this feature). */
const LOCK_KEY = 7_204_001;

/**
 * Own schema (`notify`) so it never touches application tables. The migration is idempotent and runs on first use;
 * the connecting role needs CREATE on its own schema only (see docs/NOTIFICATIONS.md for the least-privilege setup).
 */
export const MIGRATION = `
CREATE SCHEMA IF NOT EXISTS notify;
CREATE TABLE IF NOT EXISTS notify.devices (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  subscription jsonb,
  prefs jsonb NOT NULL,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS notify.reminders (
  device_id uuid NOT NULL REFERENCES notify.devices(id) ON DELETE CASCADE,
  id text NOT NULL,
  rev integer NOT NULL,
  alert_at bigint,
  body jsonb NOT NULL,
  PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON notify.reminders (alert_at) WHERE alert_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS notify.deliveries (
  device_id uuid NOT NULL REFERENCES notify.devices(id) ON DELETE CASCADE,
  key text NOT NULL,
  reminder_id text,
  kind text NOT NULL,
  payload text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  sent_at bigint,
  last_error text,
  PRIMARY KEY (device_id, key)
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON notify.deliveries (next_attempt_at) WHERE status = 'pending';
ALTER TABLE notify.devices ADD COLUMN IF NOT EXISTS basht_alerts boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS notify.cursors (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);
`;

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const toDevice = (r: Row): DeviceRec => ({
  id: String(r.id), tokenHash: String(r.token_hash), subscription: (r.subscription as PushSub | null) ?? null,
  prefs: parseServerPrefs(r.prefs), createdAt: num(r.created_at), lastSeenAt: num(r.last_seen_at), bashtAlerts: r.basht_alerts === true,
});
const toDelivery = (r: Row): DeliveryRec => ({
  deviceId: String(r.device_id), key: String(r.key), reminderId: (r.reminder_id as string | null) ?? null, kind: r.kind as DeliveryRec["kind"],
  payload: String(r.payload), priority: r.priority as DeliveryRec["priority"], status: r.status as DeliveryRec["status"], attempts: num(r.attempts),
  nextAttemptAt: num(r.next_attempt_at), createdAt: num(r.created_at), expiresAt: num(r.expires_at),
  ...(r.sent_at != null ? { sentAt: num(r.sent_at) } : {}), ...(r.last_error != null ? { lastError: String(r.last_error) } : {}),
});

export function createPgStore(connectionString: string, opts: { max?: number } = {}): NotifyStore {
  const pool = new Pool({ connectionString, max: opts.max ?? 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => { /* idle client errors must not crash the process */ });
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= pool.query(MIGRATION).then(() => undefined).catch((e) => { ready = null; throw e; }));
  const q = async (text: string, params: unknown[] = []) => { await init(); return pool.query(text, params); };

  return {
    async countDevices() { return num((await q("SELECT count(*) AS n FROM notify.devices")).rows[0].n); },
    async createDevice({ id, tokenHash, prefs, now }) {
      await q("INSERT INTO notify.devices (id, token_hash, prefs, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$4)", [id, tokenHash, JSON.stringify(prefs), now]);
    },
    async getDevice(id) { const r = await q("SELECT * FROM notify.devices WHERE id = $1", [id]); return r.rows[0] ? toDevice(r.rows[0]) : null; },
    async touchDevice(id, now) { await q("UPDATE notify.devices SET last_seen_at = $2 WHERE id = $1", [id, now]); },
    async setSubscription(id: string, sub: PushSub | null, now: number) {
      await init();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("UPDATE notify.devices SET subscription = $2, last_seen_at = $3, basht_alerts = (basht_alerts AND $2::jsonb IS NOT NULL) WHERE id = $1", [id, sub ? JSON.stringify(sub) : null, now]);
        if (!sub) await c.query("DELETE FROM notify.reminders WHERE device_id = $1", [id]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    },
    async setPrefs(id: string, prefs: ServerPrefs) { await q("UPDATE notify.devices SET prefs = $2 WHERE id = $1", [id, JSON.stringify(prefs)]); },
    async deleteDevice(id) { await q("DELETE FROM notify.devices WHERE id = $1", [id]); },
    async syncReminders(deviceId, incoming, deleted, now) {
      await init();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const cancelPending = (ids: string[], why: string) => c.query(
          "UPDATE notify.deliveries SET status = 'cancelled', last_error = $3 WHERE device_id = $1 AND reminder_id = ANY($2::text[]) AND status = 'pending'", [deviceId, ids, why]);
        if (deleted.length) {
          await c.query("DELETE FROM notify.reminders WHERE device_id = $1 AND id = ANY($2::text[])", [deviceId, deleted]);
          await cancelPending(deleted, "reminder_deleted"); // a retry queued before the delete must never fire afterwards
        }
        for (const r of incoming) {
          if (deleted.includes(r.id)) continue;
          // newer revision wins; on an EQUAL revision with different content the client (the user's explicit action) wins over the
          // server's own schedule advance, otherwise a pause/complete made while the dispatcher fired would be silently lost
          const up = await c.query(
            `INSERT INTO notify.reminders (device_id, id, rev, alert_at, body) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (device_id, id) DO UPDATE SET rev = EXCLUDED.rev, alert_at = EXCLUDED.alert_at, body = EXCLUDED.body
             WHERE EXCLUDED.rev > notify.reminders.rev OR (EXCLUDED.rev = notify.reminders.rev AND EXCLUDED.body IS DISTINCT FROM notify.reminders.body)`,
            [deviceId, r.id, r.rev, alertAt(r), JSON.stringify(r)]);
          if (up.rowCount) await cancelPending([r.id], "reminder_changed"); // the user acted/rescheduled: a queued push for the old occurrence is stale
        }
        await c.query("UPDATE notify.devices SET last_seen_at = $2 WHERE id = $1", [deviceId, now]);
        const res = await c.query("SELECT body FROM notify.reminders WHERE device_id = $1 ORDER BY id", [deviceId]);
        if (res.rows.length > REMINDER_LIMITS.perDevice) throw new ReminderLimitError("reminder_limit"); // rolled back below: nothing is kept
        await c.query("COMMIT");
        return res.rows.map((x) => parseReminderValue(x.body)).filter((x): x is Reminder => !!x);
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    },
    async listReminders(deviceId) {
      const res = await q("SELECT body FROM notify.reminders WHERE device_id = $1 ORDER BY id", [deviceId]);
      return res.rows.map((x) => parseReminderValue(x.body)).filter((x): x is Reminder => !!x);
    },
    async dueReminders(now, limit) {
      const res = await q(
        `SELECT r.body, d.* FROM notify.reminders r JOIN notify.devices d ON d.id = r.device_id
         WHERE r.alert_at IS NOT NULL AND r.alert_at <= $1 AND d.subscription IS NOT NULL ORDER BY r.alert_at LIMIT $2`, [now, limit]);
      const out: { device: DeviceRec; reminder: Reminder }[] = [];
      for (const row of res.rows) { const reminder = parseReminderValue(row.body); if (reminder) out.push({ device: toDevice(row), reminder }); }
      return out;
    },
    async deferAlert(deviceId, reminderId, until) { await q("UPDATE notify.reminders SET alert_at = $3 WHERE device_id = $1 AND id = $2", [deviceId, reminderId, until]); },
    async commitFire(deviceId, next, expectedRev, list) {
      await init();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const upd = await c.query("UPDATE notify.reminders SET rev = $4, alert_at = $5, body = $6 WHERE device_id = $1 AND id = $2 AND rev = $3",
          [deviceId, next.id, expectedRev, next.rev, alertAt(next), JSON.stringify(next)]);
        if (upd.rowCount !== 1) { await c.query("ROLLBACK"); return false; }
        for (const d of list) {
          await c.query(
            `INSERT INTO notify.deliveries (device_id, key, reminder_id, kind, payload, priority, next_attempt_at, created_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) ON CONFLICT (device_id, key) DO NOTHING`,
            [deviceId, d.key, d.reminderId, d.kind, d.payload, d.priority, d.createdAt, d.expiresAt]);
        }
        await c.query("COMMIT");
        return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    },
    async addDelivery(deviceId, d: NewDelivery) {
      const r = await q(
        `INSERT INTO notify.deliveries (device_id, key, reminder_id, kind, payload, priority, next_attempt_at, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) ON CONFLICT (device_id, key) DO NOTHING`,
        [deviceId, d.key, d.reminderId, d.kind, d.payload, d.priority, d.createdAt, d.expiresAt]);
      return r.rowCount === 1;
    },
    async dueDeliveries(now, limit) {
      const res = await q(
        `SELECT dl.*, d.id AS d_id, d.token_hash, d.subscription, d.prefs, d.created_at AS d_created, d.last_seen_at
         FROM notify.deliveries dl JOIN notify.devices d ON d.id = dl.device_id
         WHERE dl.status = 'pending' AND dl.next_attempt_at <= $1 ORDER BY dl.next_attempt_at LIMIT $2`, [now, limit]);
      return res.rows.map((row) => ({
        device: toDevice({ id: row.d_id, token_hash: row.token_hash, subscription: row.subscription, prefs: row.prefs, created_at: row.d_created, last_seen_at: row.last_seen_at }),
        delivery: toDelivery(row),
      }));
    },
    async markDelivery(deviceId, key, patch) {
      await q(
        `UPDATE notify.deliveries SET status = $3, attempts = $4, next_attempt_at = COALESCE($5, next_attempt_at),
           sent_at = COALESCE($6, sent_at), last_error = COALESCE($7, last_error) WHERE device_id = $1 AND key = $2 AND (status = 'pending' OR (status = 'cancelled' AND $3 = 'sent'))`,
        [deviceId, key, patch.status, patch.attempts, patch.nextAttemptAt ?? null, patch.sentAt ?? null, patch.lastError ?? null]);
    },
    async isDeliveryPending(deviceId, key) {
      return ((await q("SELECT 1 FROM notify.deliveries WHERE device_id = $1 AND key = $2 AND status = 'pending'", [deviceId, key])).rowCount ?? 0) > 0;
    },
    async listDeliveries(deviceId, limit) {
      const res = await q("SELECT * FROM notify.deliveries WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2", [deviceId, limit]);
      return res.rows.map(toDelivery);
    },
    async purge(now) {
      const a = await q("DELETE FROM notify.deliveries WHERE status <> 'pending' AND created_at < $1", [now - RETENTION_DELIVERIES]);
      const b = await q("DELETE FROM notify.devices WHERE last_seen_at < $1", [now - RETENTION_DEVICES]);
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    },
    async setBashtAlerts(id, on) { await q("UPDATE notify.devices SET basht_alerts = ($2 AND subscription IS NOT NULL) WHERE id = $1", [id, on]); },
    async bashtDevices(limit) {
      const res = await q("SELECT * FROM notify.devices WHERE basht_alerts AND subscription IS NOT NULL ORDER BY created_at LIMIT $1", [limit]);
      return res.rows.map(toDevice);
    },
    async getCursor(name) { const r = await q("SELECT value FROM notify.cursors WHERE name = $1", [name]); return r.rows[0] ? String(r.rows[0].value) : null; },
    async setCursor(name, value, now) {
      await q("INSERT INTO notify.cursors (name, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [name, value, now]);
    },
    async withLock(fn) {
      await init();
      const c = await pool.connect();
      try {
        const got = (await c.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0].ok as boolean;
        if (!got) return null;
        try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined); }
      } finally { c.release(); }
    },
    async close() { await pool.end(); },
  };
}
