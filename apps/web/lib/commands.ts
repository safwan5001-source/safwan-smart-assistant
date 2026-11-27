/**
 * Command layer: the ONLY place UI actions mutate local data.
 *
 * UI → runCommand(id, payload, ctx) → permission policy → handler → stores → local activity log.
 *
 * - `origin: "user"` is a direct user action (button, form). It runs in `execute` mode.
 * - `origin: "assistant"` is anything the assistant proposes. It can never approve itself:
 *   `approved` is honoured only for user-origin calls (set by a confirmation dialog).
 * - `sensitive` commands (bulk deletion) always need that explicit approval.
 */
import { evaluate, type PermissionMode, type Risk } from "./permissions";
import { LIMITS, parseBrowserRef, type Priority, type Task, type Thread, type Message, type Attachment, type Role, type BrowserRef } from "./domain";
import { parseActionLine, parseBrowseCommand, type ActionRequest } from "./browser-task";
import { activityStore, firedStore, noticesStore, prefsStore, remindersStore, tasksStore, threadsStore, tombstonesStore, pushDeviceStore } from "./stores";
import { clearFiles } from "./files-db";
import { parseSlash } from "./slash";
import { Invalid, invalid, uid, type Def } from "./command-core";
import { notificationCommands, reminderCommands } from "./commands-notify";
import { isReminderIntent, parseReminderText, type Clarification } from "./reminder-parser";
import type { Reminder, ReminderInput } from "./reminders";
import { deliverAlert } from "./alerts";
import { eraseRemoteDevice } from "./push-client";

export type Ctx = { origin?: "user" | "assistant"; mode?: PermissionMode; approved?: boolean };
export type CommandResult<T = unknown> =
  | { status: "executed"; data: T }
  | { status: "denied" | "approval_required"; reason: string }
  | { status: "invalid"; message: string }
  | { status: "failed"; message: string };


