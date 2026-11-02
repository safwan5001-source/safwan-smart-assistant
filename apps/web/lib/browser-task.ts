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

export type TaskView = {
  id: string; status: TaskStatus; url: string; steps: { id: StepId; status: StepStatus }[]; sessionReleased: boolean;
  createdAt?: number; finishedAt?: number; error?: TaskError;
  result?: { title: string; url: string; excerpt: string; hasScreenshot: boolean };
};

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

/** Rebuilds a TaskView from untrusted JSON (whitelist, bounded). Returns null for anything unexpected. */
export function parseTaskView(raw: unknown): TaskView | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!isTaskId(o.id) || typeof o.status !== "string" || !STATUSES.has(o.status) || !isAllowedBrowserUrl(o.url)) return null;
  const steps = o.steps;
  if (!Array.isArray(steps) || steps.length !== STEP_IDS.length) return null;
  const outSteps: TaskView["steps"] = [];
  for (let i = 0; i < STEP_IDS.length; i++) {
    const s = steps[i] as Record<string, unknown> | null;
    if (!s || s.id !== STEP_IDS[i] || typeof s.status !== "string" || !STEP_STATUSES.has(s.status)) return null;
    outSteps.push({ id: STEP_IDS[i], status: s.status as StepStatus });
  }
  const view: TaskView = { id: o.id, status: o.status as TaskStatus, url: o.url, steps: outSteps, sessionReleased: o.sessionReleased === true };
  for (const k of ["createdAt", "finishedAt"] as const) {
    const n = o[k];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n < 1e14) view[k] = n;
  }
  if (o.error !== undefined && o.error !== null) view.error = (typeof o.error === "string" && ERRORS.has(o.error) ? o.error : "browser_execution_failed") as TaskError;
  if (o.result !== undefined && o.result !== null) {
    const r = o.result as Record<string, unknown>;
    if (typeof r !== "object" || typeof r.url !== "string" || !RESULT_URL.test(r.url)) return null;
    view.result = { title: cleanText(r.title, 200), url: r.url, excerpt: cleanText(r.excerpt, 4000), hasScreenshot: r.hasScreenshot === true };
  }
  return view;
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

// ── the `/متصفح` quick command ─────────────────────────────────────────────────────────────────
export type BrowseCommand =
  | { kind: "offer"; url: string }                    // show a card; nothing runs until the user presses «تشغيل»
  | { kind: "blocked"; reason: string };              // refused with an explanation, nothing is sent anywhere

const BROWSE_NAME = /^\/(متصفح|browse)(?:\s+([\s\S]*))?$/i;
// Anything that asks the browser to DO something (not just read) needs a capability and an explicit approval flow that do not exist yet.
const ACTION_WORDS = /(انقر|اضغط|سجل|سجّل|دخول|ادخل|اكتب|املأ|عبئ|أرسل|ارسل|ادفع|دفع|اشتر|احذف|حذف|حمّل|حمل|نزّل|نزل|click|type|fill|login|log in|sign in|submit|send|pay|buy|purchase|delete|remove|download|upload|post)/i;

export function parseBrowseCommand(text: string): BrowseCommand | null {
  const m = BROWSE_NAME.exec(text.trim());
  if (!m) return null;
  const arg = (m[2] ?? "").trim();
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
