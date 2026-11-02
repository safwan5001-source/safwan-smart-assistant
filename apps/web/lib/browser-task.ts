/**
 * Shared (server + client) definitions for the chat browser task: the wire shape, its validator, the allow-listed test target and the
 * `/متصفح` quick command. No secrets, no I/O. The server is always authoritative: everything here is re-checked by the BFF, the API
 * and the worker, so a tampered client can at most get a clearer error message.
 */
export const BROWSER_TEST_URL = "https://example.com/";
export const BROWSER_ALLOWED_HOSTS = ["example.com"] as const;

export const STEP_IDS = ["create_session", "connect", "navigate", "read", "screenshot", "release"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type TaskStatus = "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type TaskError = "timeout" | "navigation_failed" | "disallowed_final_url" | "screenshot_too_large" | "browser_execution_failed";

// ── interactive sessions (CHAT-BROWSER-2) ────────────────────────────────────────────────────────────────────────────────────────
export const SESSION_STEP_IDS = ["create_session", "connect", "navigate", "interact", "release"] as const;
export type SessionStepId = (typeof SESSION_STEP_IDS)[number];
export const TOOLS = ["navigate", "click", "type", "observe"] as const;
export type Tool = (typeof TOOLS)[number];
export const ROLES = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch", "tab"] as const;
export type Role = (typeof ROLES)[number];
export type ActionStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "denied" | "rejected" | "cancelled";
export type ActionError =
  | "element_not_found" | "element_ambiguous" | "element_hidden" | "element_disabled" | "not_in_lab" | "sensitive_field" | "sensitive_action" | "sensitive_value"
  | "file_upload_blocked" | "download_blocked" | "leaves_scope" | "not_editable" | "element_changed" | "approval_rejected" | "approval_timeout" | "action_timeout"
  | "action_failed" | "navigation_failed" | "effect_blocked" | "element_unstable" | "unsupported_target" | "unsupported_enctype" | "payload_too_large" | "element_mismatch";
export type EndReason = "finished" | "idle" | "limit";
export type Locator = { by: "role"; role: Role; value: string; exact?: boolean } | { by: "label" | "placeholder" | "text"; value: string; exact?: boolean };
/** One action as the caller states it. Structured on purpose: there is no selector string, so nothing executable can be expressed. */
export type ActionRequest =
  | { tool: "navigate"; url: string } | { tool: "click"; target: Locator } | { tool: "type"; target: Locator; text: string } | { tool: "observe" };
export type SessionAction = { seq: number; tool: Tool; status: ActionStatus; summary: string; error?: ActionError };
export type Pending = { seq: number; kind: "submit" | "button"; summary: string; expiresAt?: number; submitsTo?: string; method?: "GET" | "POST"; element?: { tag: string; role?: string; text: string }; fields?: { name: string; value: string }[] };
export type SessionExtras = {
  mode: "interactive"; ready: boolean; limits: { maxActions: number; deadlineMs: number; idleMs: number; approvalMs: number }; deadlineAt?: number;
  blockedRequests: number; actions: SessionAction[]; endReason?: EndReason; pending?: Pending;
};

export type TaskView = {
  id: string; status: TaskStatus; url: string; steps: { id: StepId | SessionStepId; status: StepStatus }[]; sessionReleased: boolean;
  createdAt?: number; finishedAt?: number; error?: TaskError;
  result?: { title: string; url: string; excerpt: string; hasScreenshot: boolean; version?: number };
} & Partial<SessionExtras>;
export const isSession = (t: Pick<TaskView, "mode">): t is Pick<TaskView, "mode"> & SessionExtras => t.mode === "interactive";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET = /^https:\/\/example\.com(?:\/[A-Za-z0-9._~/-]{0,120})?$/;
const RESULT_URL = /^https:\/\/example\.com\/[\x21-\x7e]{0,300}$/;
const STATUSES = new Set<string>(["running", "cancelling", "succeeded", "failed", "cancelled"]);
const STEP_STATUSES = new Set<string>(["pending", "running", "done", "failed", "skipped"]);
const ERRORS = new Set<string>(["timeout", "navigation_failed", "disallowed_final_url", "screenshot_too_large", "browser_execution_failed"]);

export const isTaskId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const isAllowedBrowserUrl = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && TARGET.test(v) && !v.split("/").includes("..");

// control + format characters (bidi overrides, zero-width) are display-spoofing vectors in page text
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max) : "");