const cleanTitle = (s: unknown, max: number = LIMITS.title) => {
  const t = typeof s === "string" ? s.trim().slice(0, max) : "";
  return t || invalid("العنوان مطلوب.");
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── tasks ───────────────────────────────────────────────────────────────
type TaskAdd = { title: string; priority?: Priority; due?: string; notes?: string };
type TaskPatch = { id: string; title?: string; priority?: Priority; due?: string | null; notes?: string };

const taskCommands = {
  "tasks.add": { id: "tasks.add", title: "إضافة مهمة", risk: "write", run: (p: TaskAdd): Task => {
    const task: Task = { id: uid(), title: cleanTitle(p.title), done: false, created: Date.now(), priority: p.priority ?? "normal" };
    if (p.due) { if (!DATE.test(p.due)) invalid("تاريخ غير صالح."); task.due = p.due; }
    if (p.notes?.trim()) task.notes = p.notes.trim().slice(0, LIMITS.notes);
    if (tasksStore.getSnapshot().length >= LIMITS.tasks) invalid("بلغت الحد الأقصى للمهام.");
    tasksStore.set((old) => [task, ...old]);
    return task;
  } } satisfies Def<TaskAdd, Task>,
  "tasks.toggle": { id: "tasks.toggle", title: "تغيير حالة مهمة", risk: "write", run: (p: { id: string }) => {
    const before = tasksStore.getSnapshot().find((t) => t.id === p.id) ?? invalid("المهمة غير موجودة.");
    tasksStore.set((old) => old.map((t) => t.id !== p.id ? t : t.done ? { ...t, done: false, completedAt: undefined } : { ...t, done: true, completedAt: Date.now() }));
    // completing a task: success tone + low-priority inbox item (idempotent per completion)
    if (!before.done) void deliverAlert({ key: `task-done:${p.id}:${Date.now()}`, type: "task", priority: "low", title: "أُنجزت المهمة", body: before.title, href: "/tasks", category: "success" }).catch(() => undefined);
  } } satisfies Def<{ id: string }, void>,
  "tasks.update": { id: "tasks.update", title: "تعديل مهمة", risk: "write", run: (p: TaskPatch) => {
    if (!tasksStore.getSnapshot().some((t) => t.id === p.id)) invalid("المهمة غير موجودة.");
    if (p.due && !DATE.test(p.due)) invalid("تاريخ غير صالح.");
    const title = p.title === undefined ? undefined : cleanTitle(p.title);
    tasksStore.set((old) => old.map((t) => {
      if (t.id !== p.id) return t;
      const next: Task = { ...t };
      if (title !== undefined) next.title = title;
      if (p.priority) next.priority = p.priority;
      if (p.due === null) delete next.due; else if (p.due) next.due = p.due;
      if (p.notes !== undefined) { if (p.notes.trim()) next.notes = p.notes.trim().slice(0, LIMITS.notes); else delete next.notes; }
      return next;
    }));
  } } satisfies Def<TaskPatch, void>,
  "tasks.remove": { id: "tasks.remove", title: "حذف مهمة", risk: "write", run: (p: { id: string }) => {
    tasksStore.set((old) => old.filter((t) => t.id !== p.id));
  } } satisfies Def<{ id: string }, void>,
  "tasks.clear_completed": { id: "tasks.clear_completed", title: "حذف المهام المكتملة", risk: "sensitive", run: (_: object) => {
    const n = tasksStore.getSnapshot().filter((t) => t.done).length;
    tasksStore.set((old) => old.filter((t) => !t.done));
    return n;
  } } satisfies Def<object, number>,
};

// ── chat ────────────────────────────────────────────────────────────────
type Send = { threadId: string | null; text: string; attachments?: Attachment[]; role?: Role; browser?: BrowserRef; main?: boolean };
const titleFrom = (text: string, att?: Attachment[]) => (text.trim() || att?.[0]?.name || "مرفقات").slice(0, 48);
const mkMessage = (text: string, attachments?: Attachment[], role?: Role, browser?: BrowserRef): Message => {
  const m: Message = { id: uid(), text: text.trim().slice(0, LIMITS.messageText), created: Date.now() };
  if (role && role !== "user") m.role = role;
  if (attachments?.length) m.attachments = attachments;
  if (browser) { const ref = parseBrowserRef(browser) ?? invalid("طلب التصفح غير صالح."); m.browser = ref; }
  return m;
};
const patchThread = (id: string, fn: (t: Thread) => Thread) => threadsStore.set((old) => old.map((t) => (t.id === id ? fn(t) : t)));
const assertRoomForThread = () => { if (threadsStore.getSnapshot().filter((t) => !t.main).length >= LIMITS.threads) invalid("بلغت الحد الأقصى للمحادثات؛ احذف أو أرشف محادثات قديمة."); };
const mustThread = (id: string) => threadsStore.getSnapshot().find((t) => t.id === id) ?? invalid("المحادثة غير موجودة.");

const chatCommands = {
  "chat.create": { id: "chat.create", title: "محادثة جديدة", risk: "write", run: (_: object): string => {
    assertRoomForThread();
    const t: Thread = { id: uid(), title: "محادثة جديدة", created: Date.now(), messages: [] };
    threadsStore.set((old) => [t, ...old]);
    return t.id;
  } } satisfies Def<object, string>,
  "chat.send": { id: "chat.send", title: "إرسال رسالة", risk: "write", run: (p: Send): string => {
    const m = mkMessage(p.text, p.attachments, p.role, p.browser);
    if (!m.text && !m.attachments?.length) invalid("الرسالة فارغة.");
    if (!p.threadId) {
      // the BASHT conversation has exactly one local thread: reuse it instead of creating a second one
      const main = p.main ? threadsStore.getSnapshot().find((t) => t.main) : undefined;
      if (main) { patchThread(main.id, (t) => ({ ...t, messages: [...t.messages, m], updated: Date.now() })); return main.id; }
      // the conversation's own thread is a single system thread: never refused by the archive's thread cap
      if (!p.main) assertRoomForThread();
      const t: Thread = { id: uid(), title: p.main ? "باشت" : titleFrom(m.text, m.attachments), created: Date.now(), messages: [m], ...(p.main ? { main: true as const } : {}) };
      threadsStore.set((old) => [t, ...old]);
      return t.id;
    }
    mustThread(p.threadId);
    patchThread(p.threadId, (t) => ({ ...t, title: t.messages.length ? t.title : titleFrom(m.text, m.attachments), messages: [...t.messages, m], updated: Date.now() }));
    return p.threadId;
  } } satisfies Def<Send, string>,
  // Updates the small reference kept on a browser card (offer -> started -> done). Never carries page content.
  "chat.browser.update": { id: "chat.browser.update", title: "تحديث بطاقة التصفح", risk: "write", run: (p: { threadId: string; id: string; patch: Partial<BrowserRef> }) => {
    const t = mustThread(p.threadId);
    const msg = t.messages.find((m) => m.id === p.id) ?? invalid("الرسالة غير موجودة.");
    if (!msg.browser) invalid("ليست بطاقة تصفح.");
    const next = parseBrowserRef({ ...msg.browser, ...p.patch, url: msg.browser!.url, mode: msg.browser!.mode }) ?? invalid("طلب التصفح غير صالح.");
    patchThread(p.threadId, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === p.id ? { ...m, browser: next } : m)) }));
  } } satisfies Def<{ threadId: string; id: string; patch: Partial<BrowserRef> }, void>,
  // The main thread is ONE continuous conversation; its direct-Claude context lives in server conversations capped at 400 messages.
  // Rotating starts a fresh server context while the visible timeline stays the same.
  "chat.claude.rotate": { id: "chat.claude.rotate", title: "سياق Claude جديد", risk: "write", run: (p: { id: string }): string => {
    const t = mustThread(p.id);
    if (!t.main) invalid("للمحادثة الرئيسية فقط.");
    const claudeId = uid();
    patchThread(p.id, (x) => ({ ...x, claudeId }));
    return claudeId;
  } } satisfies Def<{ id: string }, string>,
  "chat.rename": { id: "chat.rename", title: "إعادة تسمية", risk: "write", run: (p: { id: string; title: string }) => {
    const title = cleanTitle(p.title, LIMITS.threadTitle);
    mustThread(p.id);
    patchThread(p.id, (t) => ({ ...t, title }));
  } } satisfies Def<{ id: string; title: string }, void>,
  "chat.archive": { id: "chat.archive", title: "أرشفة/استعادة", risk: "write", run: (p: { id: string }) => {
    mustThread(p.id);
    patchThread(p.id, (t) => ({ ...t, archived: !t.archived }));
  } } satisfies Def<{ id: string }, void>,
  "chat.remove": { id: "chat.remove", title: "حذف محادثة", risk: "write", run: (p: { id: string }) => {
    threadsStore.set((old) => old.filter((t) => t.id !== p.id));
  } } satisfies Def<{ id: string }, void>,
  "chat.message.edit": { id: "chat.message.edit", title: "تعديل رسالة", risk: "write", run: (p: { threadId: string; id: string; text: string }) => {
    const t = mustThread(p.threadId);
    const msg = t.messages.find((m) => m.id === p.id) ?? invalid("الرسالة غير موجودة.");
    const text = p.text.trim().slice(0, LIMITS.messageText);
    if (!text && !msg.attachments?.length) invalid("الرسالة فارغة.");
    patchThread(p.threadId, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === p.id ? { ...m, text, edited: true } : m)) }));
  } } satisfies Def<{ threadId: string; id: string; text: string }, void>,
  "chat.message.remove": { id: "chat.message.remove", title: "حذف رسالة", risk: "write", run: (p: { threadId: string; id: string }) => {
    mustThread(p.threadId);
    patchThread(p.threadId, (x) => ({ ...x, messages: x.messages.filter((m) => m.id !== p.id) }));
  } } satisfies Def<{ threadId: string; id: string }, void>,
};

