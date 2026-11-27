/**
 * B5–B7, browser side: BASHT's scheduled tasks, usage, memory (read-only) and "what BASHT can do now", through /api/basht/*.
 * Every value shown comes from the engine; this file only names it in Arabic. `control_unavailable` means the engine has no such
 * view (older bridge): the UI hides the section rather than reporting an outage.
 */
import { BashtError } from "./basht-client";

export type Schedule = { kind: "cron"; expr: string | null; tz: string | null } | { kind: "every"; every_ms: number | null } | { kind: "at"; at: string | null } | { kind: "other" };
export type RunStatus = "ok" | "error" | "skipped" | null;
export type Delivery = "delivered" | "not-delivered" | "unknown" | "not-requested" | null;
export type Automation = {
  id: string; name: string; enabled: boolean; system: boolean; kind: "agent" | "event" | "command" | "other"; prompt: string | null;
  schedule: Schedule; next_run_at: number | null; running: boolean;
  last: { at: number | null; status: RunStatus; duration_ms: number | null; delivery: Delivery; error: string | null } | null;
  consecutive_errors: number; auto_disabled: boolean;
};
export type AutomationRun = { at: number; status: RunStatus; completion: "succeeded" | "failed" | "unknown" | null; duration_ms: number | null;
  quiet: boolean; summary: string | null; error: string | null; delivery: Delivery };
export type UsageDay = { date: string; tokens: number; cost: number | null; cost_partial: boolean };
export type Usage = {
  app: { tokens: number; cost: number | null; cost_partial: boolean; input: number; output: number; today: UsageDay | null } | null;
  all: { tokens: number; cost: number | null; cost_partial: boolean; days: number | null; today: UsageDay | null; daily: UsageDay[] } | null;
  missing_cost_models: string[];
};
export type MemoryStatus = { state: "ok" | "stale" | "degraded" | "disabled" | "unavailable" | "unknown"; reason: string | null; search_mode: string | null;
  files: number | null; chunks: number | null; last_indexed_at: number | null; bootstrap: { name: string; exists: boolean; size: number | null; updated_at: number | null }[] };
export type MemoryHit = { file: string; snippet: string; ref: string | null; date: string | null };
export type MemoryText = { text: string; part: number; parts: number; chars: number; truncated: boolean };
export type Skill = { name: string; emoji: string | null; description: string | null; missing?: { bins: string[]; env: string[]; config: number; os: boolean } };
export type Capabilities = {
  channels: { id: string; label: string; accounts: number; configured: boolean; linked: boolean; connected: boolean; last_connected_at: number | null; issue: string | null }[] | null;
  skills: { ready: Skill[]; missing: Skill[]; unavailable: { name: string; emoji: string | null; state: string }[]; total: number } | null;
  tools: { profile: string | null; count: number; groups: { id: string; label: string | null; plugin: boolean; tools: { id: string; label: string }[] }[] } | null;
  plugins: { enabled: { id: string; name: string }[]; needs_setup: { id: string; name: string }[]; failed: { id: string; name: string }[]; total: number } | null;
};

export const CONTROL_ERROR_TEXT: Record<string, string> = {
  system_job: "هذه مهمة يديرها باشت نفسه؛ لا تُشغَّل ولا تُوقف من التطبيق.",
  rejected: "رفض المحرك هذا الطلب.",
  busy: "هذه المهمة تعمل الآن؛ انتظر حتى تنتهي.",
  not_found: "لم تعد هذه المهمة موجودة في باشت.",
  control_unavailable: "هذه الميزة غير متاحة في نسخة المحرك الحالية.",
};
export const controlErrorText = (e: unknown) =>
  e instanceof BashtError ? CONTROL_ERROR_TEXT[e.code] ?? e.message : "تعذّر الوصول إلى محرك باشت الآن.";
/** Ids the app can address (the API path alphabet is lower-case); others are shown but not actionable from here. */
export const JOB_ADDRESSABLE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const isUnavailable = (e: unknown) => e instanceof BashtError && (e.code === "control_unavailable" || e.code === "disabled");

