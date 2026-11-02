"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Icon from "@/components/icon";
import { Notice } from "@/components/ui";
import { browserClient } from "@/lib/browser-client";
import {
  ACTION_ERROR_LABEL, ACTION_STATUS_LABEL, APPROVAL_KIND_LABEL, END_LABEL, ERROR_LABEL, ROLES, ROLE_LABEL, SESSION_STEP_LABEL, isFinished, parseActionRequest,
  type ActionRequest, type Locator, type Role, type SessionStepId, type TaskView,
} from "@/lib/browser-task";
import type { BrowserRef } from "@/lib/domain";
import { FAIL_TEXT } from "./browser-text";

type Gate = "checking" | "disabled" | "off" | "same_site" | "locked" | "ready" | "offline";
type Tool = "navigate" | "click" | "type" | "observe";
type Kind = Role | "label" | "placeholder" | "text";
const POLL_FAST = 450, POLL_MS = 1000, POLL_MAX_MS = 4000, MAX_FAILURES = 6;
const ACTION_EVENT = "safwan:browser-action";
const TOOL_LABEL: Record<Tool, string> = { navigate: "انتقال", click: "نقر", type: "كتابة", observe: "قراءة" };
const KIND_LABEL: Record<Kind, string> = { ...ROLE_LABEL, label: "عنصر بعنوان", placeholder: "حقل بنص إرشادي", text: "عنصر بنصه" };
const KINDS: Kind[] = [...ROLES, "label", "placeholder", "text"];
const STATUS_BADGE: Record<TaskView["status"], string> = { running: "accent", cancelling: "warn", succeeded: "ok", failed: "danger", cancelled: "" };
const STATUS_LABEL: Record<TaskView["status"], string> = { running: "نشطة", cancelling: "جارٍ الإيقاف…", succeeded: "انتهت", failed: "فشلت", cancelled: "أُوقفت" };
const ACTION_TONE: Record<string, string> = { done: "ok", failed: "danger", denied: "danger", rejected: "warn", cancelled: "", awaiting_approval: "warn", running: "accent", queued: "" };

export type SessionActionEvent = { messageId: string; action: ActionRequest };
export const dispatchSessionAction = (detail: SessionActionEvent) => window.dispatchEvent(new CustomEvent<SessionActionEvent>(ACTION_EVENT, { detail }));

const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const locator = (kind: Kind, value: string): Locator => (kind === "label" || kind === "placeholder" || kind === "text" ? { by: kind, value } : { by: "role", role: kind, value });

/**
 * Interactive browser session card (CHAT-BROWSER-2). Nothing starts until the owner presses «السماح وبدء الجلسة». Afterwards the owner sends ONE
 * structured command at a time (from this card, or typed in the chat as «/انقر …»); the server verifies the element before touching it and holds
 * anything that could change data until the owner presses «موافقة» for that exact step. «إيقاف» really cancels the cloud session.
 * Only a tiny reference (task id, outcome) is stored locally: never the page text, screenshots, typed text or session data.
 */
