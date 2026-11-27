"use client";
/**
 * B3 — «الموافقات»: BASHT's pending approvals (exec / plugin / system), answered by the owner from the app instead of WhatsApp.
 * Used by the Notifications screen (full panel) and by the chat (inline card for the app conversation, features/chat/approval-inline-card).
 * Allow-once and deny only, each behind a confirmation; a countdown to expiry; honest states when BASHT's link is down.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Empty, ListSkeleton, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import {
  approvalsClient, answerable, ApprovalError, confirmCopy, countdown, DECISION_LABEL, KIND_LABEL, outcomeText, SESSION_LABEL,
  type DecidedApproval, type Decision, type PendingApproval,
} from "@/lib/basht-approvals";
import "./approvals.css";

export type ApprovalsView = "loading" | "ok" | "down" | "locked" | "disabled" | "error";

/** Polls the pending list while the page is visible (paused when hidden: iOS suspends it anyway). */
export function useApprovals(intervalMs: number, enabled = true) {
  const [view, setView] = useState<ApprovalsView>("loading");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState("");
  const gen = useRef(0);
  const refresh = useCallback(async () => {
    const g = ++gen.current;
    try {
      const s = await approvalsClient.list();
      if (g !== gen.current) return;
      setApprovals(s.approvals); setError("");
      setView(s.available ? "ok" : "down");
    } catch (e) {
      if (g !== gen.current) return;
      const code = e instanceof ApprovalError ? e.code : "unavailable";
      setView(code === "unauthorized" ? "locked" : code === "disabled" ? "disabled" : code === "link_down" ? "down" : "error");
      setError(e instanceof Error ? e.message : "");
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") void refresh(); }, intervalMs);
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [enabled, intervalMs, refresh]);
  return { view, approvals, error, refresh };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** One pending approval with its two answers. `onDone` runs after the engine answered (to re-read the list). */
export function ApprovalCard({ a, now, onDone, compact = false, focused = false }: { a: PendingApproval; now: number; onDone: () => void; compact?: boolean; focused?: boolean }) {
  const { confirm, toast } = useDialogs();
  const [busy, setBusy] = useState<Decision | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "center" }); }, [focused]);
  const left = countdown(a.expiresAt, now);
  const decide = async (d: Decision) => {
    if (busy || left.expired) return;
    if (!(await confirm(confirmCopy(a, d)))) return;
    setBusy(d);
    try {
      const r = await approvalsClient.decide(a.id, d);
      toast(outcomeText(r.applied, r.approval?.decision ?? null, d), r.applied ? "ok" : "error");
    } catch (e) {
      toast(e instanceof Error ? e.message : "تعذّر إرسال الرد", "error");
    } finally { setBusy(null); onDone(); }
  };
  return (
    <article ref={ref} className={"card card-pad stack approval-card" + (compact ? " compact" : "") + (focused ? " focused" : "")} aria-label={`طلب موافقة: ${a.summary ?? KIND_LABEL[a.kind]}`} data-approval={a.id}>
      <div className="section-head">
        <span className="approval-head"><Icon name="shield" size={18} /><strong>باشت ينتظر موافقتك</strong></span>
        <span className={"num approval-left" + (left.urgent ? " urgent" : "")} aria-live="off">{left.text}</span>
      </div>
      {a.summary && <code className="approval-cmd" dir="ltr">{a.summary}</code>}
      {a.warning && <Notice tone="warn">{a.warning}</Notice>}
      <span className="task-meta">
        <Badge tone="warn">{KIND_LABEL[a.kind]}</Badge>
        {SESSION_LABEL[a.session] && <span className="muted" style={{ fontSize: 12 }}>{SESSION_LABEL[a.session]}</span>}
      </span>
      <div className="approval-actions">
        {a.decisions.includes("allow-once") && <button className="btn btn-primary" disabled={!!busy || left.expired} onClick={() => void decide("allow-once")}>
          <Icon name="check" size={18} />{busy === "allow-once" ? "يُرسل…" : "سماح مرة واحدة"}</button>}
        {a.decisions.includes("deny") && <button className="btn btn-danger" disabled={!!busy || left.expired} onClick={() => void decide("deny")}>
          <Icon name="close" size={18} />{busy === "deny" ? "يُرسل…" : "رفض"}</button>}
      </div>
    </article>
  );
}

const fmt = (ts: number | null) => (ts ? new Intl.DateTimeFormat("ar-SA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ts) : "");

/** The «الموافقات» section of the Notifications screen. */
export default function ApprovalsPanel({ focus }: { focus?: string | null }) {
  const { view, approvals, error, refresh } = useApprovals(5000);
  const now = useNow(1000);
  const [history, setHistory] = useState<DecidedApproval[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const loadHistory = useCallback(async () => { try { setHistory(await approvalsClient.history()); } catch { setHistory([]); } }, []);
  useEffect(() => { if (showHistory) void loadHistory(); }, [showHistory, loadHistory]);
  const pending = answerable(approvals, now);
  const done = () => { void refresh(); if (showHistory) void loadHistory(); };

  return (
    <section className="stack" aria-label="الموافقات" aria-live="polite">
      <p className="muted" style={{ margin: 0 }}>طلبات تنفيذ ينتظر فيها باشت قرارك قبل أن يكمل. القرار لمرة واحدة فقط، ويُسجَّل.</p>
      {view === "loading" && <ListSkeleton rows={2} h={120} />}
      {view === "down" && <Notice tone="warn" role="status">باشت غير متصل بالمحرك الآن؛ لا يمكن عرض الموافقات أو الرد عليها حتى يعود الاتصال. لم يُتخذ أي قرار نيابةً عنك.</Notice>}
      {view === "locked" && <Notice tone="info" role="status">سجّل الدخول لعرض موافقات باشت.</Notice>}
      {view === "disabled" && <Notice tone="info" role="status">باشت غير مفعّل على الخادم.</Notice>}
      {view === "error" && <Notice tone="warn" role="alert">{error || "تعذّر الوصول إلى باشت الآن."}</Notice>}
      {view === "ok" && (pending.length ? (
        <div className="stack">{pending.map((a) => <ApprovalCard key={a.id} a={a} now={now} onDone={done} focused={a.id === focus} />)}</div>
      ) : (
        <div className="card"><Empty icon="shield" title="لا طلبات تنتظر موافقتك">حين يحتاج باشت إذنك لتنفيذ أمر يظهر الطلب هنا ويصلك إشعار.</Empty></div>
      ))}
      <div>
        <button className="btn btn-sm" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}><Icon name="clock" size={16} />{showHistory ? "إخفاء السجل" : "سجل القرارات"}</button>
      </div>
      {showHistory && (history === null ? <ListSkeleton rows={2} h={48} /> : history.length ? (
        <ul className="stack" aria-label="سجل القرارات">
          {history.map((h) => (
            <li key={h.id} className="notice-item read normal">
              <span className="notice-ico normal"><Icon name={h.decision === "deny" ? "x-circle" : "check-circle"} size={20} /></span>
              <span className="notice-body">
                <span className="notice-title">{h.decision ? DECISION_LABEL[h.decision] ?? h.decision : h.status}{h.by === "system" ? " · تلقائيًا من المحرك" : ""}</span>
                {h.summary && <span className="notice-text" dir="ltr" style={{ textAlign: "start" }}>{h.summary}</span>}
                <span className="muted num" style={{ fontSize: 12 }}>{fmt(h.resolvedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">لا قرارات مسجلة بعد.</p>)}
    </section>
  );
}