type Fetch = typeof fetch;
export function createControlClient(fetchImpl: Fetch = (...a) => fetch(...a)) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`/api/basht/${path}`, { credentials: "same-origin", cache: "no-store", ...init }); } catch { throw new BashtError("network"); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new BashtError(typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : "unavailable");
    return body as T;
  };
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    automations: async () => (await call<{ jobs: Automation[] }>("automations")).jobs,
    runs: async (id: string) => (await call<{ runs: AutomationRun[] }>(`automations/${encodeURIComponent(id)}/runs`)).runs,
    runNow: async (id: string) => (await call<{ enqueued: boolean }>(`automations/${encodeURIComponent(id)}/run`, post({}))).enqueued,
    setEnabled: async (id: string, enabled: boolean) => (await call<{ enabled: boolean | null }>(`automations/${encodeURIComponent(id)}/enabled`, post({ enabled }))).enabled,
    usage: () => call<Usage>("usage"),
    memoryStatus: () => call<MemoryStatus>("memory/status"),
    memorySearch: (q: string, page = 0) => call<{ results: MemoryHit[]; more: boolean; stale: boolean; page: number }>(`memory/search?q=${encodeURIComponent(q)}&page=${page}`),
    memoryItem: (ref: string, part = 0) => call<MemoryText & { file: string | null }>(`memory/item?ref=${ref}&part=${part}`),
    memoryFile: (name: "MEMORY.md" | "USER.md", part = 0) => call<MemoryText & { name: string; exists: boolean; updated_at: number | null }>(`memory/file?name=${name}&part=${part}`),
    capabilities: () => call<Capabilities>("capabilities"),
  };
}
export const controlClient = createControlClient();

// ───────────────────────── formatting ─────────────────────────
const LOCALE = "ar-SA-u-ca-gregory-nu-latn";
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const TZ: Record<string, string> = { "Asia/Riyadh": "بتوقيت الرياض", UTC: "بتوقيت UTC", "Asia/Dubai": "بتوقيت دبي", "Africa/Cairo": "بتوقيت القاهرة" };

/** "7:00 ص" / "9:30 م" */
export function clock(h: number, m: number): string {
  const suffix = h < 12 ? "ص" : "م";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Arabic count phrase with the right noun form: 1 ساعة · 2 ساعتان · 3–10 ساعات · 11+ ساعة. */
export function count(n: number, one: string, two: string, few: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${one}`;
}
const minutes = (n: number) => count(n, "دقيقة", "دقيقتين", "دقائق");
const hours = (n: number) => count(n, "ساعة", "ساعتين", "ساعات");
const daysN = (n: number) => count(n, "يوم", "يومين", "أيام");

export function everyLabel(ms: number | null): string {
  if (!ms || ms <= 0) return "بشكل متكرر";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `كل ${minutes(Math.max(1, min))}`;
  if (min % 1440 === 0) return min === 1440 ? "كل يوم" : `كل ${daysN(min / 1440)}`;
  if (min % 60 === 0) return `كل ${hours(min / 60)}`;
  return `كل ${hours(Math.floor(min / 60))} و${minutes(min % 60)}`;
}

const isNum = (s: string, max: number) => /^\d{1,2}$/.test(s) && Number(s) <= max;
function dowLabel(f: string): string | null {
  if (f === "1-5") return "من الاثنين إلى الجمعة";
  if (f === "0-4" || f === "7,1-4" || f === "0,1,2,3,4") return "من الأحد إلى الخميس";
  const parts = f === "5-6" ? ["5", "6"] : f.split(",");
  if (!parts.every((p) => isNum(p, 7))) return null;
  const names = [...new Set(parts.map((p) => DAYS[Number(p) % 7]))];
  return names.length === 1 ? `كل يوم ${names[0]}` : `أيام ${names.join(" و")}`;
}

/** A schedule as the owner would say it. Unknown cron shapes show the expression itself (never a guess). */
export function scheduleLabel(s: Schedule): string {
  if (s.kind === "every") return everyLabel(s.every_ms);
  if (s.kind === "at") {
    const t = s.at ? Date.parse(s.at) : NaN;
    return Number.isNaN(t) ? "مرة واحدة" : `مرة واحدة: ${new Date(t).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
  }
  if (s.kind !== "cron" || !s.expr) return "حسب حدث في باشت";
  const tz = s.tz ? ` (${TZ[s.tz] ?? s.tz})` : "";
  const f = s.expr.trim().split(/\s+/);
  if (f.length !== 5) return `جدول مخصص: ${s.expr}${tz}`;
  const [mi, ho, dom, mon, dow] = f;
  const step = /^\*\/(\d{1,2})$/;
  if (step.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*") return `كل ${minutes(Number(step.exec(mi)![1]))}`;
  if (isNum(mi, 59) && step.test(ho) && dom === "*" && mon === "*" && dow === "*") return `كل ${hours(Number(step.exec(ho)![1]))}${tz}`;
  if (isNum(mi, 59) && ho === "*" && dom === "*" && mon === "*" && dow === "*") return `كل ساعة عند الدقيقة ${Number(mi)}`;
  if (isNum(mi, 59) && isNum(ho, 23) && mon === "*") {
    const at = `الساعة ${clock(Number(ho), Number(mi))}`;
    if (dom === "*" && dow === "*") return `يوميًا ${at}${tz}`;
    if (dom === "*") { const d = dowLabel(dow); if (d) return `${d} ${at}${tz}`; }
    if (isNum(dom, 31) && dow === "*") return `يوم ${Number(dom)} من كل شهر ${at}${tz}`;
  }
  return `جدول مخصص: ${s.expr}${tz}`;
}

/** "بعد 3 ساعات" / "قبل 5 دقائق" / "الآن". */
export function relative(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "";
  const d = ts - now, a = Math.abs(d), future = d > 0;
  const pre = future ? "بعد" : "قبل";
  if (a < 60_000) return future ? "خلال دقيقة" : "الآن";
  if (a < 3_600_000) return `${pre} ${minutes(Math.round(a / 60_000))}`;
  if (a < 86_400_000) return `${pre} ${hours(Math.round(a / 3_600_000))}`;
  if (a < 7 * 86_400_000) return `${pre} ${daysN(Math.round(a / 86_400_000))}`;
  return new Date(ts).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return "أقل من ثانية";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} ث`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} د ${s % 60} ث` : `${m} د`;
}

export const RUN_LABEL: Record<string, { label: string; tone: "ok" | "danger" | "warn" | undefined }> = {
  ok: { label: "نجحت", tone: "ok" }, error: { label: "فشلت", tone: "danger" }, skipped: { label: "تخطّاها باشت", tone: "warn" },
};
export const DELIVERY_LABEL: Record<string, string> = {
  delivered: "أُرسلت النتيجة", "not-delivered": "لم تُرسل النتيجة", unknown: "حالة الإرسال غير معروفة", "not-requested": "",
};

/** 10953 → "10,953" · 1_250_000 → "1.25M" (Latin digits, like the rest of the app's numbers). */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  return n.toLocaleString("en-US");
}
/** Cost in US dollars as the engine reports it; null is "غير معروفة" (a model without pricing), never $0. */
export function formatCost(c: number | null | undefined, partial = false): string {
  if (c == null) return "غير معروفة";
  const v = c === 0 ? "$0" : c < 0.01 ? "< $0.01" : `$${c.toFixed(c < 10 ? 2 : 0)}`;
  return partial ? `${v}+ (جزئية)` : v;
}