export default function BrowserSessionCard({ browser, messageId, onChange }: { browser: BrowserRef; messageId: string; onChange: (patch: Partial<BrowserRef>) => void }) {
  const [gate, setGate] = useState<Gate>("checking");
  const [startUrl, setStartUrl] = useState("");
  const [task, setTask] = useState<TaskView | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stalled, setStalled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tool, setTool] = useState<Tool>("click");
  const [kind, setKind] = useState<Kind>("button");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const ids = useId();
  const hasTask = task !== null;
  const root = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskRef = useRef<TaskView | null>(null);
  const busyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; taskRef.current = task; busyRef.current = busy; });
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  useEffect(() => { root.current?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" }); }, [task?.status, task?.pending?.seq, gate, browser.state, reduceMotion]);
  useEffect(() => { if (task?.pending) approvalRef.current?.focus({ preventScroll: true }); }, [task?.pending?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = !!task && !isFinished(task.status);
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);

  const finish = useCallback((view: TaskView) => {
    setTask(view);
    if (isFinished(view.status)) onChangeRef.current({ state: "done", outcome: view.status as "succeeded" | "failed" | "cancelled" });
  }, []);

  const poll = useCallback((taskId: string, failures = 0, delay = POLL_MS) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!alive.current) return;
      const r = await browserClient.get(taskId);
      if (!alive.current) return;
      if (r.ok) {
        setStalled(false); finish(r.value);
        if (!isFinished(r.value.status)) {
          const working = r.value.actions?.some((a) => a.status === "queued" || a.status === "running");
          poll(taskId, 0, working || !r.value.ready ? POLL_FAST : POLL_MS);
        }
        return;
      }
      if (r.error === "unauthorized") { setGate("locked"); setError(FAIL_TEXT.unauthorized); return; }
      if (r.error === "not_found") { onChangeRef.current({ state: "done", outcome: browser.outcome }); setTask(null); return; }
      if (failures + 1 >= MAX_FAILURES) { setStalled(true); return; }
      poll(taskId, failures + 1, r.error === "rate_limited" ? POLL_MAX_MS : Math.min(POLL_MAX_MS, delay + 500));
    }, delay);
  }, [finish, browser.outcome]);

  useEffect(() => {
    if (browser.state === "dismissed" || (browser.state === "done" && !hasTask) || hasTask) return;
    let cancelled = false;
    void browserClient.status().then((r) => {
      if (cancelled || !alive.current) return;
      if (!r.ok) { setGate("offline"); return; }
      if (!r.value.enabled) { setGate("disabled"); return; }
      if (!r.value.interactive.enabled) { setGate(r.value.interactive.reason === "same_site" ? "same_site" : "off"); return; }
      setStartUrl(r.value.interactive.startUrl ?? "");
      setGate(r.value.authenticated ? "ready" : "locked");
    });
    return () => { cancelled = true; };
  }, [browser.state, hasTask]);

  const resumed = useRef(false);
  useEffect(() => {
    if (browser.state !== "started" || !browser.taskId || resumed.current) return;
    resumed.current = true;
    poll(browser.taskId, 0, 300);
  }, [browser.state, browser.taskId, poll]);

  const fail = (e: keyof typeof FAIL_TEXT) => { setError(FAIL_TEXT[e]); if (e === "unauthorized") setGate("locked"); };
  const unlock = async () => {
    if (!code || busy) return;
    setBusy(true); setError("");
    const r = await browserClient.unlock(code);
    setBusy(false);
    if (!r.ok) { setError(FAIL_TEXT[r.error]); return; }
    setCode(""); setGate("ready");
    const tid = task?.id ?? (browser.state === "started" ? browser.taskId : undefined);
    if (tid && (!task || !isFinished(task.status))) { setStalled(false); poll(tid, 0, 200); }
  };
  const start = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const r = await browserClient.createSession();       // «approved» is attached here, by this click, and nowhere else
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setTask(r.value);
    onChange({ state: "started", taskId: r.value.id });
    resumed.current = true;
    poll(r.value.id, 0, POLL_FAST);
  };
  const stop = async () => {
    const t = taskRef.current;
    if (!t || busyRef.current) return;
    setBusy(true); setError("");
    const r = await browserClient.cancel(t.id);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    finish(r.value);
    if (!isFinished(r.value.status)) poll(r.value.id, 0, 400);
  };
  const end = async () => {
    const t = taskRef.current;
    if (!t || busyRef.current) return;
    setBusy(true); setError("");
    const r = await browserClient.finish(t.id);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    finish(r.value); poll(r.value.id, 0, 400);
  };
  const submit = useCallback(async (action: ActionRequest) => {
    const t = taskRef.current;
    if (!t || busyRef.current) return;
    setBusy(true); setError("");
    const r = await browserClient.act(t.id, action);
    setBusy(false);
    if (!r.ok) { if (r.error === "unauthorized") setGate("locked"); setError(FAIL_TEXT[r.error]); return; }
    setTask(r.value); poll(r.value.id, 0, POLL_FAST);
  }, [poll]);
  const decide = async (seq: number, approve: boolean) => {
    const t = taskRef.current;
    if (!t || busyRef.current) return;
    setBusy(true); setError("");
    const r = await browserClient.decide(t.id, seq, approve);    // the ONLY way a state-changing step runs: this click, for this step
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setTask(r.value); poll(r.value.id, 0, POLL_FAST);
  };

  // «/انقر …» typed in the chat arrives here, but only for the card it was addressed to; it goes through the very same submit().
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<SessionActionEvent>).detail;
      if (!d || d.messageId !== messageId) return;
      if (!taskRef.current || isFinished(taskRef.current.status)) { setError("لا توجد جلسة نشطة في هذه البطاقة."); return; }
      if (taskRef.current.pending) { setError("هناك خطوة تنتظر موافقتك أولاً."); return; }
      void submit(d.action);
    };
    window.addEventListener(ACTION_EVENT, handler);
    return () => window.removeEventListener(ACTION_EVENT, handler);
  }, [messageId, submit]);

  const send = () => {
    let raw: unknown;
    if (tool === "observe") raw = { tool: "observe" };
    else if (tool === "navigate") raw = { tool: "navigate", url: url.trim() || startUrl };
    else if (tool === "click") raw = { tool: "click", target: locator(kind, name.trim()) };
    else raw = { tool: "type", target: locator(kind, name.trim()), text };
    const action = parseActionRequest(raw, (u) => /^https:\/\//.test(u));
    if (!action) { setError(FAIL_TEXT.bad_request); return; }
    void submit(action);
    if (tool === "type") setText("");                      // the typed text is not kept in this component after it is sent
  };

  const header = (
    <div className="bt-head">
      <Icon name="shield" size={18} />
      <strong>جلسة متصفح تفاعلية</strong>
      <span className="badge info">اختبار فقط</span>
      <span className="badge">ليست رد مساعد ذكي</span>
    </div>
  );
  const unlockForm = (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
      <label className="bt-label" htmlFor={ids + "-code"}>رمز المالك</label>
      <input id={ids + "-code"} className="input" type="password" dir="ltr" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        value={code} onChange={(e) => setCode(e.target.value)} placeholder="يُحفظ في الخادم فقط" />
      <button className="btn btn-primary btn-block" type="submit" disabled={busy || !code}>{busy ? "جارٍ التحقق…" : "فتح"}</button>
    </form>
  );

  if (browser.state === "dismissed") return <div className="bt-card" ref={root}>{header}<p className="muted">أُلغي هذا الطلب قبل التشغيل.</p></div>;

  // ── before anything runs ──
  if (!task && (browser.state === "offer" || (browser.state === "started" && !browser.taskId))) {
    return (
      <div className="bt-card" aria-live="polite" ref={root}>
        {header}
        <ul className="bt-rules">
          <li>تنتقل وتنقر وتكتب <strong>داخل صفحة المختبر فقط</strong>؛ أي صفحة أخرى للقراءة.</li>
          <li>كل زر قد يغيّر بيانات أو يرسل نموذجاً <strong>يتوقف حتى توافق أنت</strong> على تلك الخطوة.</li>
          <li>محظور دائماً: الدفع، الحذف، تسجيل الدخول والحسابات الحقيقية، كلمات المرور والبطاقات، رفع الملفات.</li>
          <li>الحدود: 20 خطوة، 5 دقائق، وتنتهي عند الخمول. «إيقاف» يُنهي الجلسة السحابية فعلاً.</li>
        </ul>
        {gate === "checking" && <p className="muted" role="status">جارٍ التحقق من جاهزية الخادم…</p>}
        {gate === "disabled" && <Notice tone="warn">التصفح السحابي غير مفعّل على الخادم؛ يفعّله المالك من إعدادات الخدمة.</Notice>}
        {gate === "same_site" && <Notice tone="danger">رُفض التحكم التفاعلي: نطاق المختبر يشترك مع تطبيق المساعد (أو واجهته) في الموقع نفسه. يجب أن يكون المختبر على نطاق مستقل تمامًا.</Notice>}
        {gate === "off" && <Notice tone="warn">التحكم التفاعلي غير مفعّل: لم تُحدَّد صفحة مختبر على الخادم (يقررها المالك).</Notice>}
        {gate === "offline" && <Notice tone="warn">تعذر الاتصال بالخادم؛ هذه الميزة تحتاج اتصالاً.</Notice>}
        {gate === "locked" && unlockForm}
        {gate === "ready" && (
          <div className="row-wrap">
            <button className="btn btn-primary" onClick={() => void start()} disabled={busy}><Icon name="play" size={18} />{busy ? "جارٍ البدء…" : "السماح وبدء الجلسة"}</button>
            <button className="btn btn-ghost" onClick={() => onChange({ state: "dismissed" })} disabled={busy}>إلغاء الطلب</button>
          </div>
        )}
        {error && <small role="alert" className="bt-error">{error}</small>}
      </div>
    );
  }

  if (!task && browser.state === "started" && browser.taskId) {
    return (
      <div className="bt-card" aria-live="polite" ref={root}>
        {header}
        {gate === "locked"
          ? <><Notice tone="warn" role="alert">انتهت صلاحية الدخول أثناء تشغيل الجلسة. أدخل الرمز لمتابعتها أو إيقافها.</Notice>{unlockForm}</>
          : <p className="muted" role="status">جارٍ استعادة حالة الجلسة…</p>}
        {stalled && <Notice tone="warn" role="alert">انقطعت متابعة الحالة. <button className="btn" style={{ marginInlineStart: 8 }} onClick={() => { setStalled(false); poll(browser.taskId!, 0, 300); }}>إعادة المحاولة</button></Notice>}
        {error && gate !== "locked" && <small role="alert" className="bt-error">{error}</small>}
      </div>
    );
  }

  if (!task) {
    const t = browser.outcome === "succeeded" ? "انتهت الجلسة سابقاً." : browser.outcome === "cancelled" ? "أُوقفت الجلسة سابقاً." : browser.outcome === "failed" ? "فشلت الجلسة سابقاً." : "انتهت الجلسة.";
    return <div className="bt-card" ref={root}>{header}<p className="muted">{t} الصفحة واللقطات لا تُحفظ على جهازك وقد انتهت صلاحيتها على الخادم.</p></div>;
  }

  // ── a live or finished session ──
  const remaining = task.deadlineAt ? task.deadlineAt - now : null;
  const used = task.actions?.length ?? 0, max = task.limits?.maxActions ?? 20;
  const canSend = live && task.ready === true && !task.pending && !busy && !task.actions?.some((a) => a.status === "queued" || a.status === "running");
  const log = task.actions ?? [];
  return (
    <div className="bt-card bt-session" aria-live="polite" ref={root}>
      {header}
      <div className="bt-bar">
        <span className={"badge " + STATUS_BADGE[task.status]} role="status">{STATUS_LABEL[task.status]}</span>
        {live && remaining !== null && <span className="badge" title="الوقت المتبقي">⏱ <bdi dir="ltr" className="num">{clock(remaining)}</bdi></span>}
        <span className="badge" title="الخطوات المستخدمة">الخطوات <bdi dir="ltr" className="num">{used}/{max}</bdi></span>
        {(task.blockedRequests ?? 0) > 0 && <span className="badge warn" title="طلبات حُجبت لأنها خارج النطاق المسموح">حُجب <bdi dir="ltr" className="num">{task.blockedRequests}</bdi></span>}
      </div>
      {live && (
        <div className="row-wrap bt-controls">
          <button className="btn btn-danger" onClick={() => void stop()} disabled={busy || task.status === "cancelling"}><Icon name="stop" size={16} />{task.status === "cancelling" ? "جارٍ الإيقاف…" : "إيقاف"}</button>
          <button className="btn" onClick={() => void end()} disabled={busy || task.status === "cancelling"}>إنهاء الجلسة</button>
        </div>
      )}
      <ol className="bt-steps" aria-label="مراحل الجلسة">
        {task.steps.map((s) => (
          <li key={s.id} data-status={s.status}>
            <span className="bt-dot" aria-hidden="true">{s.status === "done" ? "✓" : s.status === "failed" ? "✕" : s.status === "running" ? <i className="spinner" /> : s.status === "skipped" ? "–" : "○"}</span>
            <span>{SESSION_STEP_LABEL[s.id as SessionStepId]}</span>
            <span className="sr-only">{{ pending: "بانتظار", running: "قيد التنفيذ", done: "تم", failed: "فشل", skipped: "تُخطّيت" }[s.status]}</span>
          </li>
        ))}
      </ol>
      {live && gate === "locked" && <><Notice tone="warn" role="alert">انتهت صلاحية الدخول؛ الجلسة ما زالت تعمل على الخادم. أدخل الرمز لمتابعتها أو إيقافها.</Notice>{unlockForm}</>}

      {task.result && (
        <div className="stack">
          {task.result.hasScreenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="bt-shot" src={browserClient.screenshotUrl(task.id, task.result.version)} alt={"لقطة شاشة للصفحة: " + (task.result.title || task.result.url)} decoding="async" />
          )}
          <p><strong>الصفحة:</strong> <span dir="auto">{task.result.title || "—"}</span></p>
          <p className="muted"><bdi dir="ltr" className="num">{task.result.url}</bdi></p>
          <details className="bt-more"><summary>النص المقروء من الصفحة</summary>
            <div className="bt-excerpt" dir="auto" tabIndex={0} aria-label="النص المقروء من الصفحة">{task.result.excerpt || "لا نص ظاهر."}</div>
            <small className="muted">محتوى الصفحة بيانات غير موثوقة ولا يُنفَّذ منه شيء.</small>
          </details>
        </div>
      )}

      {task.pending && live && (
        <div className="bt-approval" role="alertdialog" aria-labelledby={ids + "-ap"} aria-describedby={ids + "-apd"} tabIndex={-1} ref={approvalRef}>
          <strong id={ids + "-ap"}>تنتظر موافقتك — الخطوة {task.pending.seq}</strong>
          <p id={ids + "-apd"} dir="auto">{task.pending.summary}</p>
          {task.pending.fields && task.pending.fields.length > 0 && (
            <div className="bt-fields-list" aria-label="البيانات التي سيُرسلها النموذج">
              <strong>البيانات التي سيُرسلها النموذج:</strong>
              <ul>{task.pending.fields.map((f, i) => <li key={i} dir="auto"><bdi dir="ltr" className="num">{f.name}</bdi> = <span>{f.value || "—"}</span></li>)}</ul>
            </div>
          )}
          {task.pending.element && (
            <p className="bt-el" dir="auto">العنصر الفعلي في الصفحة: <strong>«{task.pending.element.text || "بلا نص"}»</strong> <small className="muted">({task.pending.element.role || task.pending.element.tag})</small></p>
          )}
          <p className="muted">{APPROVAL_KIND_LABEL[task.pending.kind]}{task.pending.submitsTo && <> الوجهة: <bdi dir="ltr" className="num">{task.pending.method ? task.pending.method + " " : ""}{task.pending.submitsTo}</bdi></>} لن يُسمح إلا بهذا الطلب: أي طلب آخر تُحاول الصفحة إرساله يُحجب.</p>
          {task.pending.expiresAt && <small className="muted">تُرفض تلقائياً بعد <bdi dir="ltr" className="num">{clock(task.pending.expiresAt - now)}</bdi> إن لم تقرر.</small>}
          <div className="row-wrap">
            <button className="btn btn-primary" onClick={() => void decide(task.pending!.seq, true)} disabled={busy}>موافقة</button>
            <button className="btn" onClick={() => void decide(task.pending!.seq, false)} disabled={busy}>رفض</button>
            <button className="btn btn-danger" onClick={() => void stop()} disabled={busy || task.status === "cancelling"}><Icon name="stop" size={16} />إيقاف الجلسة</button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <ol className="bt-log" aria-label="سجل الخطوات">
          {log.map((a) => (
            <li key={a.seq} data-status={a.status}>
              <span className={"badge " + (ACTION_TONE[a.status] ?? "")}>{ACTION_STATUS_LABEL[a.status]}</span>
              <span dir="auto" className="bt-log-text">{a.summary}{a.error ? <small className="bt-log-err"> — {ACTION_ERROR_LABEL[a.error]}</small> : null}</span>
            </li>
          ))}
        </ol>
      )}

      {live && task.ready && (
        <form className="bt-composer" onSubmit={(e) => { e.preventDefault(); if (canSend) send(); }} aria-label="إرسال أمر للمتصفح">
          <div className="bt-tools" role="tablist" aria-label="نوع الأمر">
            {(Object.keys(TOOL_LABEL) as Tool[]).map((t) => (
              <button type="button" role="tab" key={t} aria-selected={tool === t} className={"bt-tool" + (tool === t ? " on" : "")} onClick={() => setTool(t)}>{TOOL_LABEL[t]}</button>
            ))}
          </div>
          {tool === "navigate" && (
            <input className="input" type="url" inputMode="url" dir="ltr" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="عنوان الصفحة"
              value={url} onChange={(e) => setUrl(e.target.value)} placeholder={startUrl || "https://…"} />
          )}
          {(tool === "click" || tool === "type") && (
            <div className="bt-fields">
              <select className="select" aria-label="نوع العنصر" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
              <input className="input" aria-label="اسم العنصر" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="اسم العنصر كما يظهر" autoComplete="off" />
            </div>
          )}
          {tool === "type" && (
            <input className="input" aria-label="النص المراد كتابته" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="النص (بيانات اختبار فقط)" autoComplete="off" autoCapitalize="off" />
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={!canSend || (tool !== "observe" && tool !== "navigate" && !name.trim())}>
            {busy ? "جارٍ الإرسال…" : task.pending ? "بانتظار قرارك" : "إرسال الأمر"}
          </button>
          <small className="muted">أو اكتب في المحادثة: <bdi dir="auto">{'/انقر زر "الاسم"'}</bdi> · <bdi dir="auto">{'/اكتب "النص" في حقل "الاسم"'}</bdi> · <bdi dir="auto">/افتح https://…</bdi> · <bdi dir="auto">/اقرأ</bdi></small>
        </form>
      )}

      {task.status === "failed" && <Notice tone="danger" role="alert">{ERROR_LABEL[task.error ?? "browser_execution_failed"]}</Notice>}
      {task.status === "cancelled" && <Notice tone="info">{task.sessionReleased ? "أُوقفت الجلسة وأُنهيت جلسة المتصفح السحابي." : "أُوقفت الجلسة، لكن تعذر تأكيد إنهاء الجلسة السحابية؛ ستنتهي تلقائياً خلال دقائق."}</Notice>}
      {task.status === "succeeded" && <Notice tone="ok">{task.endReason ? END_LABEL[task.endReason] : "انتهت الجلسة."} {task.sessionReleased ? "أُنهيت الجلسة السحابية." : "تعذر تأكيد إنهاء الجلسة السحابية؛ ستنتهي تلقائياً."}</Notice>}
      {stalled && live && (
        <Notice tone="warn" role="alert">انقطعت متابعة الحالة، والجلسة قد تكون ما زالت تعمل.
          <button className="btn" style={{ marginInlineStart: 8 }} onClick={() => { setStalled(false); poll(task.id, 0, 300); }}>إعادة المحاولة</button></Notice>
      )}
      {error && <small role="alert" className="bt-error">{error}</small>}
    </div>
  );
}
