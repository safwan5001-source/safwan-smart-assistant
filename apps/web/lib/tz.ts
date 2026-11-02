/**
 * Time-zone arithmetic on top of Intl only (no dependency). All reminder maths is done in the
 * USER's IANA zone (default Asia/Riyadh, UTC+3, no DST) and stored as UTC milliseconds.
 * Pure and isomorphic: the browser and the server scheduler use exactly the same code.
 */
export const DEFAULT_TZ = "Asia/Riyadh";
export type ZoneParts = { y: number; m: number; d: number; h: number; mi: number; s: number; weekday: number };
export type LocalDateTime = { y: number; m: number; d: number; h: number; mi: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { fmt(tz); return true; } catch { return false; }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in `tz`. weekday: 0 = Sunday … 6 = Saturday. */
export function zoneParts(ts: number, tz: string = DEFAULT_TZ): ZoneParts {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, weekday: WEEKDAYS[o.weekday] ?? 0 };
}

const asUtc = (p: LocalDateTime) => Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);

/** Offset (ms) of `tz` from UTC at instant `ts`. */
export function zoneOffsetMs(ts: number, tz: string = DEFAULT_TZ): number {
  const p = zoneParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `tz` to a UTC instant.
 * DST gap (non-existent local time) → moved forward by the gap; DST overlap → the earlier instant.
 */
export function zonedToUtc(local: LocalDateTime, tz: string = DEFAULT_TZ): number {
  const guess = asUtc(local);
  let ts = guess - zoneOffsetMs(guess, tz);
  const off2 = zoneOffsetMs(ts, tz);
  if (guess - off2 !== ts) ts = guess - off2;
  // verify round trip; if the local time does not exist, step forward by the gap
  const back = zoneParts(ts, tz);
  if (back.h !== local.h || back.mi !== local.mi || back.d !== local.d) {
    const fwd = guess - zoneOffsetMs(guess + 3600_000, tz);
    return Math.max(ts, fwd);
  }
  // overlap: prefer the earlier instant
  const earlier = ts - 3600_000;
  const pe = zoneParts(earlier, tz);
  if (pe.h === local.h && pe.mi === local.mi && pe.d === local.d) return earlier;
  return ts;
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Calendar day arithmetic on a local date (no time zone involved). */
export function addDays(date: { y: number; m: number; d: number }, n: number) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addMonthsClamped(date: { y: number; m: number }, n: number, day: number) {
  const idx = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(idx / 12), m = (idx % 12) + 1;
  return { y, m, d: Math.min(day, daysInMonth(y, m)) };
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const dateKey = (p: { y: number; m: number; d: number }) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
export function parseDateKey(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
export function parseTimeOfDay(s: string): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h > 23 || mi > 59 ? null : { h, mi };
}

const LOCALE = "ar-SA-u-ca-gregory-nu-latn";
/** Human formatting in a given zone, Gregorian + Latin digits (matches the rest of the app). */
export const formatInZone = (ts: number, tz: string = DEFAULT_TZ, withZone = false) =>
  new Intl.DateTimeFormat(LOCALE, {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true,
    ...(withZone ? { timeZoneName: "short" } : {}),
  }).format(new Date(ts));
export const formatTimeInZone = (ts: number, tz: string = DEFAULT_TZ) =>
  new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ts));
export const TZ_LABEL = (tz: string) => (tz === DEFAULT_TZ ? "توقيت الرياض" : tz);
