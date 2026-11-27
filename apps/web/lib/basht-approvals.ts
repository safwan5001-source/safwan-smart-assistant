/**
 * B3 — BASHT approvals in the app: the browser client for /api/basht/approvals* and /api/basht/push, plus pure display helpers.
 * Same-origin, cookie-authenticated (the owner session); every failure becomes an Arabic message, upstream text never reaches the UI.
 * The app NEVER decides on its own: `decide` is only ever called from an explicit owner tap (+ confirmation).
 */
import type { PushDevice } from "./stores";

export type ApprovalKind = "exec" | "plugin" | "system-agent";
export type ApprovalSession = "app" | "main" | "whatsapp" | "cron" | "other" | "unknown";
export type Decision = "allow-once" | "deny";
export type PendingApproval = {
  id: string; kind: ApprovalKind; summary: string | null; title: string | null; session: ApprovalSession; isApp: boolean;
  warning: string | null; createdAt: number | null; expiresAt: number | null; decisions: Decision[];
};
export type DecidedApproval = {
  id: string; kind: ApprovalKind | null; summary: string | null; status: string | null; decision: "allow-once" | "allow-always" | "deny" | null;
  reason: string | null; session: ApprovalSession; by: "app" | "system" | "other" | null; createdAt: number | null; resolvedAt: number | null;
};
/** `available: false` = the engine's live link is down (or not deployed): show that honestly, never an empty "all clear". */
export type ApprovalsState = { available: boolean; link: "up" | "down"; approvals: PendingApproval[] };

export const APPROVAL_ERROR_TEXT: Record<string, string> = {
  link_down: "باشت غير متصل بالمحرك الآن؛ لا يمكن قراءة الموافقات أو الرد عليها حتى يعود الاتصال.",
  not_found: "انتهى هذا الطلب أو لم يعد موجودًا.",
  bad_decision: "قرار غير مسموح.", bad_id: "طلب غير صالح.", rejected: "رفض المحرك هذا الرد.",
  unauthorized: "انتهت جلسة الدخول؛ سجّل الدخول من جديد.", forbidden: "غير مصرّح بهذا الطلب.", disabled: "باشت غير مفعّل على الخادم.",
  rate_limited: "طلبات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.", unavailable: "تعذّر الوصول إلى باشت الآن.", network: "انقطع الاتصال بالخادم.",
  push_unconfigured: "الإشعارات غير مهيّأة على الخادم.", push_not_enabled: "فعّل إشعارات هذا الجهاز أولًا.", unauthorized_device: "سجّل هذا الجهاز للإشعارات أولًا.",
};
export const approvalErrorText = (code: string) => APPROVAL_ERROR_TEXT[code] ?? APPROVAL_ERROR_TEXT.unavailable;
export class ApprovalError extends Error { constructor(public code: string) { super(approvalErrorText(code)); this.name = "ApprovalError"; } }

export const KIND_LABEL: Record<ApprovalKind, string> = { exec: "تنفيذ أمر", plugin: "إجراء إضافة", "system-agent": "إجراء نظام" };
export const SESSION_LABEL: Record<ApprovalSession, string> = {
  app: "من محادثة التطبيق", main: "من الجلسة الرئيسية", whatsapp: "من واتساب", cron: "من مهمة مجدولة", other: "من جلسة أخرى", unknown: "",
};
export const DECISION_LABEL: Record<string, string> = { "allow-once": "سُمح مرة واحدة", "allow-always": "سُمح دائمًا", deny: "رُفض" };
const AR = new Intl.NumberFormat("ar-SA");

