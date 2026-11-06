/**
 * Pure derivations for the Command Center (no clock reads, no I/O): every function takes `now`.
 */
import type { Reminder } from "./reminders";

/** [start, end) of the device-local calendar day containing `now`. Local midnights, so DST days are 23 h / 25 h. */
export function dayBounds(now: number): { start: number; end: number } {
  const d = new Date(now);
  return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
}

/**
 * «تذكيرات اليوم»: reminders whose event time (`dueAt`) falls inside today — from local start of day up to (not including) the next midnight.
 * Paused and completed reminders are not counted; an overdue one from yesterday or one scheduled for tomorrow is outside the window.
 * A repeating reminder counts by its current occurrence (`dueAt` is the next occurrence once one has passed).
 */
export function remindersDueToday(list: readonly Reminder[], now: number): Reminder[] {
  const { start, end } = dayBounds(now);
  return list.filter((r) => (r.status === "active" || r.status === "fired") && r.dueAt >= start && r.dueAt < end);
}
