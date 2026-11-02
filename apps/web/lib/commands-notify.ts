/**
 * Commands for reminders and the notification centre. Registered in lib/commands.ts, so they share the same
 * gate as every other mutation: permission policy → handler → stores → local activity log.
 */
import {
  REMINDER_LIMITS, ReminderError, completeReminder, createReminder, pauseReminder, resumeReminder, snoozeReminder, updateReminder,
  type Reminder, type ReminderInput,
} from "./reminders";
import { Invalid, invalid, uid, type Def } from "./command-core";
import { noticesStore, remindersStore, tombstonesStore } from "./stores";

const guard = <T,>(fn: () => T): T => {
  try { return fn(); } catch (e) { if (e instanceof ReminderError) throw new Invalid(e.message); throw e; }
};
const mustReminder = (id: string): Reminder => remindersStore.getSnapshot().find((r) => r.id === id) ?? invalid("التذكير غير موجود.");
const replace = (next: Reminder) => remindersStore.set((old) => old.map((r) => (r.id === next.id ? next : r)));
const readNoticesOf = (reminderId: string) =>
  noticesStore.set((old) => old.map((n) => (n.reminderId === reminderId && !n.read ? { ...n, read: true } : n)));

export const reminderCommands = {
  "reminders.add": { id: "reminders.add", title: "إضافة تذكير", risk: "write", run: (p: ReminderInput): Reminder => {
    if (remindersStore.getSnapshot().length >= REMINDER_LIMITS.perDevice) invalid("بلغت الحد الأقصى للتذكيرات؛ احذف تذكيرات قديمة.");
    const r = guard(() => createReminder(p, Date.now(), uid()));
    remindersStore.set((old) => [r, ...old]);
    return r;
  } } satisfies Def<ReminderInput, Reminder>,
  "reminders.update": { id: "reminders.update", title: "تعديل تذكير", risk: "write", run: (p: { id: string; patch: Partial<ReminderInput> }): Reminder => {
    const next = guard(() => updateReminder(mustReminder(p.id), p.patch, Date.now()));
    replace(next);
    return next;
  } } satisfies Def<{ id: string; patch: Partial<ReminderInput> }, Reminder>,
  "reminders.snooze": { id: "reminders.snooze", title: "تأجيل تذكير", risk: "write", run: (p: { id: string; minutes: number }): Reminder => {
    const next = guard(() => snoozeReminder(mustReminder(p.id), p.minutes, Date.now()));
    replace(next); readNoticesOf(p.id);
    return next;
  } } satisfies Def<{ id: string; minutes: number }, Reminder>,
  "reminders.complete": { id: "reminders.complete", title: "إكمال تذكير", risk: "write", run: (p: { id: string }): Reminder => {
    const next = guard(() => completeReminder(mustReminder(p.id), Date.now()));
    replace(next); readNoticesOf(p.id);
    return next;
  } } satisfies Def<{ id: string }, Reminder>,
  "reminders.pause": { id: "reminders.pause", title: "إيقاف تذكير", risk: "write", run: (p: { id: string }): Reminder => {
    const next = guard(() => pauseReminder(mustReminder(p.id), Date.now()));
    replace(next);
    return next;
  } } satisfies Def<{ id: string }, Reminder>,
  "reminders.resume": { id: "reminders.resume", title: "استئناف تذكير", risk: "write", run: (p: { id: string }): Reminder => {
    const next = guard(() => resumeReminder(mustReminder(p.id), Date.now()));
    replace(next);
    return next;
  } } satisfies Def<{ id: string }, Reminder>,
  "reminders.remove": { id: "reminders.remove", title: "حذف تذكير", risk: "write", run: (p: { id: string }) => {
    mustReminder(p.id);
    remindersStore.set((old) => old.filter((r) => r.id !== p.id));
    tombstonesStore.set((old) => [p.id, ...old.filter((x) => x !== p.id)].slice(0, 500)); // so the push server forgets it too
  } } satisfies Def<{ id: string }, void>,
};

const mustNotice = (id: string) => noticesStore.getSnapshot().find((n) => n.id === id) ?? invalid("الإشعار غير موجود.");
export const notificationCommands = {
  "notifications.mark_read": { id: "notifications.mark_read", title: "تعليم إشعار", risk: "write", run: (p: { id: string; read: boolean }) => {
    mustNotice(p.id);
    noticesStore.set((old) => old.map((n) => (n.id === p.id ? { ...n, read: p.read } : n)));
  } } satisfies Def<{ id: string; read: boolean }, void>,
  "notifications.mark_all_read": { id: "notifications.mark_all_read", title: "تعليم الكل كمقروء", risk: "write", run: (_: object): number => {
    const n = noticesStore.getSnapshot().filter((x) => !x.read && !x.archived).length;
    noticesStore.set((old) => old.map((x) => (x.archived || x.read ? x : { ...x, read: true })));
    return n;
  } } satisfies Def<object, number>,
  "notifications.archive": { id: "notifications.archive", title: "أرشفة/استعادة إشعار", risk: "write", run: (p: { id: string }) => {
    mustNotice(p.id);
    noticesStore.set((old) => old.map((n) => (n.id === p.id ? { ...n, archived: !n.archived, read: n.archived ? n.read : true } : n)));
  } } satisfies Def<{ id: string }, void>,
  "notifications.remove": { id: "notifications.remove", title: "حذف إشعار", risk: "write", run: (p: { id: string }) => {
    mustNotice(p.id);
    noticesStore.set((old) => old.filter((n) => n.id !== p.id));
  } } satisfies Def<{ id: string }, void>,
  /** Opens a notification: marks it read and returns the (validated) internal path to navigate to. */
  "notifications.open": { id: "notifications.open", title: "فتح إشعار", risk: "read", run: (p: { id: string }): string | null => {
    const n = mustNotice(p.id);
    if (!n.read) noticesStore.set((old) => old.map((x) => (x.id === p.id ? { ...x, read: true } : x)));
    return n.href ?? null;
  } } satisfies Def<{ id: string }, string | null>,
  "notifications.clear_archived": { id: "notifications.clear_archived", title: "حذف الإشعارات المؤرشفة", risk: "sensitive", run: (_: object): number => {
    const n = noticesStore.getSnapshot().filter((x) => x.archived).length;
    noticesStore.set((old) => old.filter((x) => !x.archived));
    return n;
  } } satisfies Def<object, number>,
};
