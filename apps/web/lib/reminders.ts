/**
 * Reminder domain + scheduling engine. PURE (no I/O, no clock reads): every function takes `now`.
 * The same module runs in the browser (foreground engine) and on the server (push dispatcher),
 * so both advance a reminder to exactly the same next state.
 *
 * Model
 *  - `dueAt`  : the instant of the event the reminder is about (next occurrence for repeating ones).
 *  - `leadMinutes`: alert this long BEFORE `dueAt` ("اجتماع بعد ثلاثين دقيقة"); 0 = alert at the time.
 *  - one-shot reminders become `fired` after alerting and wait for complete / snooze;
 *    repeating ones advance `dueAt` to the next occurrence and stay `active`.
 *  - snooze is an extra one-off alert (`snoozeUntil`) that never changes the schedule.
 *  - Time of day / date are wall-clock in `tz` (default Asia/Riyadh); instants are UTC ms.
 */
import {
  DEFAULT_TZ, addDays, addMonthsClamped, dateKey, isValidTimeZone, pad2, parseDateKey, parseTimeOfDay,
  zoneParts, zonedToUtc, formatInZone, TZ_LABEL,
} from "./tz";

export type RepeatKind = "none" | "daily" | "weekly" | "monthly";
export type ReminderPriority = "low" | "normal" | "high" | "critical";
export type ReminderStatus = "active" | "fired" | "paused" | "completed";
export const REPEATS: RepeatKind[] = ["none", "daily", "weekly", "monthly"];
export const PRIORITIES: ReminderPriority[] = ["low", "normal", "high", "critical"];

export type Reminder = {
  id: string;
  title: string;
  notes?: string;
  tz: string;
  repeat: RepeatKind;
  /** wall-clock "HH:mm" in tz */
  time: string;
  /** first occurrence date "YYYY-MM-DD" in tz (weekly → weekday, monthly → day-of-month are derived from it) */
  anchor: string;
  leadMinutes: number;
  priority: ReminderPriority;
  status: ReminderStatus;
  dueAt: number;
  snoozeUntil?: number;
  /** the occurrence the pending snooze belongs to */
  snoozeFor?: number;
  lastFiredAt?: number;
  lastFiredDueAt?: number;
  completedAt?: number;
  /** monotonically increasing revision used for last-writer-wins sync */
  rev: number;
  created: number;
  updated: number;
};

/** Date-picker lower bound: a one-off must be today or later; a series may keep a PAST anchor (it carries the weekday / day-of-month,
 *  e.g. «كل شهر يوم 31» seeded in February as January 31) — the scheduler already yields the next future occurrence. */
export const minDateFor = (repeat: RepeatKind, today: string): string | undefined => (repeat === "none" ? today : undefined);
export const REMINDER_LIMITS = { title: 200, notes: 2000, maxLeadMinutes: 7 * 24 * 60, maxSnoozeMinutes: 7 * 24 * 60, perDevice: 500 } as const;
export const LEAD_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440];
export const SNOOZE_OPTIONS = [5, 10, 30, 60];

export type ReminderInput = {
  title: string; notes?: string; tz?: string; repeat?: RepeatKind; time: string; date: string;
  leadMinutes?: number; priority?: ReminderPriority;
};
export class ReminderError extends Error {}
const bad = (m: string): never => { throw new ReminderError(m); };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Every instant must be a sane date (1970–2100): values outside JS's Date range (or far outside any real schedule) used to make
 *  formatting/scheduling throw inside the dispatcher. rev is bounded so it always fits a PostgreSQL integer. */
export const MAX_TS = 4_102_444_800_000;
const isTs = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_TS;
const isStr = (v: unknown): v is string => typeof v === "string";