// Shape of a session URL when the caller cannot know the scope (the browser tab): https, no credentials, visible ASCII. It is only ever DISPLAYED as text.
// The BFF passes a strict predicate built from BROWSER_INTERACTIVE_SCOPES; the API and the worker enforce the scope again.
const SESSION_URL_SHAPE = /^https:\/\/[a-z0-9.-]{3,100}\/[\x21-\x7e]{0,300}$/;
export type ParseOptions = { sessionUrlOk?: (url: string) => boolean };
const ACTION_STATUSES = new Set<string>(["queued", "running", "awaiting_approval", "done", "failed", "denied", "rejected", "cancelled"]);
const ACTION_ERRORS = new Set<string>(["element_not_found", "element_ambiguous", "element_hidden", "element_disabled", "not_in_lab", "sensitive_field", "sensitive_action", "sensitive_value",
  "file_upload_blocked", "download_blocked", "leaves_scope", "not_editable", "element_changed", "approval_rejected", "approval_timeout", "action_timeout", "action_failed", "navigation_failed", "effect_blocked", "element_unstable", "unsupported_target", "unsupported_enctype", "payload_too_large", "element_mismatch"]);
const END_REASONS = new Set<string>(["finished", "idle", "limit"]);
const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null);

/** Rebuilds a TaskView from untrusted JSON (whitelist, bounded). Returns null for anything unexpected. */
export function parseTaskView(raw: unknown, opts: ParseOptions = {}): TaskView | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const session = o.mode === "interactive";
  if (o.mode !== undefined && !session) return null;
  const urlOk = session ? (opts.sessionUrlOk ?? ((u: string) => SESSION_URL_SHAPE.test(u))) : isAllowedBrowserUrl;
  if (!isTaskId(o.id) || typeof o.status !== "string" || !STATUSES.has(o.status) || typeof o.url !== "string" || !urlOk(o.url)) return null;
  const ids: readonly string[] = session ? SESSION_STEP_IDS : STEP_IDS;
  const steps = o.steps;
  if (!Array.isArray(steps) || steps.length !== ids.length) return null;
  const outSteps: TaskView["steps"] = [];
  for (let i = 0; i < ids.length; i++) {
    const s = steps[i] as Record<string, unknown> | null;
    if (!s || s.id !== ids[i] || typeof s.status !== "string" || !STEP_STATUSES.has(s.status)) return null;
    outSteps.push({ id: ids[i] as StepId, status: s.status as StepStatus });
  }
  const view: TaskView = { id: o.id, status: o.status as TaskStatus, url: o.url, steps: outSteps, sessionReleased: o.sessionReleased === true };
  for (const k of ["createdAt", "finishedAt"] as const) {
    const n = o[k];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n < 1e14) view[k] = n;
  }
  if (o.error !== undefined && o.error !== null) view.error = (typeof o.error === "string" && ERRORS.has(o.error) ? o.error : "browser_execution_failed") as TaskError;
  if (o.result !== undefined && o.result !== null) {
    const r = o.result as Record<string, unknown>;
    if (typeof r !== "object" || typeof r.url !== "string" || !(session ? urlOk(r.url) : RESULT_URL.test(r.url))) return null;
    view.result = { title: cleanText(r.title, 200), url: r.url, excerpt: cleanText(r.excerpt, 4000), hasScreenshot: r.hasScreenshot === true };
    const ver = int(r.version, 0, 1e6);
    if (session && ver !== null) view.result.version = ver;
  }
  if (!session) return view;

  const lim = o.limits as Record<string, unknown> | null;
  const limits = lim && typeof lim === "object" ? { maxActions: int(lim.maxActions, 1, 20), deadlineMs: int(lim.deadlineMs, 1, 3_600_000), idleMs: int(lim.idleMs, 1, 3_600_000), approvalMs: int(lim.approvalMs, 1, 3_600_000) } : null;
  if (!limits || Object.values(limits).some((v) => v === null)) return null;
  if (!Array.isArray(o.actions) || o.actions.length > 20) return null;
  const actions: SessionAction[] = [];
  for (let i = 0; i < o.actions.length; i++) {
    const a = o.actions[i] as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || a.seq !== i + 1 || typeof a.tool !== "string" || !(TOOLS as readonly string[]).includes(a.tool) || typeof a.status !== "string" || !ACTION_STATUSES.has(a.status)) return null;
    const item: SessionAction = { seq: i + 1, tool: a.tool as Tool, status: a.status as ActionStatus, summary: cleanText(a.summary, 300) };
    if (typeof a.error === "string") item.error = (ACTION_ERRORS.has(a.error) ? a.error : "action_failed") as ActionError;
    actions.push(item);
  }
  const ext: SessionExtras = {
    mode: "interactive", ready: o.ready === true, limits: limits as SessionExtras["limits"], blockedRequests: int(o.blockedRequests, 0, 1e6) ?? 0, actions,
  };
  const deadline = int(o.deadlineAt, 1, 1e14); if (deadline !== null) ext.deadlineAt = deadline;
  if (typeof o.endReason === "string" && END_REASONS.has(o.endReason)) ext.endReason = o.endReason as EndReason;
  if (o.pending !== undefined && o.pending !== null) {
    const p = o.pending as Record<string, unknown>;
    const seq = int(p.seq, 1, 20);
    if (typeof p !== "object" || seq === null || (p.kind !== "submit" && p.kind !== "button")) return null;
    const pending: Pending = { seq, kind: p.kind, summary: cleanText(p.summary, 300) };
    const exp = int(p.expiresAt, 1, 1e14); if (exp !== null) pending.expiresAt = exp;
    if (p.element !== undefined && p.element !== null) {
      const e = p.element as Record<string, unknown>;
      if (typeof e !== "object" || typeof e.tag !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(e.tag)) return null;
      pending.element = { tag: e.tag, text: cleanText(e.text, 120), ...(typeof e.role === "string" && e.role ? { role: cleanText(e.role, 30) } : {}) };
    }
    if (p.fields !== undefined && p.fields !== null) {
      if (!Array.isArray(p.fields) || p.fields.length > 13) return null;
      const fields: { name: string; value: string }[] = [];
      for (const f of p.fields as unknown[]) { const o2 = f as Record<string, unknown> | null; if (!o2 || typeof o2 !== "object") return null; fields.push({ name: cleanText(o2.name, 40), value: cleanText(o2.value, 60) }); }
      pending.fields = fields;
    }
    if (p.method !== undefined && p.method !== null) { if (p.method !== "GET" && p.method !== "POST") return null; pending.method = p.method; }
    if (p.submitsTo !== undefined && p.submitsTo !== null) { if (typeof p.submitsTo !== "string" || !urlOk(p.submitsTo)) return null; pending.submitsTo = p.submitsTo; }
    ext.pending = pending;
  }
  return Object.assign(view, ext);
}

