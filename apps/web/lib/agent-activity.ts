/**
 * What BASHT is doing *right now*, for the shell and Command Center. In memory only (never persisted, never synced).
 * Only real events set it, and two kinds of outcome are kept apart on purpose:
 *  - a Claude REPLY (text only): thinking → responding → replied | reply_failed | stopped;
 *  - an EXECUTED TASK (something was actually done): task_done | task_failed — set only when a local command really
 *    ran (/مهمة, a reminder) or a browser task card moved from "started" to a finished outcome.
 * When nothing is in flight the phase is "idle" and the UI falls back to connection status.
 */
import { useSyncExternalStore } from "react";
import type { AssistantStatus } from "./assistant";
import type { QuickReply } from "./commands";
import type { BrowserRef } from "./domain";

export type AgentPhase = "idle" | "thinking" | "responding" | "replied" | "reply_failed" | "stopped" | "task_done" | "task_failed";
export type AgentActivity = { phase: AgentPhase; at: number };

const IDLE: AgentActivity = { phase: "idle", at: 0 };
let state: AgentActivity = IDLE;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Outcome phases are shown briefly, then the agent returns to idle. */
export const SETTLE_MS = 4000;
const OUTCOMES: ReadonlySet<AgentPhase> = new Set(["replied", "reply_failed", "stopped", "task_done", "task_failed"]);

export function setAgentPhase(phase: AgentPhase, now = Date.now()) {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  state = phase === "idle" ? IDLE : { phase, at: now };
  emit();
  if (OUTCOMES.has(phase)) settleTimer = setTimeout(() => { settleTimer = null; state = IDLE; emit(); }, SETTLE_MS);
}
export const getAgentActivity = () => state;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useAgentActivity = () => useSyncExternalStore(subscribe, getAgentActivity, () => IDLE);

/** A handled quick command → executed-task outcome. Invalid input (a typo) and offers/questions are not outcomes. */
export function phaseForQuick(q: QuickReply): AgentPhase | null {
  return q.outcome === "executed" ? "task_done" : q.outcome === "failed" ? "task_failed" : null;
}

/** A browser card patch → outcome, only on a real started → done transition (a reopened old card re-reports its outcome). */
export function phaseForBrowser(prev: BrowserRef | undefined, patch: Partial<BrowserRef>): AgentPhase | null {
  if (prev?.state !== "started" || patch.state !== "done") return null;
  return patch.outcome === "succeeded" ? "task_done" : patch.outcome === "failed" ? "task_failed" : patch.outcome === "cancelled" ? "stopped" : null;
}

/** The single state the UI shows, derived from real signals only. */
export type AgentState = "connecting" | "offline" | "notes" | "ready" | Exclude<AgentPhase, "idle">;

export function agentState(status: AssistantStatus, activity: AgentActivity): AgentState {
  if (activity.phase !== "idle") return activity.phase;
  if (status.server === "checking") return "connecting";
  if (status.server === "offline") return "offline";
  return status.assistant ? "ready" : "notes";
}

export const AGENT_STATE_TEXT: Record<AgentState, { label: string; detail: string; tone: "live" | "ok" | "muted" | "warn" | "danger" | "info" }> = {
  connecting: { label: "يتحقق من الاتصال", detail: "يفحص الخادم الآن", tone: "muted" },
  offline: { label: "غير متصل", detail: "تعذّر الوصول إلى الخادم؛ ما على جهازك يعمل كالمعتاد", tone: "warn" },
  notes: { label: "وضع الملاحظات", detail: "الذكاء الاصطناعي غير مفعّل؛ تُحفظ رسائلك وأوامرك محليًا", tone: "muted" },
  ready: { label: "جاهز", detail: "متصل ويعمل بـ Claude", tone: "ok" },
  thinking: { label: "يفكّر", detail: "أُرسل طلبك وينتظر أول رد", tone: "live" },
  responding: { label: "يكتب الرد", detail: "يصل الرد الآن", tone: "live" },
  replied: { label: "اكتمل الرد", detail: "وصل رد Claude كاملًا — رد نصي، لم يُنفَّذ أي إجراء", tone: "info" },
  reply_failed: { label: "تعذّر الرد", detail: "لم يكتمل رد Claude؛ التفاصيل في المحادثة", tone: "danger" },
  stopped: { label: "أُوقف", detail: "أُوقف بناءً على طلبك", tone: "muted" },
  task_done: { label: "نُفّذت المهمة", detail: "اكتمل إجراء تنفيذي فعلًا وسُجّل في النشاط", tone: "ok" },
  task_failed: { label: "تعذّر التنفيذ", detail: "لم يكتمل الإجراء؛ التفاصيل في المحادثة", tone: "danger" },
};