/** Sanitising parser for stored / synced data. Returns null for anything that is not a valid reminder. */
export function parseReminderValue(v: unknown): Reminder | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || v.id.length > 80 || !isStr(v.title) || !v.title.trim()) return null;
  if (!isStr(v.tz) || !isValidTimeZone(v.tz)) return null;
  if (!REPEATS.includes(v.repeat as RepeatKind)) return null;
  if (!isStr(v.time) || !parseTimeOfDay(v.time)) return null;
  if (!isStr(v.anchor) || !parseDateKey(v.anchor)) return null;
  if (!PRIORITIES.includes(v.priority as ReminderPriority)) return null;
  if (!["active", "fired", "paused", "completed"].includes(v.status as string)) return null;
  if (!isTs(v.dueAt) || !isTs(v.created) || !isTs(v.updated)) return null;
  if (Number(v.anchor.slice(0, 4)) > 2100) return null;
  const lead = isNum(v.leadMinutes) ? Math.round(v.leadMinutes) : 0;
  if (lead < 0 || lead > REMINDER_LIMITS.maxLeadMinutes) return null;
  const r: Reminder = {
    id: v.id, title: v.title.trim().slice(0, REMINDER_LIMITS.title), tz: v.tz, repeat: v.repeat as RepeatKind,
    time: v.time, anchor: v.anchor, leadMinutes: lead, priority: v.priority as ReminderPriority,
    status: v.status as ReminderStatus, dueAt: v.dueAt, rev: isNum(v.rev) && v.rev >= 0 ? Math.min(Math.floor(v.rev), 1_000_000_000) : 0,
    created: v.created, updated: v.updated,
  };
  if (isStr(v.notes) && v.notes.trim()) r.notes = v.notes.slice(0, REMINDER_LIMITS.notes);
  if (isTs(v.snoozeUntil) && isTs(v.snoozeFor)) { r.snoozeUntil = v.snoozeUntil; r.snoozeFor = v.snoozeFor; }
  if (isTs(v.lastFiredAt)) r.lastFiredAt = v.lastFiredAt;
  if (isTs(v.lastFiredDueAt)) r.lastFiredDueAt = v.lastFiredDueAt;
  if (isTs(v.completedAt)) r.completedAt = v.completedAt;
  return r;
}
export function parseReminders(value: unknown): Reminder[] {
  if (!Array.isArray(value)) return [];
  const out: Reminder[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const r = parseReminderValue(v);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    if (out.length >= REMINDER_LIMITS.perDevice) break;
  }
  return out;
}

// ── schedule maths ─────────────────────────────────────────────────────────

const at = (date: { y: number; m: number; d: number }, time: { h: number; mi: number }, tz: string) =>
  zonedToUtc({ ...date, h: time.h, mi: time.mi }, tz);

type Sched = Pick<Reminder, "tz" | "repeat" | "time" | "anchor">;

/** First occurrence instant STRICTLY after `ts` (null when a one-shot is already in the past). */
export function nextOccurrenceAfter(r: Sched, ts: number): number | null {
  const anchor = parseDateKey(r.anchor)!, time = parseTimeOfDay(r.time)!;
  const first = at(anchor, time, r.tz);
  if (r.repeat === "none") return first > ts ? first : null;
  if (first > ts) return first;
  const today = zoneParts(ts, r.tz);
  if (r.repeat === "daily") {
    let day = { y: today.y, m: today.m, d: today.d };
    let c = at(day, time, r.tz);
    if (c <= ts) { day = addDays(day, 1); c = at(day, time, r.tz); }
    return c;
  }
  if (r.repeat === "weekly") {
    const wd = new Date(Date.UTC(anchor.y, anchor.m - 1, anchor.d)).getUTCDay();
    let day = { y: today.y, m: today.m, d: today.d };
    const cur = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    day = addDays(day, (wd - cur + 7) % 7);
    let c = at(day, time, r.tz);
    if (c <= ts) { day = addDays(day, 7); c = at(day, time, r.tz); }
    return c;
  }
  // monthly: keep the anchor day-of-month, clamped to month length (31 → 30/28/29…)
  let k = 0;
  for (;;) {
    const day = addMonthsClamped({ y: today.y, m: today.m }, k, anchor.d);
    const c = at(day, time, r.tz);
    if (c > ts) return c;
    k++;
    if (k > 24) return null;
  }
}

/** The instant the reminder wants to alert next (null = nothing pending). */
export function alertAt(r: Reminder): number | null {
  if (r.status === "paused" || r.status === "completed") return null;
  const c: number[] = [];
  if (r.status === "active") c.push(r.dueAt - r.leadMinutes * 60_000);
  if (r.snoozeUntil !== undefined) c.push(r.snoozeUntil);
  return c.length ? Math.min(...c) : null;
}