export const isFinished = (s: TaskStatus) => s === "succeeded" || s === "failed" || s === "cancelled";

export const STEP_LABEL: Record<StepId, string> = {
  create_session: "تجهيز جلسة المتصفح", connect: "الاتصال والحماية", navigate: "فتح الصفحة", read: "قراءة النص", screenshot: "التقاط صورة", release: "إنهاء الجلسة",
};
export const ERROR_LABEL: Record<TaskError, string> = {
  timeout: "انتهت المهلة قبل اكتمال المهمة.",
  navigation_failed: "تعذر فتح الصفحة.",
  disallowed_final_url: "حُجبت الصفحة لأنها خارج القائمة المسموحة.",
  screenshot_too_large: "الصورة أكبر من الحد المسموح.",
  browser_execution_failed: "تعذر تنفيذ المهمة في المتصفح.",
};

export const SESSION_STEP_LABEL: Record<SessionStepId, string> = {
  create_session: "تجهيز جلسة المتصفح", connect: "الاتصال والحماية", navigate: "فتح الصفحة", interact: "جلسة تفاعلية", release: "إنهاء الجلسة",
};
export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  queued: "في الانتظار", running: "قيد التنفيذ", awaiting_approval: "بانتظار موافقتك", done: "تم", failed: "فشل", denied: "محظور", rejected: "لم يُنفَّذ", cancelled: "أُلغي",
};
export const ACTION_ERROR_LABEL: Record<ActionError, string> = {
  element_not_found: "لم يُعثر على العنصر.", element_ambiguous: "أكثر من عنصر يطابق الوصف؛ اجعله أدق.", element_hidden: "العنصر غير ظاهر.", element_disabled: "العنصر معطّل.",
  not_in_lab: "هذه الصفحة للقراءة فقط؛ النقر والكتابة متاحان في صفحة المختبر.", sensitive_field: "حقل حسّاس (كلمة مرور/بطاقة/رمز تحقق): محظور.",
  sensitive_action: "إجراء محظور في هذه المرحلة: دفع أو حذف أو تسجيل دخول أو حساب.", sensitive_value: "القيمة تشبه رقم بطاقة: محظورة.", file_upload_blocked: "رفع الملفات محظور.",
  download_blocked: "التنزيل محظور.", leaves_scope: "الرابط يخرج عن النطاق المسموح.", not_editable: "العنصر لا يقبل الكتابة.", element_changed: "تغيّر العنصر بعد الموافقة؛ أُلغي الإجراء.",
  effect_blocked: "حُجب أثناء الخطوة ما لم توافق عليه (طلب أو تنقّل أو بيانات مختلفة عمّا عُرض). يُحجب ما تراه البوابة فقط؛ لا تعتبر هذا إثباتًا بعدم خروج أي شيء آخر.", unsupported_enctype: "نوع ترميز النموذج غير مدعوم (يُدعم الافتراضي فقط).", payload_too_large: "بيانات النموذج أكبر من الحد المسموح للموافقة.", element_mismatch: "العنصر الظاهر في ذلك الموضع ليس العنصر الذي سمّيتَه (قد يكون غطاءً أو بديلًا)؛ رُفض الإجراء.", element_unstable: "العنصر يتحرك؛ أعد المحاولة بعد استقراره.",
  unsupported_target: "الهدف غير مدعوم (إطار/كائن مضمّن أو نص/سمة أطول من الحد).", approval_rejected: "رفضتَ هذه الخطوة.", approval_timeout: "انتهت مهلة الموافقة.", action_timeout: "انتهت مهلة الإجراء.", action_failed: "تعذر تنفيذ الإجراء.", navigation_failed: "تعذر فتح الصفحة.",
};
export const END_LABEL: Record<EndReason, string> = { finished: "أنهيتَ الجلسة.", idle: "انتهت الجلسة لعدم النشاط.", limit: "بلغت الجلسة حد عدد الخطوات." };
export const APPROVAL_KIND_LABEL: Record<Pending["kind"], string> = {
  submit: "هذا الزر يرسل نموذجًا.", button: "هذا الزر قد يغيّر بيانات في الصفحة.",
};
export const ROLE_LABEL: Record<Role, string> = { button: "زر", link: "رابط", textbox: "حقل", searchbox: "حقل بحث", checkbox: "خانة اختيار", radio: "زر اختيار", combobox: "قائمة", switch: "مفتاح", tab: "تبويب" };

