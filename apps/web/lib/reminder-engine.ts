/**
 * Foreground reminder engine (runs while the app is open). The server-side dispatcher is what delivers pushes when
 * the app is closed; this engine is the local-first half: it works offline, needs no account, and uses the SAME
 * `fire()` maths, so both sides land on the same next state and the same idempotency keys.
 */
import { alertAt, fire, type Fired, type Reminder } from "./reminders";
import { formatInZone, TZ_LABEL } from "./tz";
import { remindersStore } from "./stores";
import { deliverAlert, type AlertDeps, type AlertInput } from "./alerts";
import { spokenReminder } from "./speak";

export function alertFor(f: Fired): AlertInput {
  const when = `${formatInZone(f.dueAt, f.tz)} · ${TZ_LABEL(f.tz)}`;
  const missed = f.missed > 0 ? ` (فاتتك ${f.missed} ${f.missed === 1 ? "مرة سابقة" : "مرات سابقة"})` : "";
  return {
    key: f.key, type: "reminder", priority: f.priority, reminderId: f.reminderId, href: "/reminders",
    title: (f.kind === "snooze" ? "تذكير مؤجَّل: " : "تذكير: ") + f.title,
    body: (f.minutesBefore > 0 ? `${leadAfter(f.minutesBefore)} · ` : "حان الموعد · ") + when + missed,
    category: f.priority === "critical" ? "critical" : "reminder",
    spoken: spokenReminder(f.title, f.minutesBefore, f.kind),
  };
}
function leadAfter(min: number): string {
  if (min < 60) return `بعد ${min} دقيقة`;
  if (min % 1440 === 0) return min === 1440 ? "بعد يوم" : `بعد ${min / 1440} أيام`;
  if (min % 60 === 0) return `بعد ${min / 60} ساعة`;
  return `بعد ${Math.floor(min / 60)} ساعة و${min % 60} دقيقة`;
}

/** Fires every due reminder once. Returns the number of alerts delivered (duplicates excluded). */
export async function runDueReminders(now: number, deps: AlertDeps = {}): Promise<number> {
  const list = remindersStore.getSnapshot();
  const due = list.filter((r) => { const a = alertAt(r); return a !== null && a <= now; });
  if (!due.length) return 0;
  const results = new Map<string, { reminder: Reminder; fired: Fired[] }>();
  for (const r of due) { const res = fire(r, now); if (res.fired.length) results.set(r.id, res); }
  if (!results.size) return 0;
  // persist state advance FIRST (so a crash mid-delivery can never re-fire the same occurrence), then alert
  remindersStore.set((old) => old.map((r) => results.get(r.id)?.reminder ?? r));
  let delivered = 0;
  for (const { fired } of results.values()) {
    for (const f of fired) { const o = await deliverAlert(alertFor(f), { now: () => now, ...deps }); if (!o.duplicate) delivered++; }
  }
  return delivered;
}

export function nextAlertTime(list: Reminder[]): number | null {
  let min: number | null = null;
  for (const r of list) { const a = alertAt(r); if (a !== null && (min === null || a < min)) min = a; }
  return min;
}

/** Starts the foreground loop. Wakes at the next alert (≤30 s away), on focus/visibility/online, and on cross-tab changes. */
export function startReminderEngine(opts: { now?: () => number } = {}): () => void {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, again = false, stopped = false;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    const next = nextAlertTime(remindersStore.getSnapshot());
    const delay = next === null ? 30_000 : Math.min(30_000, Math.max(500, next - now() + 50));
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async () => {
    if (running) { again = true; return; }
    running = true;
    try { do { again = false; await runDueReminders(now()); } while (again); } finally { running = false; schedule(); }
  };
  const wake = () => void tick();
  const onVis = () => { if (document.visibilityState === "visible") wake(); };
  const unsub = remindersStore.subscribe(schedule);
  window.addEventListener("focus", wake); window.addEventListener("online", wake); window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", onVis);
  wake();
  return () => {
    stopped = true; clearTimeout(timer); unsub();
    window.removeEventListener("focus", wake); window.removeEventListener("online", wake); window.removeEventListener("pageshow", wake);
    document.removeEventListener("visibilitychange", onVis);
  };
}
