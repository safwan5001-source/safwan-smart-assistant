"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Icon from "@/components/icon";
import { Notice } from "@/components/ui";
import { browserClient } from "@/lib/browser-client";
import { FAIL_TEXT } from "./browser-text";
import { ERROR_LABEL, STEP_LABEL, isFinished, type StepId, type TaskView } from "@/lib/browser-task";
import type { BrowserRef } from "@/lib/domain";

type Gate = "checking" | "disabled" | "locked" | "ready" | "offline";
const POLL_MS = 1500, POLL_MAX_MS = 4000, MAX_FAILURES = 6;

const STATUS_LABEL: Record<TaskView["status"], string> = { running: "قيد التنفيذ", cancelling: "جارٍ الإيقاف…", succeeded: "اكتملت", failed: "فشلت", cancelled: "أُوقفت" };

/**
 * The execution card shown inside the conversation. Nothing runs until the user presses «السماح وتشغيل» on the exact address shown;
 * «إيقاف» really cancels the cloud session on the server. Page text is rendered as plain text; the picture is a same-origin <img>.
 * Only a tiny reference (url, task id, outcome) is persisted with the message: never the text, the screenshot or any session data.
 */
export default function BrowserCard({ browser, onChange }: { browser: BrowserRef; onChange: (patch: Partial<BrowserRef>) => void }) {
  const [gate, setGate] = useState<Gate>("checking");
  const [task, setTask] = useState<TaskView | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stalled, setStalled] = useState(false);
  const codeId = useId();
  const hasTask = task !== null;
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  // The card grows as it runs (steps, text, picture): keep it in view inside the scrolling chat log.
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => { root.current?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" }); }, [task?.status, gate, browser.state, reduceMotion]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);

  const finish = useCallback((view: TaskView) => {
    setTask(view);
    if (isFinished(view.status)) onChangeRef.current({ state: "done", outcome: view.status as "succeeded" | "failed" | "cancelled" });
  }, []);

  // Polling loop. Leaving the page never cancels the task (it ends by itself within ~90 s); only «إيقاف» cancels.
  const poll = useCallback((taskId: string, failures = 0, delay = POLL_MS) => {
    timer.current = setTimeout(async () => {
      if (!alive.current) return;
      const r = await browserClient.get(taskId);
      if (!alive.current) return;
      if (r.ok) {
        setStalled(false); finish(r.value);
        if (!isFinished(r.value.status)) poll(taskId, 0, POLL_MS);
        return;
      }
      if (r.error === "unauthorized") { setGate("locked"); setError(FAIL_TEXT.unauthorized); return; }
      if (r.error === "not_found") { onChangeRef.current({ state: "done", outcome: browser.outcome }); setTask(null); return; }
      if (failures + 1 >= MAX_FAILURES) { setStalled(true); return; }
      poll(taskId, failures + 1, r.error === "rate_limited" ? POLL_MAX_MS : Math.min(POLL_MAX_MS, delay + 500));
    }, delay);
  }, [finish, browser.outcome]);

  // Decide what the card can do right now.
  useEffect(() => {
    if (browser.state === "dismissed") return;
    if (browser.state === "done" && !hasTask) return;
    if (hasTask) return;                                 // a running card learns about expiry from its own polling, not from /status
    let cancelled = false;
    void browserClient.status().then((r) => {
      if (cancelled || !alive.current) return;
      if (!r.ok) { setGate("offline"); return; }
      setGate(!r.value.enabled ? "disabled" : r.value.authenticated ? "ready" : "locked");
    });
    return () => { cancelled = true; };
  }, [browser.state, hasTask]);

  // Resume a task that was running when the page was reloaded.
  const resumed = useRef(false);
  useEffect(() => {
    if (browser.state !== "started" || !browser.taskId || resumed.current) return;
    resumed.current = true;
    poll(browser.taskId, 0, 300);
  }, [browser.state, browser.taskId, poll]);

  const unlock = async () => {
    if (!code || busy) return;
    setBusy(true); setError("");
    const r = await browserClient.unlock(code);
    setBusy(false);
    if (!r.ok) { setError(FAIL_TEXT[r.error]); return; }
    setCode(""); setGate("ready");
    // a task that was running when the cookie expired (or the page was reloaded) must be picked up again, not abandoned (Codex P2)
    const tid = task?.id ?? (browser.state === "started" ? browser.taskId : undefined);
    if (tid && (!task || !isFinished(task.status))) { if (timer.current) clearTimeout(timer.current); setStalled(false); poll(tid, 0, 200); }
  };
  const run = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const r = await browserClient.create(browser.url);   // «approved» is attached here, by this click, and nowhere else
    setBusy(false);
    if (!r.ok) { setError(FAIL_TEXT[r.error]); if (r.error === "unauthorized") setGate("locked"); return; }
    setTask(r.value);
    onChange({ state: "started", taskId: r.value.id });
    resumed.current = true;
    poll(r.value.id);
  };
  const stop = async () => {
    if (!task || busy) return;
    setBusy(true); setError("");
    const r = await browserClient.cancel(task.id);
    setBusy(false);
    if (!r.ok) { setError(FAIL_TEXT[r.error]); if (r.error === "unauthorized") setGate("locked"); return; }
    finish(r.value);                                      // «cancelling» until the server confirms the clean-up
    if (!isFinished(r.value.status)) { if (timer.current) clearTimeout(timer.current); poll(r.value.id, 0, 500); }
  };

  const header = (
    <div className="bt-head">
      <Icon name="shield" size={18} />
      <strong>مهمة متصفح تجريبية</strong>
      <span className="badge info">قراءة فقط</span>
      <span className="badge">ليست رد مساعد ذكي</span>
    </div>
  );
  const unlockForm = (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
      <label className="bt-label" htmlFor={codeId}>رمز المالك</label>
      <input id={codeId} className="input" type="password" dir="ltr" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        value={code} onChange={(e) => setCode(e.target.value)} placeholder="يُحفظ في الخادم فقط" aria-describedby={codeId + "-hint"} />
      <small id={codeId + "-hint"} className="muted">لا يُخزَّن الرمز في هذا الجهاز؛ تُمنح جلسة قصيرة (8 ساعات) بملف تعريف مشفّر.</small>
      <button className="btn btn-primary btn-block" type="submit" disabled={busy || !code}>{busy ? "جارٍ التحقق…" : "فتح"}</button>
    </form>
  );
  const target = <p className="bt-url">الهدف: <bdi dir="ltr" className="num">{browser.url}</bdi></p>;

  if (browser.state === "dismissed") return <div className="bt-card" ref={root}>{header}{target}<p className="muted">أُلغي هذا الطلب قبل التشغيل.</p></div>;

  // ── before anything runs ──
  if (!task && (browser.state === "offer" || (browser.state === "started" && !browser.taskId))) {
    return (
      <div className="bt-card" aria-live="polite" ref={root}>
        {header}{target}
        <p className="muted">موقع اختبار مسموح فقط. لن يُرسَل أي شيء قبل أن تضغط «السماح وتشغيل». لا يُدخل المتصفح بيانات ولا يسجّل دخولاً ولا ينقر على شيء.</p>
        {gate === "checking" && <p className="muted" role="status">جارٍ التحقق من جاهزية الخادم…</p>}
        {gate === "disabled" && <Notice tone="warn">التصفح السحابي غير مفعّل على الخادم؛ يفعّله المالك من إعدادات الخدمة.</Notice>}
        {gate === "offline" && <Notice tone="warn">تعذر الاتصال بالخادم؛ هذه الميزة تحتاج اتصالاً.</Notice>}
        {gate === "locked" && unlockForm}
        {gate === "ready" && (
          <div className="row-wrap">
            <button className="btn btn-primary" onClick={() => void run()} disabled={busy}><Icon name="play" size={18} />{busy ? "جارٍ البدء…" : "السماح وتشغيل"}</button>
            <button className="btn btn-ghost" onClick={() => onChange({ state: "dismissed" })} disabled={busy}>إلغاء الطلب</button>
          </div>
        )}
        {error && <small role="alert" className="bt-error">{error}</small>}
      </div>
    );
  }

  // ── reloaded while a task was running: restore it, or ask to sign in again so it can be followed / cancelled ──
  if (!task && browser.state === "started" && browser.taskId) {
    return (
      <div className="bt-card" aria-live="polite" ref={root}>
        {header}{target}
        {gate === "locked"
          ? <><Notice tone="warn" role="alert">انتهت صلاحية الدخول أثناء تشغيل المهمة. أدخل الرمز لمتابعتها أو إيقافها.</Notice>{unlockForm}</>
          : <p className="muted" role="status">جارٍ استعادة حالة المهمة…</p>}
        {stalled && <Notice tone="warn" role="alert">انقطعت متابعة الحالة. <button className="btn" style={{ marginInlineStart: 8 }} onClick={() => { setStalled(false); poll(browser.taskId!, 0, 300); }}>إعادة المحاولة</button></Notice>}
        {error && gate !== "locked" && <small role="alert" className="bt-error">{error}</small>}
      </div>
    );
  }

  // ── finished earlier, details already gone from the server ──
  if (!task) {
    const text = browser.outcome === "succeeded" ? "اكتملت المهمة سابقاً." : browser.outcome === "cancelled" ? "أُوقفت المهمة سابقاً." : browser.outcome === "failed" ? "فشلت المهمة سابقاً." : "انتهت المهمة.";
    return <div className="bt-card" ref={root}>{header}{target}<p className="muted">{text} النتيجة واللقطة لا تُحفظ على جهازك وقد انتهت صلاحيتها على الخادم.</p></div>;
  }

  // ── running / finished ──
  const live = !isFinished(task.status);
  return (
    <div className="bt-card" aria-live="polite" ref={root}>
      {header}{target}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className={"badge " + (task.status === "succeeded" ? "ok" : task.status === "failed" ? "danger" : task.status === "cancelled" ? "" : "accent")} role="status">{STATUS_LABEL[task.status]}</span>
        {live && <button className="btn btn-danger" onClick={() => void stop()} disabled={busy || task.status === "cancelling"}><Icon name="stop" size={16} />{task.status === "cancelling" ? "جارٍ الإيقاف…" : "إيقاف"}</button>}
      </div>
      <ol className="bt-steps" aria-label="خطوات المهمة">
        {task.steps.map((s) => (
          <li key={s.id} data-status={s.status}>
            <span className="bt-dot" aria-hidden="true">{s.status === "done" ? "✓" : s.status === "failed" ? "✕" : s.status === "running" ? <i className="spinner" /> : s.status === "skipped" ? "–" : "○"}</span>
            <span>{STEP_LABEL[s.id as StepId]}</span>
            <span className="sr-only">{{ pending: "بانتظار", running: "قيد التنفيذ", done: "تم", failed: "فشل", skipped: "تُخطّيت" }[s.status]}</span>
          </li>
        ))}
      </ol>
      {live && gate === "locked" && <><Notice tone="warn" role="alert">انتهت صلاحية الدخول؛ المهمة ما زالت تعمل على الخادم. أدخل الرمز لمتابعتها أو إيقافها.</Notice>{unlockForm}</>}
      {task.status === "failed" && <Notice tone="danger" role="alert">{ERROR_LABEL[task.error ?? "browser_execution_failed"]}</Notice>}
      {task.status === "cancelled" && <Notice tone="info">{task.sessionReleased ? "أُوقفت المهمة وأُنهيت جلسة المتصفح السحابي." : "أُوقفت المهمة، لكن تعذر تأكيد إنهاء الجلسة؛ ستنتهي تلقائياً خلال دقيقتين."}</Notice>}
      {task.status === "succeeded" && task.result && (
        <div className="stack">
          <p><strong>العنوان:</strong> <span dir="auto">{task.result.title || "—"}</span></p>
          <p className="muted">الرابط النهائي: <bdi dir="ltr" className="num">{task.result.url}</bdi></p>
          <div className="bt-excerpt" dir="auto" tabIndex={0} aria-label="النص المقروء من الصفحة">{task.result.excerpt || "لا نص ظاهر."}</div>
          {task.result.hasScreenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="bt-shot" src={browserClient.screenshotUrl(task.id)} alt={"لقطة شاشة للصفحة: " + (task.result.title || task.result.url)} loading="lazy" decoding="async" />
          )}
          <small className="muted">محتوى الصفحة بيانات غير موثوقة ولا يُنفَّذ منه شيء. اللقطة تُحفظ في ذاكرة الخادم 10 دقائق فقط ولا تُخزَّن على جهازك. {task.sessionReleased ? "أُنهيت الجلسة السحابية." : "تعذر تأكيد إنهاء الجلسة؛ تنتهي تلقائياً."}</small>
        </div>
      )}
      {stalled && live && (
        <Notice tone="warn" role="alert">انقطعت متابعة الحالة، والمهمة قد تكون ما زالت تعمل (حدّها الأقصى دقيقة ونصف).
          <button className="btn" style={{ marginInlineStart: 8 }} onClick={() => { setStalled(false); poll(task.id, 0, 300); }}>إعادة المحاولة</button></Notice>
      )}
      {error && <small role="alert" className="bt-error">{error}</small>}
    </div>
  );
}