export type Fired = {
  /** idempotency key: one per (reminder, occurrence[, snooze]) — the same on every device and on the server */
  key: string;
  reminderId: string;
  title: string;
  priority: ReminderPriority;
  dueAt: number;
  /** minutes between the alert and the event (0 = at the time / late) */
  minutesBefore: number;
  kind: "lead" | "due" | "snooze";
  /** repeating occurrences that were skipped because the alert was missed (device off / app closed) */
  missed: number;
  tz: string;
};

export const occurrenceKey = (id: string, dueAt: number) => `${id}@${dueAt}`;
const snoozeKey = (id: string, forDue: number, until: number) => `${id}@${forDue}~${until}`;

/**
 * Advances a reminder whose alert time has arrived. Returns the new reminder state and what to deliver.
 * Missed repeating occurrences collapse into ONE alert for the latest occurrence (no storm after downtime).
 */
export function fire(r: Reminder, now: number): { reminder: Reminder; fired: Fired[] } {
  const due = alertAt(r);
  if (due === null || due > now) return { reminder: r, fired: [] };
  const fired: Fired[] = [];
  const next: Reminder = { ...r };
  if (r.snoozeUntil !== undefined && r.snoozeUntil <= now) {
    const forDue = r.snoozeFor ?? r.dueAt;
    fired.push({
      key: snoozeKey(r.id, forDue, r.snoozeUntil), reminderId: r.id, title: r.title, priority: r.priority, dueAt: forDue,
      minutesBefore: Math.max(0, Math.round((forDue - now) / 60_000)), kind: "snooze", missed: 0, tz: r.tz,
    });
    delete next.snoozeUntil; delete next.snoozeFor;
  }
  if (r.status === "active" && r.dueAt - r.leadMinutes * 60_000 <= now) {
    let dueAt = r.dueAt, missed = 0;
    if (r.repeat !== "none") {
      for (let i = 0; i < 1000; i++) {
        const n = nextOccurrenceAfter(r, dueAt);
        if (n === null || n - r.leadMinutes * 60_000 > now) break;
        dueAt = n; missed++;
      }
    }
    const minutesBefore = Math.max(0, Math.round((dueAt - now) / 60_000));
    fired.push({
      key: occurrenceKey(r.id, dueAt), reminderId: r.id, title: r.title, priority: r.priority, dueAt, minutesBefore,
      kind: minutesBefore > 0 ? "lead" : "due", missed, tz: r.tz,
    });
    next.lastFiredAt = now; next.lastFiredDueAt = dueAt;
    if (r.repeat === "none") next.status = "fired";
    else next.dueAt = nextOccurrenceAfter(r, dueAt) ?? dueAt;
  }
  if (!fired.length) return { reminder: r, fired };
  next.rev = r.rev + 1; next.updated = now;
  return { reminder: next, fired };
}

// ── user actions (all return a NEW reminder) ───────────────────────────────

export function createReminder(input: ReminderInput, now: number, id: string): Reminder {
  const title = (input.title ?? "").trim().slice(0, REMINDER_LIMITS.title);
  if (!title) bad("عنوان التذكير مطلوب.");
  const tz = input.tz ?? DEFAULT_TZ;
  if (!isValidTimeZone(tz)) bad("منطقة زمنية غير صالحة.");
  const repeat = input.repeat ?? "none";
  if (!REPEATS.includes(repeat)) bad("نوع التكرار غير صالح.");
  if (!parseTimeOfDay(input.time)) bad("وقت غير صالح.");
  if (!parseDateKey(input.date)) bad("تاريخ غير صالح.");
  const lead = Math.round(input.leadMinutes ?? 0);
  if (!(lead >= 0 && lead <= REMINDER_LIMITS.maxLeadMinutes)) bad("مدة التنبيه المسبق غير صالحة.");
  const priority = input.priority ?? "normal";
  if (!PRIORITIES.includes(priority)) bad("أولوية غير صالحة.");
  const sched: Sched = { tz, repeat, time: input.time, anchor: input.date };
  const dueAt = nextOccurrenceAfter(sched, now - 1);
  if (dueAt === null) bad("موعد التذكير في الماضي. اختر وقتاً قادماً.");
  const r: Reminder = {
    id, title, tz, repeat, time: input.time, anchor: input.date, leadMinutes: lead, priority, status: "active",
    dueAt: dueAt as number, rev: 1, created: now, updated: now,
  };
  const notes = input.notes?.trim();
  if (notes) r.notes = notes.slice(0, REMINDER_LIMITS.notes);
  return r;
}