/** "تنتهي خلال ٢٩ د" / "تنتهي خلال ٤٥ ث" / "انتهت" — what the owner needs to know about the time left. */
export function countdown(expiresAt: number | null, now: number): { text: string; expired: boolean; urgent: boolean } {
  if (expiresAt === null) return { text: "", expired: false, urgent: false };
  const ms = expiresAt - now;
  if (ms <= 0) return { text: "انتهت مهلة الطلب", expired: true, urgent: true };
  const s = Math.ceil(ms / 1000);
  if (s < 60) return { text: `تنتهي خلال ${AR.format(s)} ث`, expired: false, urgent: true };
  const m = Math.ceil(s / 60);
  if (m < 60) return { text: `تنتهي خلال ${AR.format(m)} د`, expired: false, urgent: m <= 2 };
  return { text: `تنتهي خلال ${AR.format(Math.round(m / 60))} س`, expired: false, urgent: false };
}

/** Pending approvals that can still be answered, oldest first; `appOnly` keeps those raised by the app conversation (chat card). */
export function answerable(list: PendingApproval[], now: number, appOnly = false): PendingApproval[] {
  return list.filter((a) => (!appOnly || a.isApp) && (a.expiresAt === null || a.expiresAt > now) && a.decisions.length > 0)
    .sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
}

/** What the owner is asked to confirm before a decision is sent. */
export function confirmCopy(a: PendingApproval, d: Decision): { title: string; message: string; confirmLabel: string; tone: "default" | "danger" } {
  const what = a.summary ? `«${a.summary}»` : KIND_LABEL[a.kind];
  return d === "allow-once"
    ? { title: "السماح بهذا الطلب مرة واحدة؟", message: `سيُنفّذ باشت ${what} مرة واحدة فقط، ثم يكمل عمله.`, confirmLabel: "سماح مرة واحدة", tone: "default" }
    : { title: "رفض هذا الطلب؟", message: `لن يُنفّذ ${what}، وسيُبلَّغ باشت بالرفض.`, confirmLabel: "رفض", tone: "danger" };
}

/** The toast after a decision: applied, or someone answered first (Control UI / WhatsApp), or it expired. */
export function outcomeText(applied: boolean, recorded: string | null, d: Decision): string {
  if (applied) return d === "allow-once" ? "تمت الموافقة؛ يكمل باشت الآن." : "رُفض الطلب.";
  return recorded ? `سبق الرد على هذا الطلب (${DECISION_LABEL[recorded] ?? recorded}).` : "انتهى هذا الطلب قبل وصول ردك.";
}

/** Which section of the Notifications screen a URL asks for (?tab=approvals&focus=<id>); anything else is the inbox. */
export function sectionFromQuery(q: { get(name: string): string | null } | null): { section: "notices" | "approvals"; focus: string | null } {
  if (q?.get("tab") !== "approvals") return { section: "notices", focus: null };
  const f = q.get("focus");
  return { section: "approvals", focus: f && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(f) ? f : null };
}

type Fetch = typeof fetch;
export function createApprovalsClient(fetchImpl: Fetch = (...a) => fetch(...a)) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`/api/basht/${path}`, { credentials: "same-origin", cache: "no-store", ...init }); } catch { throw new ApprovalError("network"); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApprovalError(typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : "unavailable");
    return body as T;
  };
  const post = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  const bearer = (d: NonNullable<PushDevice>) => ({ Authorization: `Bearer ${d.deviceId}.${d.token}` });
  return {
    list: () => call<ApprovalsState>("approvals"),
    history: async () => (await call<{ available: boolean; items: DecidedApproval[] }>("approvals/history")).items,
    decide: (id: string, decision: Decision) => call<{ applied: boolean; approval: DecidedApproval | null }>("approvals/decide", post({ id, decision })),
    /** B4: is this push device linked to BASHT alerts (owner session + the device's own notify token) */
    pushLinked: async (d: NonNullable<PushDevice>) => (await call<{ enabled: boolean }>("push", { headers: bearer(d) })).enabled,
    setPushLinked: async (d: NonNullable<PushDevice>, enabled: boolean) => (await call<{ enabled: boolean }>("push", post({ enabled }, bearer(d)))).enabled,
  };
}
export const approvalsClient = createApprovalsClient();
