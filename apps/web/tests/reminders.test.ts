import { describe, expect, it } from "vitest";
import { zoneParts, zonedToUtc, isValidTimeZone, addMonthsClamped, daysInMonth, formatTimeInZone } from "@/lib/tz";
import {
  alertAt, completeReminder, createReminder, fire, nextOccurrenceAfter, parseReminders, pauseReminder, resumeReminder,
  snoozeReminder, updateReminder, ReminderError, type Reminder, type ReminderInput,
} from "@/lib/reminders";

const riyadh = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 3, mi);
const mk = (over: Partial<ReminderInput> = {}, now = riyadh(2026, 11, 2, 2, 0), id = "r1"): Reminder =>
  createReminder({ title: "مراجعة الفواتير", time: "09:00", date: "2026-11-03", ...over }, now, id);

describe("time zones (Asia/Riyadh, UTC+3 without DST)", () => {
  it("converts Riyadh wall-clock to the exact UTC instant and back", () => {
    expect(zonedToUtc({ y: 2026, m: 11, d: 3, h: 9, mi: 0 }, "Asia/Riyadh")).toBe(Date.UTC(2026, 10, 3, 6, 0));
    const p = zoneParts(Date.UTC(2026, 10, 3, 21, 30), "Asia/Riyadh");
    expect(p).toMatchObject({ y: 2026, m: 11, d: 4, h: 0, mi: 30 }); // crosses midnight
  });
  it("has the same offset all year (no DST drift)", () => {
    for (const [m, d] of [[1, 15], [3, 29], [7, 1], [10, 26], [12, 31]]) {
      expect(zonedToUtc({ y: 2027, m, d, h: 9, mi: 0 }, "Asia/Riyadh")).toBe(Date.UTC(2027, m - 1, d, 6, 0));
    }
  });
  it("handles DST zones generically (spring-forward gap moves forward, fall-back picks the earlier instant)", () => {
    // New York: 2026-03-08 02:30 does not exist; 2026-11-01 01:30 happens twice
    const gap = zonedToUtc({ y: 2026, m: 3, d: 8, h: 2, mi: 30 }, "America/New_York");
    expect(zoneParts(gap, "America/New_York").h).toBeGreaterThanOrEqual(3);
    const overlap = zonedToUtc({ y: 2026, m: 11, d: 1, h: 1, mi: 30 }, "America/New_York");
    expect(overlap).toBe(Date.UTC(2026, 10, 1, 5, 30)); // EDT (earlier) instant
  });
  it("validates zone names", () => {
    expect(isValidTimeZone("Asia/Riyadh")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
  it("month arithmetic clamps day-of-month", () => {
    expect(addMonthsClamped({ y: 2027, m: 1 }, 1, 31)).toEqual({ y: 2027, m: 2, d: 28 });
    expect(addMonthsClamped({ y: 2028, m: 1 }, 1, 31)).toEqual({ y: 2028, m: 2, d: 29 });
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(formatTimeInZone(Date.UTC(2026, 10, 3, 6, 0), "Asia/Riyadh")).toMatch(/9:00/);
  });
});

describe("create / edit / delete data model", () => {
  it("creates an active reminder at the right instant in Asia/Riyadh", () => {
    const r = mk();
    expect(r).toMatchObject({ status: "active", repeat: "none", tz: "Asia/Riyadh", rev: 1 });
    expect(r.dueAt).toBe(riyadh(2026, 11, 3, 9, 0));
  });
  it("rejects empty titles, past one-shot times and bad input", () => {
    const now = riyadh(2026, 11, 2, 12, 0);
    expect(() => mk({ title: "  " })).toThrow(ReminderError);
    expect(() => mk({ date: "2026-11-02", time: "09:00" }, now)).toThrow(/الماضي/);
    expect(() => mk({ time: "25:00" })).toThrow();
    expect(() => mk({ date: "2026-02-30" })).toThrow();
    expect(() => mk({ tz: "Nope/Zone" })).toThrow();
    expect(() => mk({ leadMinutes: -5 })).toThrow();
  });
  it("edit re-arms the reminder, bumps rev and clears a pending snooze", () => {
    const now = riyadh(2026, 11, 2, 2, 0);
    let r = mk();
    r = snoozeReminder(r, 10, now);
    expect(r.snoozeUntil).toBeDefined();
    const e = updateReminder(r, { title: "مراجعة الفواتير الشهرية", time: "10:30" }, now + 1000);
    expect(e.title).toBe("مراجعة الفواتير الشهرية");
    expect(e.dueAt).toBe(riyadh(2026, 11, 3, 10, 30));
    expect(e.rev).toBe(r.rev + 1);
    expect(e.snoozeUntil).toBeUndefined();
    expect(e.created).toBe(r.created);
  });
  it("sanitises stored data (drops malformed rows, clamps lengths, dedupes ids)", () => {
    const good = mk();
    const out = parseReminders([good, good, { id: "x" }, null, { ...good, id: "y", tz: "bad" }, { ...good, id: "z", title: "x".repeat(900) }]);
    expect(out.map((r) => r.id)).toEqual(["r1", "z"]);
    expect(out[1].title.length).toBe(200);
    expect(parseReminders("nope")).toEqual([]);
  });
});

describe("one-shot lifecycle", () => {
  it("fires once at the due time, then waits for an action; never fires twice", () => {
    const r = mk();
    expect(fire(r, r.dueAt - 1).fired).toHaveLength(0);
    const a = fire(r, r.dueAt + 5_000);
    expect(a.fired).toHaveLength(1);
    expect(a.fired[0]).toMatchObject({ kind: "due", minutesBefore: 0, missed: 0, key: `r1@${r.dueAt}` });
    expect(a.reminder.status).toBe("fired");
    expect(alertAt(a.reminder)).toBeNull();
    expect(fire(a.reminder, r.dueAt + 3_600_000).fired).toHaveLength(0);
  });
  it("fires early by the lead time and reports minutes remaining (\"after 30 minutes\")", () => {
    const r = mk({ leadMinutes: 30 });
    expect(alertAt(r)).toBe(r.dueAt - 30 * 60_000);
    const f = fire(r, r.dueAt - 30 * 60_000);
    expect(f.fired[0]).toMatchObject({ kind: "lead", minutesBefore: 30 });
  });
  it("snooze schedules an extra alert and does not alter the schedule; complete ends it", () => {
    const r = mk();
    const fired = fire(r, r.dueAt).reminder;
    const s = snoozeReminder(fired, 10, r.dueAt + 1000);
    expect(alertAt(s)).toBe(r.dueAt + 1000 + 600_000);
    expect(fire(s, r.dueAt + 599_000).fired).toHaveLength(0);
    const again = fire(s, r.dueAt + 601_000);
    expect(again.fired[0].kind).toBe("snooze");
    expect(again.fired[0].key).not.toBe(`r1@${r.dueAt}`); // distinct idempotency key
    expect(again.reminder.snoozeUntil).toBeUndefined();
    const done = completeReminder(again.reminder, r.dueAt + 700_000);
    expect(done).toMatchObject({ status: "completed", completedAt: r.dueAt + 700_000 });
    expect(alertAt(done)).toBeNull();
    expect(() => snoozeReminder(done, 5, 0)).toThrow();
    expect(() => snoozeReminder(fired, 0, 0)).toThrow();
  });
  it("pause stops alerts; resume re-arms (or refuses when a one-shot is already past)", () => {
    const r = mk();
    const p = pauseReminder(r, r.dueAt - 100_000);
    expect(alertAt(p)).toBeNull();
    expect(fire(p, r.dueAt + 10).fired).toHaveLength(0);
    expect(() => resumeReminder(p, r.dueAt + 60_000)).toThrow(/انتهى/);
    const weekly = pauseReminder(mk({ repeat: "weekly" }), r.dueAt - 1);
    expect(resumeReminder(weekly, r.dueAt + 60_000).status).toBe("active");
  });
});

describe("recurring reminders", () => {
  it("daily: advances to the same wall-clock time next day", () => {
    const r = mk({ repeat: "daily" });
    const f = fire(r, r.dueAt);
    expect(f.reminder.status).toBe("active");
    expect(f.reminder.dueAt).toBe(riyadh(2026, 11, 4, 9, 0));
    expect(f.reminder.rev).toBe(r.rev + 1);
  });
  it("weekly: keeps the weekday of the anchor date (Tuesday)", () => {
    const r = mk({ repeat: "weekly" }); // 2026-11-03 is a Tuesday
    expect(zoneParts(r.dueAt, r.tz).weekday).toBe(2);
    const f = fire(r, r.dueAt);
    expect(f.reminder.dueAt).toBe(riyadh(2026, 11, 10, 9, 0));
    expect(zoneParts(f.reminder.dueAt, r.tz).weekday).toBe(2);
  });
  it("monthly: anchor day 31 clamps to short months and returns to 31 afterwards", () => {
    const r = mk({ repeat: "monthly", date: "2027-01-31" }, riyadh(2027, 1, 1));
    const seq: number[] = [];
    let cur = r;
    for (let i = 0; i < 4; i++) { seq.push(zoneParts(cur.dueAt, cur.tz).d); cur = fire(cur, cur.dueAt).reminder; }
    expect(seq).toEqual([31, 28, 31, 30]); // Jan, Feb(2027), Mar, Apr
  });
  it("collapses a long outage into ONE alert for the latest occurrence and reports missed count", () => {
    const r = mk({ repeat: "daily" });
    const later = r.dueAt + 5 * 86_400_000 + 60_000; // 5 days + 1 min offline
    const f = fire(r, later);
    expect(f.fired).toHaveLength(1);
    expect(f.fired[0].missed).toBe(5);
    expect(f.fired[0].dueAt).toBe(r.dueAt + 5 * 86_400_000);
    expect(f.reminder.dueAt).toBe(r.dueAt + 6 * 86_400_000);
  });
  it("repeating + snooze keeps both streams: the snooze alert and the next regular occurrence", () => {
    const r = mk({ repeat: "daily" });
    const f1 = fire(r, r.dueAt).reminder;
    const s = snoozeReminder(f1, 15, r.dueAt + 10_000);
    expect(alertAt(s)).toBe(r.dueAt + 10_000 + 15 * 60_000);
    const f2 = fire(s, r.dueAt + 16 * 60_000);
    expect(f2.fired.map((x) => x.kind)).toEqual(["snooze"]);
    expect(f2.reminder.dueAt).toBe(r.dueAt + 86_400_000); // schedule untouched
  });
  it("completing a repeating reminder finishes only this occurrence", () => {
    const r = mk({ repeat: "daily" });
    const f = fire(r, r.dueAt).reminder;
    const c = completeReminder(f, r.dueAt + 5000);
    expect(c.status).toBe("active");
    expect(c.dueAt).toBe(f.dueAt);
  });
  it("nextOccurrenceAfter is strictly increasing", () => {
    const r = mk({ repeat: "daily" });
    let t = r.dueAt - 1;
    for (let i = 0; i < 10; i++) { const n = nextOccurrenceAfter(r, t)!; expect(n).toBeGreaterThan(t); t = n; }
  });
});