export function updateReminder(r: Reminder, patch: Partial<ReminderInput> & { notes?: string }, now: number): Reminder {
  const merged = createReminder({
    title: patch.title ?? r.title, notes: patch.notes !== undefined ? patch.notes : r.notes, tz: patch.tz ?? r.tz,
    repeat: patch.repeat ?? r.repeat, time: patch.time ?? r.time, date: patch.date ?? r.anchor,
    leadMinutes: patch.leadMinutes ?? r.leadMinutes, priority: patch.priority ?? r.priority,
  }, now, r.id);
  // editing re-arms the reminder: pending snooze / fired state are cleared; history is kept
  const out: Reminder = { ...merged, created: r.created, rev: r.rev + 1, updated: now };
  if (r.lastFiredAt !== undefined) out.lastFiredAt = r.lastFiredAt;
  if (r.lastFiredDueAt !== undefined) out.lastFiredDueAt = r.lastFiredDueAt;
  if (r.status === "paused") out.status = "paused";
  return out;
}

export function snoozeReminder(r: Reminder, minutes: number, now: number): Reminder {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > REMINDER_LIMITS.maxSnoozeMinutes) bad("مدة التأجيل غير صالحة.");
  if (r.status === "completed" || r.status === "paused") bad("لا يمكن تأجيل تذكير مكتمل أو موقوف.");
  const forDue = r.lastFiredDueAt ?? r.dueAt;
  return { ...r, snoozeUntil: now + Math.round(minutes) * 60_000, snoozeFor: forDue, rev: r.rev + 1, updated: now };
}

/** One-shot → completed. Repeating → this occurrence is done (snooze cleared); the series continues. */
export function completeReminder(r: Reminder, now: number): Reminder {
  const out: Reminder = { ...r, rev: r.rev + 1, updated: now };
  delete out.snoozeUntil; delete out.snoozeFor;
  if (r.repeat === "none") { out.status = "completed"; out.completedAt = now; }
  return out;
}

export function pauseReminder(r: Reminder, now: number): Reminder {
  if (r.status === "completed") bad("التذكير مكتمل.");
  const out: Reminder = { ...r, status: "paused", rev: r.rev + 1, updated: now };
  delete out.snoozeUntil; delete out.snoozeFor;
  return out;
}

export function resumeReminder(r: Reminder, now: number): Reminder {
  if (r.status !== "paused") return r;
  const dueAt = nextOccurrenceAfter(r, now - 1);
  if (dueAt === null) bad("انتهى موعد هذا التذكير. عدّل الموعد لإعادة تفعيله.");
  return { ...r, status: "active", dueAt: dueAt as number, rev: r.rev + 1, updated: now };
}

// ── presentation ───────────────────────────────────────────────────────────
export const REPEAT_LABEL: Record<RepeatKind, string> = { none: "مرة واحدة", daily: "يومياً", weekly: "أسبوعياً", monthly: "شهرياً" };
export const PRIORITY_LABEL: Record<ReminderPriority, string> = { low: "منخفضة", normal: "عادية", high: "عالية", critical: "حرجة" };
export const STATUS_LABEL: Record<ReminderStatus, string> = { active: "نشط", fired: "بانتظار الإجراء", paused: "موقوف", completed: "مكتمل" };

export function leadLabel(min: number): string {
  if (min <= 0) return "في الموعد";
  if (min % 1440 === 0) return min === 1440 ? "قبل يوم" : `قبل ${min / 1440} أيام`;
  if (min % 60 === 0) return min === 60 ? "قبل ساعة" : min === 120 ? "قبل ساعتين" : `قبل ${min / 60} ساعات`;
  return `قبل ${min} دقيقة`;
}

export function describeSchedule(r: Reminder): string {
  const when = formatInZone(r.dueAt, r.tz);
  return `${when} (${TZ_LABEL(r.tz)})`;
}
export const timeLabel = (h: number, mi: number) => `${pad2(h)}:${pad2(mi)}`;
export const dateKeyOf = dateKey;
