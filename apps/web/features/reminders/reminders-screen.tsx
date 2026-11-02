"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/icon";
import ReminderDialog from "@/components/reminder-dialog";
import { Badge, Empty, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { useHydrated, useStore, useStoreError } from "@/lib/hooks";
import { prefsStore, remindersStore } from "@/lib/stores";
import { runCommand } from "@/lib/commands";
import {
  PRIORITY_LABEL, REPEAT_LABEL, SNOOZE_OPTIONS, alertAt, describeSchedule, leadLabel,
  type Reminder, type ReminderInput,
} from "@/lib/reminders";
import { isReminderIntent, parseReminderText, type Clarification } from "@/lib/reminder-parser";
import { formatTimeInZone } from "@/lib/tz";
import { matches } from "@/lib/search";

type Filter = "active" | "paused" | "completed" | "all";
type Dialog = { reminder: Reminder | null; seed?: Partial<ReminderInput>; clarification?: Clarification | null; notes?: string[] } | null;

const isOpenItem = (r: Reminder) => r.status === "active" || r.status === "fired";
const sortKey = (r: Reminder) => (r.status === "fired" ? -1 : 0) * 1e15 + (alertAt(r) ?? r.dueAt);

export default function RemindersScreen() {
  const hydrated = useHydrated();
  const list = useStore(remindersStore);
  const prefs = useStore(prefsStore);
  const storageError = useStoreError(remindersStore);
  const { confirm, toast } = useDialogs();
  const params = useSearchParams();
  const focus = params.get("focus");
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [quickError, setQuickError] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const focused = useRef<HTMLLIElement | null>(null);

  const counts = useMemo(() => ({
    active: list.filter(isOpenItem).length, paused: list.filter((r) => r.status === "paused").length,
    completed: list.filter((r) => r.status === "completed").length, all: list.length,
  }), [list]);
  const shown = useMemo(() => list
    .filter((r) => (filter === "all" || (filter === "active" ? isOpenItem(r) : r.status === filter)) && matches(r.title + " " + (r.notes ?? ""), query))
    .sort((a, b) => sortKey(a) - sortKey(b)), [list, filter, query]);
  const awaiting = list.filter((r) => r.status === "fired").length;

  // arriving from a notification: show the item even if the current filter hides it, then scroll to it
  useEffect(() => {
    if (!focus) return;
    const r = remindersStore.getSnapshot().find((x) => x.id === focus);
    if (r) setFilter(r.status === "paused" ? "paused" : r.status === "completed" ? "completed" : "active");
  }, [focus]);
  useEffect(() => { if (focus && hydrated) focused.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focus, hydrated, shown.length]);

  const quickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = quick.trim();
    if (!text) return;
    const out = parseReminderText(isReminderIntent(text) ? text : `ذكرني ${text}`, Date.now(), prefs.tz);
    if (out.kind === "ready") {
      const res = await runCommand("reminders.add", out.draft);
      if (res.status !== "executed") { setQuickError(res.status === "invalid" ? res.message : "تعذر ضبط التذكير."); return; }
      setQuick(""); setQuickError(""); toast(`تم ضبط التذكير: ${describeSchedule(res.data)}`);
    } else if (out.kind === "clarify") {
      setDialog({ reminder: null, seed: out.draft, clarification: out.clarification, notes: out.notes }); setQuick(""); setQuickError("");
    } else setDialog({ reminder: null, seed: { title: text } });
  };

  const act = async (id: string, fn: () => Promise<{ status: string; message?: string }>, ok: string) => {
    const res = await fn();
    if (res.status === "executed") toast(ok); else toast(res.message ?? "تعذر تنفيذ الإجراء", "error");
  };
  const remove = async (r: Reminder) => {
    if (!(await confirm({ title: "حذف التذكير؟", message: `سيتم حذف «${r.title}» من هذا الجهاز ومن خادم الإشعارات إن كان مفعّلاً.`, confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("reminders.remove", { id: r.id }); toast("حُذف التذكير");
  };

  const filters: { id: Filter; label: string }[] = [{ id: "active", label: "النشطة" }, { id: "paused", label: "الموقوفة" }, { id: "completed", label: "المكتملة" }, { id: "all", label: "الكل" }];
  return (
    <div className="page">
      <PageHeader eyebrow="التذكيرات" title="تذكيراتي" description="أنشئ تذكيراً بجملة عربية أو من النموذج. تُنبَّه وأنت داخل التطبيق، وعلى iPhone المثبّت تصلك إشعارات حتى والتطبيق مغلق."
        actions={<button className="btn btn-primary" onClick={() => setDialog({ reminder: null })}><Icon name="plus" size={18} />تذكير جديد</button>} />
      {storageError && <Notice tone="warn" role="alert">{storageError}</Notice>}
      {awaiting > 0 && <Notice tone="warn" role="status"><strong>{awaiting === 1 ? "لديك تذكير بانتظار إجراء" : `لديك ${awaiting} تذكيرات بانتظار إجراء`}</strong> — اختر «تم» أو أجّله.</Notice>}
      <form className="card card-pad stack" onSubmit={quickAdd} aria-label="إضافة سريعة">
        <div className="field">
          <label htmlFor="quick-r">إضافة سريعة بالعربية</label>
          <div className="row">
            <input id="quick-r" className="input" value={quick} maxLength={300} onChange={(e) => { setQuick(e.target.value); setQuickError(""); }} placeholder="ذكرني بكرة الساعة 9 صباحاً بمراجعة الفواتير" enterKeyHint="done" autoComplete="off" />
            <button type="submit" className="btn btn-primary" disabled={!quick.trim()}>ضبط</button>
          </div>
          <span className="field-hint">أمثلة: «نبهني بعد ساعتين أشرب دواء» · «ذكرني كل أحد الساعة 8 مساءً بالاجتماع» · «قبل نصف ساعة من موعد الطبيب يوم الخميس 4»</span>
        </div>
        {quickError && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>{quickError}</p>}
      </form>
      <div className="stack">
        <div className="search"><Icon name="search" size={18} />
          <input className="input" type="search" aria-label="البحث في التذكيرات" placeholder="ابحث في التذكيرات" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="chips" role="group" aria-label="تصفية التذكيرات">
          {filters.map((f) => <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="count num">{counts[f.id]}</span></button>)}
        </div>
      </div>
      <section aria-label="قائمة التذكيرات" aria-live="polite">
        {!hydrated ? <ListSkeleton rows={3} h={92} /> : shown.length ? (
          <ul className="stack">
            {shown.map((r) => {
              const snoozed = r.snoozeUntil !== undefined && r.status !== "completed" && r.status !== "paused";
              const open = isOpenItem(r);
              return (
                <li key={r.id} ref={focus === r.id ? focused : undefined} className={"reminder " + r.status + (focus === r.id ? " focus" : "") + (r.priority === "critical" ? " critical" : "")}>
                  <div className="reminder-main">
                    <div className="reminder-title">{r.title}</div>
                    {r.notes && <div className="task-notes">{r.notes}</div>}
                    <div className="reminder-when"><Icon name="clock" size={15} /><span className="num">{describeSchedule(r)}</span></div>
                    <div className="task-meta">
                      {r.status === "fired" && <Badge tone="warn">بانتظار الإجراء</Badge>}
                      {r.status === "paused" && <Badge>موقوف</Badge>}
                      {r.status === "completed" && <Badge tone="ok">مكتمل</Badge>}
                      {snoozed && <Badge tone="info"><Icon name="clock" size={13} />مؤجّل حتى <span className="num">{formatTimeInZone(r.snoozeUntil!, r.tz)}</span></Badge>}
                      {r.repeat !== "none" && <Badge><Icon name="repeat" size={13} />{REPEAT_LABEL[r.repeat]}</Badge>}
                      {r.leadMinutes > 0 && <Badge>{leadLabel(r.leadMinutes)}</Badge>}
                      {(r.priority === "high" || r.priority === "critical") && <Badge tone={r.priority === "critical" ? "danger" : "warn"}>{PRIORITY_LABEL[r.priority]}</Badge>}
                    </div>
                    {open && (
                      <div className="reminder-actions">
                        {(r.status === "fired" || snoozed) && <button className="btn btn-sm btn-primary" onClick={() => void act(r.id, () => runCommand("reminders.complete", { id: r.id }), "تم إكمال التذكير")}><Icon name="check" size={16} />تم</button>}
                        <button className="btn btn-sm" aria-expanded={snoozing === r.id} onClick={() => setSnoozing(snoozing === r.id ? null : r.id)}><Icon name="clock" size={16} />أجّل</button>
                        {r.status === "active" && !snoozed && r.repeat === "none" && <button className="btn btn-sm" onClick={() => void act(r.id, () => runCommand("reminders.complete", { id: r.id }), "تم إكمال التذكير")}><Icon name="check" size={16} />إكمال</button>}
                      </div>
                    )}
                    {open && snoozing === r.id && (
                      <div className="chips snooze-chips" role="group" aria-label="مدة التأجيل">
                        {SNOOZE_OPTIONS.map((m) => <button key={m} className="chip" onClick={() => void act(r.id, () => runCommand("reminders.snooze", { id: r.id, minutes: m }), `تم التأجيل ${m === 60 ? "ساعة" : `${m} دقيقة`}`).then(() => setSnoozing(null))}>{m === 60 ? "ساعة" : `${m} دقيقة`}</button>)}
                      </div>
                    )}
                  </div>
                  <div className="reminder-side">
                    {r.status === "paused"
                      ? <button className="icon-btn sm" onClick={() => void act(r.id, () => runCommand("reminders.resume", { id: r.id }), "تم استئناف التذكير")} aria-label={"استئناف " + r.title}><Icon name="play" size={18} /></button>
                      : r.status !== "completed" && <button className="icon-btn sm" onClick={() => void act(r.id, () => runCommand("reminders.pause", { id: r.id }), "تم إيقاف التذكير")} aria-label={"إيقاف " + r.title}><Icon name="pause" size={18} /></button>}
                    <button className="icon-btn sm" onClick={() => setDialog({ reminder: r })} aria-label={"تعديل " + r.title}><Icon name="edit" size={18} /></button>
                    <button className="icon-btn sm" onClick={() => void remove(r)} aria-label={"حذف " + r.title}><Icon name="trash" size={18} /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="card"><Empty icon={list.length ? "search" : "bell"} title={list.length ? "لا تذكيرات في هذا العرض" : "لا تذكيرات بعد"}
            action={!list.length ? <button className="btn btn-primary" onClick={() => setDialog({ reminder: null })}><Icon name="plus" size={18} />أنشئ أول تذكير</button> : undefined}>
            {list.length ? "غيّر التصفية أو عبارة البحث." : "اكتب «ذكرني بكرة الساعة 9 …» في الأعلى أو في المحادثات."}</Empty></div>
        )}
      </section>
      <ReminderDialog open={!!dialog} onClose={() => setDialog(null)} reminder={dialog?.reminder} seed={dialog?.seed} clarification={dialog?.clarification} notes={dialog?.notes} />
    </div>
  );
}