// Mirrors what the worker accepts; the worker, the API and the BFF each validate again on their own. Control/bidi/zero-width characters are never allowed.
const UNSAFE_INPUT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
export const MAX_TYPED = 200, MAX_NAME = 80;
const okName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_NAME && !UNSAFE_INPUT.test(v);

export function parseLocator(raw: unknown): Locator | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || !okName(o.value)) return null;
  const exact = o.exact === undefined ? undefined : o.exact === true ? true : o.exact === false ? false : null;
  if (exact === null) return null;
  const keys = Object.keys(o);
  if (o.by === "role") {
    if (!keys.every((k) => ["by", "role", "value", "exact"].includes(k)) || typeof o.role !== "string" || !(ROLES as readonly string[]).includes(o.role)) return null;
    return { by: "role", role: o.role as Role, value: o.value.trim(), ...(exact !== undefined ? { exact } : {}) };
  }
  if ((o.by === "label" || o.by === "placeholder" || o.by === "text") && keys.every((k) => ["by", "value", "exact"].includes(k))) {
    return { by: o.by, value: o.value.trim(), ...(exact !== undefined ? { exact } : {}) };
  }
  return null;
}

/** Strict validation of an action. `urlOk` decides whether a `navigate` target is inside the allowed scope (server: env scopes; browser: shape only). */
export function parseActionRequest(raw: unknown, urlOk: (u: string) => boolean): ActionRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const only = (...k: string[]) => Object.keys(o).every((x) => k.includes(x));
  switch (o.tool) {
    case "observe": return only("tool") ? { tool: "observe" } : null;
    case "navigate": return only("tool", "url") && typeof o.url === "string" && o.url.length <= 200 && urlOk(o.url) ? { tool: "navigate", url: o.url } : null;
    case "click": { const t = only("tool", "target") ? parseLocator(o.target) : null; return t ? { tool: "click", target: t } : null; }
    case "type": {
      const t = only("tool", "target", "text") ? parseLocator(o.target) : null;
      if (!t || typeof o.text !== "string" || o.text.length > MAX_TYPED || UNSAFE_INPUT.test(o.text)) return null;
      return { tool: "type", target: t, text: o.text };
    }
    default: return null;
  }
}