// ── data ────────────────────────────────────────────────────────────────
const dataCommands = {
  "data.erase_all": { id: "data.erase_all", title: "مسح كل البيانات المحلية", risk: "sensitive", run: async (_: object): Promise<{ filesCleared: boolean; serverErased: boolean }> => {
    // push server first (needs the device credentials we are about to wipe); an unreachable server is reported, never hidden
    const serverErased = await eraseRemoteDevice().catch(() => false);
    tasksStore.reset(); threadsStore.reset(); activityStore.reset();
    remindersStore.reset(); noticesStore.reset(); firedStore.reset(); prefsStore.reset(); tombstonesStore.reset();
    if (serverErased) pushDeviceStore.reset(); // otherwise eraseRemoteDevice() kept the credentials (marked erasePending) so the deletion can be retried
    // Report (don't hide) a failure to clear files so the UI never claims a complete wipe it didn't do.
    const filesCleared = await clearFiles().then(() => true, () => false);
    return { filesCleared, serverErased };
  } } satisfies Def<object, Promise<{ filesCleared: boolean; serverErased: boolean }>>,
};

const COMMANDS = { ...taskCommands, ...chatCommands, ...dataCommands, ...reminderCommands, ...notificationCommands } as const;
export type CommandId = keyof typeof COMMANDS;
type PayloadOf<K extends CommandId> = Parameters<(typeof COMMANDS)[K]["run"]>[0];
type DataOf<K extends CommandId> = Awaited<ReturnType<(typeof COMMANDS)[K]["run"]>>;

export const commandRisk = (id: CommandId): Risk => COMMANDS[id].risk;
export const commandTitle = (id: string): string => (id in COMMANDS ? COMMANDS[id as CommandId].title : id);

function log(command: string, status: string) {
  if (command === "data.erase_all" && status === "executed") return; // keep the wipe a wipe
  activityStore.set((old) => [{ id: uid(), ts: Date.now(), command, status }, ...old].slice(0, 100));
}

