/**
 * What BASHT is doing *right now*, for the shell and Command Center. In memory only (never persisted, never synced).
 * Only real events set it: the chat screen while it waits for / streams a Claude reply, and the outcome of that reply.
 * Nothing here invents progress — when no work is in flight the phase is "idle" and the UI falls back to connection status.
 */
import { useSyncExternalStore } from "react";
import type { AssistantStatus } from "./assistant";

export type AgentPhase = "idle" | "thinking" | "responding" | "done" | "failed" | "stopped";
export type AgentActivity = { phase: AgentPhase; at: number };

const IDLE: AgentActivity = { phase: "idle", at: 0 };
let state: AgentActivity = IDLE;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Outcome phases (done / failed / stopped) are shown briefly, then the agent returns to idle. */
export const SETTLE_MS = 4000;

export function setAgentPhase(phase: AgentPhase, now = Date.now()) {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  state = phase === "idle" ? IDLE : { phase, at: now };
  emit();
  if (phase === "done" || phase === "failed" || phase === "stopped") {
    settleTimer = setTimeout(() => { settleTimer = null; state = IDLE; emit(); }, SETTLE_MS);
  }
}
export const getAgentActivity = () => state;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useAgentActivity = () => useSyncExternalStore(subscribe, getAgentActivity, () => IDLE);

/** The single state the UI shows, derived from real signals only. */
export type AgentState = "connecting" | "offline" | "notes" | "ready" | "thinking" | "responding" | "done" | "failed" | "stopped";

export function agentState(status: AssistantStatus, activity: AgentActivity): AgentState {
  if (activity.phase !== "idle") return activity.phase;
  if (status.server === "checking") return "connecting";
  if (status.server === "offline") return "offline";
  return status.assistant ? "ready" : "notes";
}

export const AGENT_STATE_TEXT: Record<AgentState, { label: string; detail: string; tone: "live" | "ok" | "muted" | "warn" | "danger" }> = {
  connecting: { label: "يتحقق من الاتصال", detail: "يفحص الخادم الآن", tone: "muted" },
  offline: { label: "غير متصل", detail: "تعذّر الوصول إلى الخادم؛ ما على جهازك يعمل كالمعتاد", tone: "warn" },
  notes: { label: "وضع الملاحظات", detail: "الذكاء الاصطناعي غير مفعّل؛ تُحفظ رسائلك وأوامرك محليًا", tone: "muted" },
  ready: { label: "جاهز", detail: "متصل ويعمل بـ Claude", tone: "ok" },
  thinking: { label: "يفكّر", detail: "أُرسل طلبك وينتظر أول رد", tone: "live" },
  responding: { label: "يكتب الرد", detail: "يصل الرد الآن", tone: "live" },
  done: { label: "اكتمل", detail: "وصل الرد كاملًا", tone: "ok" },
  failed: { label: "تعذّر التنفيذ", detail: "لم يكتمل الرد؛ التفاصيل في المحادثة", tone: "danger" },
  stopped: { label: "أُوقف", detail: "أوقفت الرد بناءً على طلبك", tone: "muted" },
};