// ── the `/متصفح` quick command ─────────────────────────────────────────────────────────────────
export type BrowseCommand =
  | { kind: "offer"; url: string }                    // show a card; nothing runs until the user presses «تشغيل»
  | { kind: "offer-interactive" }                     // an interactive session card; nothing runs until the user presses «السماح وبدء الجلسة»
  | { kind: "blocked"; reason: string };              // refused with an explanation, nothing is sent anywhere

const BROWSE_NAME = /^\/(متصفح|browse)(?:\s+([\s\S]*))?$/i;
// Anything that asks the browser to DO something (not just read) needs a capability and an explicit approval flow that do not exist yet.
const ACTION_WORDS = /(انقر|اضغط|سجل|سجّل|دخول|ادخل|اكتب|املأ|عبئ|أرسل|ارسل|ادفع|دفع|اشتر|احذف|حذف|حمّل|حمل|نزّل|نزل|click|type|fill|login|log in|sign in|submit|send|pay|buy|purchase|delete|remove|download|upload|post)/i;

export function parseBrowseCommand(text: string): BrowseCommand | null {
  const m = BROWSE_NAME.exec(text.trim());
  if (!m) return null;
  const arg = (m[2] ?? "").trim();
  if (/^(تفاعلي|تفاعلية|interactive)$/i.test(arg)) return { kind: "offer-interactive" };
  if (!arg) return { kind: "offer", url: BROWSER_TEST_URL };
  if (ACTION_WORDS.test(arg)) {
    return { kind: "blocked", reason: "هذه تجربة قراءة فقط: لا تنفّذ نقرًا ولا كتابة ولا تسجيل دخول ولا دفعًا. أي عملية من هذا النوع تحتاج موافقة صريحة خاصة بها، وهي غير مبنية بعد." };
  }
  if (/\s/.test(arg)) return { kind: "blocked", reason: "اكتب عنوانًا واحدًا فقط، مثل: /متصفح https://example.com" };
  const url = /^https?:\/\//i.test(arg) ? arg : `https://${arg}`;
  if (!isAllowedBrowserUrl(url)) {
    return { kind: "blocked", reason: `المسموح في هذه التجربة موقع الاختبار فقط: ${BROWSER_ALLOWED_HOSTS.join("، ")} (عبر https، بلا منفذ ولا بيانات دخول ولا معاملات).` };
  }
  return { kind: "offer", url };
}

