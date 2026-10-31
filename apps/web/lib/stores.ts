import { createStore, jsonCodec } from "./storage";
import { parseActivity, parseTasks, parseThreads, type ActivityEntry, type Task, type Thread } from "./domain";
import type { PermissionMode } from "./permissions";

// Keys are unchanged from earlier versions so existing local data keeps working.
export const KEYS = {
  tasks: "safwan-local-tasks-v1",
  chats: "safwan-local-chats-v1",
  activity: "safwan-local-activity-v1",
  theme: "safwan-theme",
  compact: "safwan-compact",
  permission: "safwan-permission",
} as const;

export const tasksStore = createStore<Task[]>({ key: KEYS.tasks, fallback: [], ...jsonCodec(parseTasks, [] as Task[]) });
export const threadsStore = createStore<Thread[]>({ key: KEYS.chats, fallback: [], ...jsonCodec(parseThreads, [] as Thread[]) });
export const activityStore = createStore<ActivityEntry[]>({ key: KEYS.activity, fallback: [], ...jsonCodec(parseActivity, [] as ActivityEntry[]) });

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
