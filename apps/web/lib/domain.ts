/** Shared data shapes + sanitising parsers. Shapes are backward compatible with data
 *  saved by earlier versions (keys safwan-local-tasks-v1 / safwan-local-chats-v1). */
import { isAllowedBrowserUrl, isTaskId } from "./browser-task";

export type Priority = "high" | "normal" | "low";
export type Task = {
  id: string; title: string; done: boolean; created: number;
  priority?: Priority; due?: string; notes?: string; completedAt?: number;
};
export type Attachment = { id: string; name: string };
export type Role = "user" | "system" | "assistant";
/** A browser-task card inside the conversation. Only the reference is stored locally: never the page text, the screenshot or any session data. */
export type BrowserRef = { url: string; mode?: "interactive"; state: "offer" | "started" | "done" | "dismissed"; taskId?: string; outcome?: "succeeded" | "failed" | "cancelled" };
export type Message = { id: string; text: string; created: number; role?: Role; attachments?: Attachment[]; edited?: boolean; browser?: BrowserRef };
/** `main`: the one on-device thread of the BASHT conversation (its local events: commands, browser cards). Every other thread is the local archive. */
export type Thread = { id: string; title: string; created: number; messages: Message[]; archived?: boolean; updated?: number; main?: true; claudeId?: string };

export const LIMITS = { tasks: 1000, threads: 500, title: 200, threadTitle: 80, notes: 2000, messageText: 20000 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return [];
  const out: Task[] = [];
  for (const v of value) {
    if (!isObj(v) || !isStr(v.id) || !isStr(v.title) || typeof v.done !== "boolean" || !isNum(v.created)) continue;
    const task: Task = { id: v.id, title: v.title.slice(0, LIMITS.title), done: v.done, created: v.created };
    if (v.priority === "high" || v.priority === "normal" || v.priority === "low") task.priority = v.priority;
    if (isStr(v.due) && DATE.test(v.due)) task.due = v.due;
    if (isStr(v.notes) && v.notes) task.notes = v.notes.slice(0, LIMITS.notes);
    if (isNum(v.completedAt)) task.completedAt = v.completedAt;
    out.push(task);
    if (out.length >= LIMITS.tasks) break;
  }
  return out;
}

const BROWSER_STATES = new Set(["offer", "started", "done", "dismissed"]);
const OUTCOMES = new Set(["succeeded", "failed", "cancelled"]);
export function parseBrowserRef(v: unknown): BrowserRef | null {
  if (!isObj(v) || !isStr(v.url) || !isStr(v.state) || !BROWSER_STATES.has(v.state)) return null;
  // an interactive card stores NO address (the page comes from the server's configuration); a read-only card keeps the one fixed test address
  const interactive = v.mode === "interactive";
  if (v.mode !== undefined && !interactive) return null;
  if (interactive ? v.url !== "" : !isAllowedBrowserUrl(v.url)) return null;
  const ref: BrowserRef = interactive ? { url: "", mode: "interactive", state: v.state as BrowserRef["state"] } : { url: v.url, state: v.state as BrowserRef["state"] };
  if (isStr(v.taskId) && isTaskId(v.taskId)) ref.taskId = v.taskId;
  if (isStr(v.outcome) && OUTCOMES.has(v.outcome)) ref.outcome = v.outcome as BrowserRef["outcome"];
  if (ref.state === "started" && !ref.taskId) ref.state = "dismissed"; // a "started" card with no task id can never be resumed
  return ref;
}

function parseMessage(v: unknown): Message | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.text) || !isNum(v.created)) return null;
  const m: Message = { id: v.id, text: v.text.slice(0, LIMITS.messageText), created: v.created };
  if (v.role === "user" || v.role === "system" || v.role === "assistant") m.role = v.role;
  if (v.edited === true) m.edited = true;
  const browser = parseBrowserRef(v.browser);
  if (browser) m.browser = browser;
  if (Array.isArray(v.attachments)) {
    const att = v.attachments.filter((a): a is Attachment => isObj(a) && isStr(a.id) && isStr(a.name)).map((a) => ({ id: a.id, name: a.name }));
    if (att.length) m.attachments = att;
  }
  return m;
}

export function parseThreads(value: unknown): Thread[] {
  if (!Array.isArray(value)) return [];
  const out: Thread[] = [];
  let archived = 0, hasMain = false;
  for (const v of value) {
    if (!isObj(v) || !isStr(v.id) || !Array.isArray(v.messages)) continue;
    const t: Thread = {
      id: v.id,
      title: isStr(v.title) && v.title ? v.title.slice(0, LIMITS.threadTitle) : "محادثة",
      created: isNum(v.created) ? v.created : Date.now(),
      messages: v.messages.map(parseMessage).filter((m): m is Message => m !== null),
    };
    if (v.archived === true) t.archived = true;
    if (isNum(v.updated)) t.updated = v.updated;
    // the conversation's single `main` thread is in addition to the archive's cap, so saving it can never push an archive out
    if (v.main === true && !hasMain) {
      t.main = true; hasMain = true;
      // direct-Claude backend conversation of the main thread (rotated when the server's per-conversation cap is reached)
      if (isStr(v.claudeId) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.claudeId)) t.claudeId = v.claudeId;
      out.push(t); continue;
    }
    if (archived >= LIMITS.threads) continue;
    archived++;
    out.push(t);
  }
  return out;
}

export type ActivityEntry = { id: string; ts: number; command: string; status: string };
export function parseActivity(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is ActivityEntry => isObj(v) && isStr(v.id) && isNum(v.ts) && isStr(v.command) && isStr(v.status))
    .map((v) => ({ id: v.id, ts: v.ts, command: v.command, status: v.status }))
    .slice(0, 100);
}
