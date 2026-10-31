// Gregorian calendar + Latin digits: matches invoices/accounting records (ar-SA defaults to Hijri).
const LOCALE = "ar-SA-u-ca-gregory-nu-latn";

export const formatToday = (d: Date) => d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
export const formatDay = (isoDate: string) => {
  const d = new Date(isoDate + "T00:00:00");
  return Number.isNaN(d.getTime()) ? isoDate : d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
};
export const formatTime = (ts: number) => new Date(ts).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type DueState = "overdue" | "today" | "upcoming" | "none";
export function dueState(due: string | undefined, today = localDateKey()): DueState {
  if (!due) return "none";
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}