const CHANNEL_ISSUE: Record<string, string> = { auth: "يحتاج إعادة ربط أو مصادقة", config: "إعداد ناقص", permissions: "صلاحيات ناقصة", intent: "إعداد ناقص لدى المنصة", runtime: "خطأ أثناء التشغيل" };
export const channelIssueText = (k: string | null) => (k ? CHANNEL_ISSUE[k] ?? "مشكلة في القناة" : "");
export function channelState(c: NonNullable<Capabilities["channels"]>[number]): { label: string; tone: "ok" | "warn" | "danger" | undefined } {
  if (c.connected) return { label: "متصل", tone: "ok" };
  if (c.linked) return { label: "مربوط · غير متصل الآن", tone: "warn" };
  if (c.configured) return { label: "مهيأ · غير مربوط", tone: "warn" };
  return { label: "غير مربوط", tone: undefined };
}

/** Why a skill is not ready, in one short line (tool / variable names only — never values). */
export function missingText(m: Skill["missing"]): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.bins.length) parts.push(`أداة: ${m.bins.join("، ")}`);
  if (m.env.length) parts.push(`متغير: ${m.env.join("، ")}`);
  if (m.config) parts.push(m.config === 1 ? "إعداد واحد" : `${m.config} إعدادات`);
  if (m.os) parts.push("نظام تشغيل آخر");
  return parts.length ? `ينقصها ${parts.join(" · ")}` : "متطلبات ناقصة";
}

const TOOL_GROUP: Record<string, string> = {
  fs: "الملفات", runtime: "التنفيذ", web: "الويب", memory: "الذاكرة", sessions: "المحادثات والجلسات", ui: "الواجهات والمتصفح", messaging: "الرسائل",
  automation: "الأتمتة والمحرك", nodes: "الأجهزة", agents: "الوكلاء والأهداف", media: "الوسائط", other: "أخرى",
};
export const toolGroupLabel = (id: string, label: string | null) =>
  TOOL_GROUP[id] ?? (id.startsWith("plugin:") ? `إضافة: ${label ?? id.slice(7)}` : label ?? id);

export const MEMORY_STATE: Record<string, { label: string; tone: "ok" | "warn" | "danger" | undefined; hint: string }> = {
  ok: { label: "جاهزة", tone: "ok", hint: "فهرس الذاكرة محدّث ويمكن البحث فيه." },
  stale: { label: "الفهرس قديم", tone: "warn", hint: "بُني الفهرس بإعداد مختلف؛ قد تنقص نتائج البحث حتى يُعاد بناؤه من واجهة OpenClaw." },
  degraded: { label: "تعمل جزئيًا", tone: "warn", hint: "البحث متاح لكن قد تنقص بعض النتائج." },
  disabled: { label: "معطّلة", tone: undefined, hint: "البحث في الذاكرة معطّل في إعدادات باشت." },
  unavailable: { label: "غير متاحة", tone: "danger", hint: "تعذّرت قراءة حالة الذاكرة من المحرك." },
  unknown: { label: "غير معروفة", tone: undefined, hint: "" },
};
