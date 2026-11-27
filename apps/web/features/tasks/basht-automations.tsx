"use client";
/**
 * «مهام باشت المجدولة» (B5) inside the Tasks screen: the engine's own scheduled jobs, read from BASHT itself. Two actions only —
 * run now and enable/disable (each confirmed, audited by the API). Creating, editing and deleting stay in the chat with BASHT.
 * Engine-managed jobs (e.g. memory "dreaming") are view-only and hidden behind a filter. Hidden entirely when BASHT is not
 * connected or the engine has no such view.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge, ListSkeleton, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { bashtClient, BashtError } from "@/lib/basht-client";
import { controlClient, controlErrorText, DELIVERY_LABEL, duration, isUnavailable, relative, RUN_LABEL, scheduleLabel, JOB_ADDRESSABLE,
  type Automation, type AutomationRun } from "@/lib/basht-control";
import { formatTime } from "@/lib/format";

type View = "loading" | "hidden" | "ready" | "error";

export default function BashtAutomations() {
  const { confirm, toast } = useDialogs();
  const [view, setView] = useState<View>("loading");
  const [jobs, setJobs] = useState<Automation[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AutomationRun[] | "loading" | "error">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const s = await bashtClient.status();
    if (!s.enabled || !s.authenticated) { setView("hidden"); return; }
    try { setJobs(await controlClient.automations()); setNow(Date.now()); setView("ready"); }
    catch (e) { setView(isUnavailable(e) || (e instanceof BashtError && e.code === "unauthorized") ? "hidden" : "error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadRuns = useCallback(async (id: string) => {
    setRuns((r) => ({ ...r, [id]: "loading" }));
    try { const list = await controlClient.runs(id); setRuns((r) => ({ ...r, [id]: list })); }
    catch { setRuns((r) => ({ ...r, [id]: "error" })); }
  }, []);
  const toggleRuns = (id: string) => { if (open === id) { setOpen(null); return; } setOpen(id); void loadRuns(id); };

  const runNow = async (j: Automation) => {
    const ok = await confirm({ title: "تشغيل المهمة الآن؟", message: `سيشغّل باشت «${j.name}» فورًا خارج موعدها، وقد يرسل نتيجتها كما هو مضبوط فيها. لا يتغير موعدها القادم.`, confirmLabel: "تشغيل الآن" });
    if (!ok) return;
    setBusy(j.id);
    try {
      await controlClient.runNow(j.id);
      toast("طلبتُ من باشت تشغيلها الآن. تظهر النتيجة في السجل بعد انتهائها.");
      setOpen(j.id);
      // the run is queued by the engine: read its real state a moment later, never assume it
      setTimeout(() => { void load(); void loadRuns(j.id); }, 4000);
    } catch (e) { toast(controlErrorText(e), "error"); } finally { setBusy(null); }
  };

  const setEnabled = async (j: Automation, enabled: boolean) => {
    const ok = await confirm(enabled
      ? { title: "تفعيل المهمة؟", message: `سيعود باشت إلى تشغيل «${j.name}» في مواعيدها.`, confirmLabel: "تفعيل" }
      : { title: "إيقاف المهمة؟", message: `لن يشغّل باشت «${j.name}» حتى تعيد تفعيلها. لا تُحذف المهمة.`, confirmLabel: "إيقاف", tone: "danger" });
    if (!ok) return;
    setBusy(j.id);
    try {
      const real = await controlClient.setEnabled(j.id, enabled);
      if (real === enabled) toast(enabled ? "فُعّلت المهمة" : "أُوقفت المهمة");
      else toast("أرسلتُ التغيير، لكن باشت لم يؤكده بعد.", "error");
      await load();
    } catch (e) { toast(controlErrorText(e), "error"); await load(); } finally { setBusy(null); }
  };

  if (view === "hidden") return null;
  const system = jobs.filter((j) => j.system).length;
  const shown = jobs.filter((j) => showSystem || !j.system);

  return (
    <section className="stack" aria-labelledby="bauto-h" style={{ gap: 10 }}>
      <div className="section-head">
        <h2 id="bauto-h"><Icon name="repeat" size={18} />مهام باشت المجدولة</h2>
        <button className="btn btn-sm" onClick={() => { setView("loading"); void load(); }} aria-label="تحديث مهام باشت المجدولة"><Icon name="repeat" size={16} />تحديث</button>
      </div>
      <p className="muted" style={{ fontSize: 13.5 }}>مهام يشغّلها باشت نفسه في مواعيدها، من المحرك مباشرة. تختلف عن مهامك أعلاه المحفوظة على هذا الجهاز.</p>
      {system > 0 && (
        <div className="chips" role="group" aria-label="تصفية مهام باشت">
          <button className="chip" aria-pressed={!showSystem} onClick={() => setShowSystem(false)}>مهامك<span className="count num">{jobs.length - system}</span></button>
          <button className="chip" aria-pressed={showSystem} onClick={() => setShowSystem(true)}>مع مهام النظام<span className="count num">{jobs.length}</span></button>
        </div>
      )}

      {view === "loading" ? <ListSkeleton rows={2} h={96} /> : view === "error" ? (
        <Notice tone="warn" role="alert">تعذّرت قراءة مهام باشت المجدولة الآن. <button className="btn btn-sm" onClick={() => { setView("loading"); void load(); }}>إعادة المحاولة</button></Notice>
      ) : shown.length === 0 ? (
        <div className="card card-pad"><p className="muted" style={{ fontSize: 14 }}>لا توجد مهام مجدولة لدى باشت بعد.</p></div>
      ) : (
        <ul className="stack" style={{ gap: 10 }}>
          {shown.map((j) => {
            const last = j.last;
            const st = last?.status ? RUN_LABEL[last.status] : null;
            const actionable = !j.system && JOB_ADDRESSABLE.test(j.id);
            const r = runs[j.id];
            return (
              <li key={j.id} className="card card-pad stack ctl-job" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <div className="grow stack" style={{ gap: 4 }}>
                    <strong>{j.name}</strong>
                    <small className="muted row" style={{ gap: 4 }}><Icon name="clock" size={13} />{scheduleLabel(j.schedule)}</small>
                  </div>
                  <span className="row-wrap" style={{ justifyContent: "flex-end" }}>
                    {j.running && <Badge tone="info">تعمل الآن</Badge>}
                    {j.system && <Badge>يديرها باشت</Badge>}
                    <Badge tone={j.enabled ? "ok" : undefined}>{j.enabled ? "مفعّلة" : "متوقفة"}</Badge>
                  </span>
                </div>
                {j.prompt && <p className="ctl-prompt">{j.prompt}</p>}
                <div className="task-meta">
                  {j.enabled && j.next_run_at != null && <Badge><Icon name="calendar" size={13} />القادم {relative(j.next_run_at, now)}</Badge>}
                  {last?.at != null && <Badge tone={st?.tone}>آخر تشغيل {relative(last.at, now)}{st ? ` · ${st.label}` : ""}{last.duration_ms != null ? ` · ${duration(last.duration_ms)}` : ""}</Badge>}
                  {last?.delivery && DELIVERY_LABEL[last.delivery] && <Badge tone={last.delivery === "not-delivered" ? "warn" : undefined}>{DELIVERY_LABEL[last.delivery]}</Badge>}
                  {j.auto_disabled && <Badge tone="danger">أوقفها باشت بعد أخطاء متكررة</Badge>}
                </div>
                {last?.error && <small style={{ color: "var(--danger)" }}>{last.error}</small>}
                <div className="row-wrap">
                  {actionable && <button className="btn btn-sm btn-primary" disabled={busy === j.id || j.running || !j.enabled} onClick={() => void runNow(j)} title={!j.enabled ? "فعّل المهمة أولًا" : undefined}><Icon name="play" size={16} />تشغيل الآن</button>}
                  {actionable && <button className="btn btn-sm" disabled={busy === j.id} onClick={() => void setEnabled(j, !j.enabled)}><Icon name={j.enabled ? "pause" : "play"} size={16} />{j.enabled ? "إيقاف" : "تفعيل"}</button>}
                  <button className="btn btn-sm" aria-expanded={open === j.id} onClick={() => toggleRuns(j.id)}><Icon name="activity" size={16} />السجل</button>
                </div>
                {open === j.id && (
                  <div className="ctl-runs" aria-live="polite">
                    {r === "loading" || r === undefined ? <small className="muted">جارٍ قراءة السجل…</small>
                      : r === "error" ? <small className="muted">تعذّرت قراءة السجل.</small>
                      : r.length === 0 ? <small className="muted">لم تُشغَّل هذه المهمة بعد.</small>
                      : (
                        <ol className="stack" style={{ gap: 8 }}>
                          {r.map((x) => (
                            <li key={x.at} className="ctl-run">
                              <div className="row-wrap" style={{ gap: 6 }}>
                                <small className="num" dir="ltr">{formatTime(x.at)}</small>
                                {x.status && <Badge tone={RUN_LABEL[x.status]?.tone}>{RUN_LABEL[x.status]?.label ?? x.status}</Badge>}
                                {x.duration_ms != null && <small className="muted">{duration(x.duration_ms)}</small>}
                                {x.delivery && DELIVERY_LABEL[x.delivery] && <small className="muted">· {DELIVERY_LABEL[x.delivery]}</small>}
                              </div>
                              {x.quiet ? <p className="muted ctl-summary">لا شيء جديد.</p> : x.summary && <p className="ctl-summary">{x.summary}</p>}
                              {x.error && <small style={{ color: "var(--danger)" }}>{x.error}</small>}
                            </li>
                          ))}
                        </ol>
                      )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Notice>لإنشاء مهمة مجدولة أو تعديلها أو حذفها، اطلب ذلك من باشت في <Link href="/chat">المحادثة</Link> (مثال: «ذكّرني كل أحد الساعة 9 بمراجعة الفواتير»).</Notice>
    </section>
  );
}
