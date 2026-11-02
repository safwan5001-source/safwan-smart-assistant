import { createStore, jsonCodec } from "./storage";
import { parseActivity, parseTasks, parseThreads, type ActivityEntry, type Task, type Thread } from "./domain";
import type { PermissionMode } from "./permissions";
import { parseReminders, type Reminder } from "./reminders";
import { parseNotices, type Notice } from "./notifications";
import { DEFAULT_PREFS, parsePrefs, type NotifyPrefs } from "./notify-prefs";

// Keys are unchanged from earlier versions so existing local data keeps working.
export const KEYS = {
  tasks: "safwan-local-tasks-v1",
  chats: "safwan-local-chats-v1",
  activity: "safwan-local-activity-v1",
  theme: "safwan-theme",
  compact: "safwan-compact",
  permission: "safwan-permission",
  reminders: "safwan-reminders-v1",
  notices: "safwan-notices-v1",
  notifyPrefs: "safwan-notify-prefs-v1",
  fired: "safwan-fired-v1",
  pushDevice: "safwan-push-device-v1",
  tombstones: "safwan-reminder-tombstones-v1",
} as const;

export const tasksStore = createStore<Task[]>({ key: KEYS.tasks, fallback: [], ...jsonCodec(parseTasks, [] as Task[]) });
export const threadsStore = createStore<Thread[]>({ key: KEYS.chats, fallback: [], ...jsonCodec(parseThreads, [] as Thread[]) });
export const activityStore = createStore<ActivityEntry[]>({ key: KEYS.activity, fallback: [], ...jsonCodec(parseActivity, [] as ActivityEntry[]) });

export const remindersStore = createStore<Reminder[]>({ key: KEYS.reminders, fallback: [], ...jsonCodec(parseReminders, [] as Reminder[]) });
export const noticesStore = createStore<Notice[]>({ key: KEYS.notices, fallback: [], ...jsonCodec(parseNotices, [] as Notice[]) });
export const prefsStore = createStore<NotifyPrefs>({ key: KEYS.notifyPrefs, fallback: DEFAULT_PREFS, ...jsonCodec(parsePrefs, DEFAULT_PREFS) });
/** Idempotency log of alerts already delivered on this device (key → time). Bounded. */
export type FiredEntry = { key: string; ts: number };
export const FIRED_LIMIT = 400;
export function parseFired(v: unknown): FiredEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is FiredEntry => !!x && typeof x.key === "string" && typeof x.ts === "number").slice(0, FIRED_LIMIT);
}
export const firedStore = createStore<FiredEntry[]>({ key: KEYS.fired, fallback: [], ...jsonCodec(parseFired, [] as FiredEntry[]) });
/** Credentials of this device at the push server. The token is a bearer secret that only ever goes to our own API. */
/** `erasePending`: the user asked to wipe everything but the server could not be reached — credentials are kept ONLY to retry the deletion. */
export type PushDevice = { deviceId: string; token: string; subscribed: boolean; registeredAt: number; erasePending?: true } | null;
export function parsePushDevice(v: unknown): PushDevice {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.deviceId !== "string" || typeof o.token !== "string" || typeof o.registeredAt !== "number") return null;
  return { deviceId: o.deviceId, token: o.token, subscribed: o.subscribed === true, registeredAt: o.registeredAt, ...(o.erasePending === true ? { erasePending: true as const } : {}) };
}
export const pushDeviceStore = createStore<PushDevice>({ key: KEYS.pushDevice, fallback: null, ...jsonCodec(parsePushDevice, null as PushDevice) });

/** Ids of reminders deleted on this device that the push server may still hold; sent with the next sync, then cleared. */
export const tombstonesStore = createStore<string[]>({
  key: KEYS.tombstones, fallback: [],
  ...jsonCodec((v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : []), [] as string[]),
});

export type Theme = "system" | "light" | "dark";
export const themeStore = createStore<Theme>({
  key: KEYS.theme, fallback: "system",
  decode: (r) => (r === "light" || r === "dark" ? r : "system"), encode: (v) => v,
});
export const compactStore = createStore<boolean>({ key: KEYS.compact, fallback: false, decode: (r) => r === "true", encode: String });

/** Preference for how future assistant tasks should start ("ask" = ask me every time). */
export type TaskModePref = "ask" | "review";
export const taskModePrefStore = createStore<TaskModePref>({
  key: KEYS.permission, fallback: "ask", decode: (r) => (r === "review" ? "review" : "ask"), encode: (v) => v,
});
export const DEFAULT_ASSISTANT_MODE = (pref: TaskModePref): PermissionMode => (pref === "review" ? "review" : "approve");