export async function runCommand<K extends CommandId>(id: K, payload: PayloadOf<K>, ctx: Ctx = {}): Promise<CommandResult<DataOf<K>>> {
  const def = COMMANDS[id] as unknown as Def<PayloadOf<K>, DataOf<K>>;
  const origin = ctx.origin ?? "user";
  const mode = ctx.mode ?? "execute";
  const verdict = evaluate(mode, def.risk);
  if (verdict === "deny") { log(id, "denied"); return { status: "denied", reason: `الوضع الحالي لا يسمح بعملية «${def.title}».` }; }
  if (verdict === "require_approval" && !(origin === "user" && ctx.approved === true)) {
    log(id, "approval_required");
    return { status: "approval_required", reason: `«${def.title}» تحتاج موافقتك الصريحة.` };
  }
  try {
    const data = await def.run(payload);
    log(id, "executed");
    return { status: "executed", data };
  } catch (e) {
    if (e instanceof Invalid) { log(id, "invalid"); return { status: "invalid", message: e.message }; }
    log(id, "failed");
    return { status: "failed", message: "تعذر تنفيذ الأمر." };
  }
}

// ── chat quick commands (deterministic, no AI) ───────────────────────────
export type ReminderOffer = { draft: Partial<ReminderInput>; clarification: Clarification; notes: string[] };
/** `outcome` reports whether a local command actually ran ("executed") or ran and failed; absent for offers, questions and invalid input. */
export type QuickReply = { handled: boolean; outcome?: "executed" | "failed"; reply?: string; reminderCreated?: Reminder; reminderOffer?: ReminderOffer; browserOffer?: { url: string; mode?: "interactive" }; browserAction?: ActionRequest };
export async function runQuickCommand(text: string): Promise<QuickReply> {
  // «ذكرني بكرة الساعة 9 …» — typed or dictated. Ambiguity is asked about BEFORE anything is saved.
  if (isReminderIntent(text)) {
    const out = parseReminderText(text, Date.now(), prefsStore.getSnapshot().tz); // the user's configured zone, like the reminders screen
    if (out.kind === "ready") {
      const res = await runCommand("reminders.add", out.draft);
      if (res.status === "executed") return { handled: true, outcome: "executed", reminderCreated: res.data, reply: `تم ضبط التذكير: «${res.data.title}».` };
      return res.status === "invalid" ? { handled: true, reply: res.message } : { handled: true, outcome: "failed", reply: "تعذر ضبط التذكير." };
    }
    if (out.kind === "clarify") return { handled: true, reply: out.clarification.question, reminderOffer: { draft: out.draft, clarification: out.clarification, notes: out.notes } };
  }
  // «/متصفح» — read-only test browsing. Only OFFERS a card; nothing is sent anywhere until the user presses «تشغيل» on it.
  const browse = parseBrowseCommand(text);
  if (browse) {
    if (browse.kind === "offer-interactive") return { handled: true, browserOffer: { url: "", mode: "interactive" } };
    return browse.kind === "offer" ? { handled: true, browserOffer: { url: browse.url } } : { handled: true, reply: browse.reason };
  }
  // «/افتح» «/انقر» «/اكتب» «/اقرأ» — a command line for the ACTIVE interactive session card. Parsing only; the card submits it, the worker decides.
  const line = parseActionLine(text);
  if (line) return line.kind === "action" ? { handled: true, browserAction: line.action } : { handled: true, reply: line.reason };
  const slash = parseSlash(text);
  if (!slash) return { handled: false };
  if (slash.name === "help") {
    return { handled: true, reply: "الأوامر السريعة المتاحة:\n/مهمة <العنوان> — إضافة مهمة\nذكرني بكرة الساعة 9 صباحاً <ما تريد> — ضبط تذكير (يمكنك أيضاً: بعد 30 دقيقة، كل يوم، قبل الموعد بنصف ساعة)\n/متصفح — تجربة قراءة صفحة اختبار (example.com) من متصفح سحابي؛ قراءة فقط وتحتاج موافقتك وإعداد المالك\n/مساعدة — عرض هذه القائمة\nهذه أوامر محلية ثابتة وليست ذكاءً اصطناعياً." };
  }
  const res = await runCommand("tasks.add", { title: slash.arg });
  if (res.status === "executed") return { handled: true, outcome: "executed", reply: `تمت إضافة المهمة: «${res.data.title}».` };
  return res.status === "invalid" ? { handled: true, reply: "اكتب عنوان المهمة بعد الأمر، مثل: /مهمة مراجعة الفواتير" } : { handled: true, outcome: "failed", reply: "تعذر تنفيذ الأمر." };
}
