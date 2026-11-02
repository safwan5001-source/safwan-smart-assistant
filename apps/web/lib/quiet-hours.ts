/** Quiet hours ("أوقات الهدوء"): per device, evaluated in the device's own time zone. Shared by browser and server. */
import { DEFAULT_TZ, parseTimeOfDay, zoneParts, zonedToUtc, addDays } from "./tz";

export type QuietHours = { enabled: boolean; from: string; to: string; allowCritical: boolean };
export const DEFAULT_QUIET: QuietHours = { enabled: false, from: "22:00", to: "07:00", allowCritical: false };

export function parseQuiet(v: unknown): QuietHours {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ok = (s: unknown, d: string) => (typeof s === "string" && parseTimeOfDay(s) ? s : d);
  return { enabled: o.enabled === true, from: ok(o.from, DEFAULT_QUIET.from), to: ok(o.to, DEFAULT_QUIET.to), allowCritical: o.allowCritical === true };
}

const minutes = (s: string) => { const t = parseTimeOfDay(s)!; return t.h * 60 + t.mi; };

/** Is `ts` inside the quiet window? The window may wrap midnight (22:00 → 07:00). from === to means "always off". */
export function inQuietHours(ts: number, q: QuietHours, tz: string = DEFAULT_TZ): boolean {
  if (!q.enabled || q.from === q.to) return false;
  const p = zoneParts(ts, tz), cur = p.h * 60 + p.mi, a = minutes(q.from), b = minutes(q.to);
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** First instant at/after `ts` that is outside quiet hours (the next `to` boundary). */
export function quietEnd(ts: number, q: QuietHours, tz: string = DEFAULT_TZ): number {
  if (!inQuietHours(ts, q, tz)) return ts;
  const p = zoneParts(ts, tz), to = parseTimeOfDay(q.to)!;
  const today = { y: p.y, m: p.m, d: p.d };
  let end = zonedToUtc({ ...today, h: to.h, mi: to.mi }, tz);
  if (end <= ts) end = zonedToUtc({ ...addDays(today, 1), h: to.h, mi: to.mi }, tz);
  return end;
}

/** Should an alert of this priority be held back right now? Critical passes only when the user allowed it. */
export const shouldHold = (ts: number, q: QuietHours, tz: string, priority: string): boolean =>
  inQuietHours(ts, q, tz) && !(priority === "critical" && q.allowCritical);