// ── action lines typed in the chat: «/افتح …», «/انقر …», «/اكتب …», «/اقرأ» ─────────────────────────────────────────────────────────────
// Deterministic grammar, no AI. Smart quotes (what an iPhone keyboard inserts) are accepted. A line only ever becomes an ActionRequest that the
// active session card submits; the worker decides whether it is allowed, and anything that changes data still needs the user's approval.
const ROLE_WORDS: Record<string, Locator["by"] | Role> = {
  زر: "button", button: "button", رابط: "link", link: "link", حقل: "textbox", textbox: "textbox", input: "textbox", بحث: "searchbox", searchbox: "searchbox",
  خانة: "checkbox", checkbox: "checkbox", اختيار: "radio", radio: "radio", قائمة: "combobox", combobox: "combobox", مفتاح: "switch", switch: "switch", تبويب: "tab", tab: "tab",
  خانة_اختيار: "checkbox", زر_اختيار: "radio", حقل_بحث: "searchbox", عنوان: "label", label: "label", نص_إرشادي: "placeholder", placeholder: "placeholder", نص: "text", text: "text",
};
const Q = "[\"“”«»„‟]";
const QUOTED = `${Q}([^"“”«»„‟]{1,200})${Q}`;
const VERB = "(?:انقر|اضغط|click|tap)";
const CLICK_RE = new RegExp(`^/${VERB}\\s+(?:على\\s+)?(\\S+(?:\\s+(?:إرشادي|اختيار|بحث))?)\\s+${QUOTED}\\s*$`, "i");
const TYPE_RE = new RegExp(`^/(?:اكتب|type)\\s+${QUOTED}\\s+(?:في|in|into)\\s+(\\S+(?:\\s+(?:إرشادي|اختيار|بحث))?)\\s+${QUOTED}\\s*$`, "i");
const OPEN_RE = /^\/(?:افتح|انتقل|open|goto)\s+(\S+)\s*$/i;
const OBSERVE_RE = /^\/(?:اقرأ|حدّث|حدث|observe|read)\s*$/i;
export const ACTION_USAGE = 'الصيغ: ‎/افتح https://…  ‎·  ‎/انقر زر "الاسم"  ‎·  ‎/اكتب "النص" في حقل "الاسم"  ‎·  ‎/اقرأ';

function locatorFrom(word: string, value: string): Locator | null {
  const key = ROLE_WORDS[word.trim().replace(/\s+/g, "_")];
  if (!key) return null;
  return parseLocator(key === "label" || key === "placeholder" || key === "text" ? { by: key, value } : { by: "role", role: key, value });
}

export type ActionLine = { kind: "action"; action: ActionRequest } | { kind: "error"; reason: string } | null;
export function parseActionLine(text: string, urlOk: (u: string) => boolean = (u) => SESSION_URL_SHAPE.test(u)): ActionLine {
  const t = text.trim();
  if (!/^\/(?:افتح|انتقل|open|goto|انقر|اضغط|click|tap|اكتب|type|اقرأ|حدّث|حدث|observe|read)(?:\s|$)/i.test(t)) return null;
  let m: RegExpExecArray | null;
  if (OBSERVE_RE.test(t)) return { kind: "action", action: { tool: "observe" } };
  if ((m = OPEN_RE.exec(t))) {
    const a = parseActionRequest({ tool: "navigate", url: /^https?:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}` }, urlOk);
    return a ? { kind: "action", action: a } : { kind: "error", reason: "العنوان خارج النطاق المسموح لهذه الجلسة." };
  }
  if ((m = CLICK_RE.exec(t))) {
    const loc = locatorFrom(m[1], m[2]);
    return loc ? { kind: "action", action: { tool: "click", target: loc } } : { kind: "error", reason: `نوع العنصر غير معروف. ${ACTION_USAGE}` };
  }
  if ((m = TYPE_RE.exec(t))) {
    const loc = locatorFrom(m[2], m[3]);
    const a = loc ? parseActionRequest({ tool: "type", target: loc, text: m[1] }, urlOk) : null;
    return a ? { kind: "action", action: a } : { kind: "error", reason: `تعذر فهم الأمر. ${ACTION_USAGE}` };
  }
  return { kind: "error", reason: `تعذر فهم الأمر. ${ACTION_USAGE}` };
}

/** True for anything that belongs to the browser feature and must never be forwarded to an AI provider: «/متصفح …» commands and the action lines (they carry typed values). */
export function isBrowserCommandLine(text: string): boolean {
  return parseBrowseCommand(text) !== null || parseActionLine(text) !== null;
}
