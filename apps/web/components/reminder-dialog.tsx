"use client";
import { useState } from "react";
import Modal from "./modal";
import { useDialogs } from "./dialogs";
import { Notice } from "./ui";
import { useStore } from "@/lib/hooks";
import { prefsStore } from "@/lib/stores";
import { runCommand } from "@/lib/commands";
import {
  LEAD_OPTIONS, PRIORITIES, PRIORITY_LABEL, REPEATS, REPEAT_LABEL, REMINDER_LIMITS, leadLabel,
  type Reminder, type ReminderInput, type ReminderPriority, type RepeatKind,
} from "@/lib/reminders";
import type { Clarification } from "@/lib/reminder-parser";
import { TZ_LABEL, addDays, dateKey, zoneParts } from "@/lib/tz";

type Draft = { title: string; notes: string; date: string; time: string; repeat: RepeatKind; lead: number; priority: ReminderPriority };
const todayKey = (tz: string) => dateKey(zoneParts(Date.now(), tz));
const tomorrowKey = (tz: string) => dateKey(addDays(zoneParts(Date.now(), tz), 1));

function initial(reminder: Reminder | null | undefined, seed: Partial<ReminderInput> | undefined, tz: string, lead: number): Draft {
  if (reminder) {
    return {
      title: reminder.title, notes: reminder.notes ?? "", time: reminder.time, repeat: reminder.repeat, lead: reminder.leadMinutes, priority: reminder.priority,
      date: reminder.repeat === "none" ? dateKey(zoneParts(reminder.dueAt, reminder.tz)) : reminder.anchor,
    };
  }
  return {
    title: seed?.title ?? "", notes: seed?.notes ?? "", date: seed?.date ?? tomorrowKey(tz), time: seed?.time ?? "09:00",
    repeat: seed?.repeat ?? "none", lead: seed?.leadMinutes ?? lead, priority: seed?.priority ?? "normal",
  };
}

export type ReminderDialogProps = {
  open: boolean; onClose: () => void;
  reminder?: Reminder | null;
  /** prefill from the Arabic parser / quick add */
  seed?: Partial<ReminderInput>;
  clarification?: Clarification | null;
  notes?: string[];
};

export default function ReminderDialog(props: ReminderDialogProps) {
  const { open, onClose, reminder, seed, clarification, notes } = props;
  // the form remounts each time the dialog opens, so its state is always fresh
  return (
    <Modal open={open} onClose={onClose} label={reminder ? "تعديل التذكير" : "تذكير جديد"}>
      <Form onClose={onClose} reminder={reminder} seed={seed} clarification={clarification} notes={notes} />
    </Modal>
  );
}

function Form({ onClose, reminder, seed, clarification, notes }: Omit<ReminderDialogProps, "open">) {
  const { toast } = useDialogs();
  const prefs = useStore(prefsStore);
  const tz = reminder?.tz ?? prefs.tz;
  const [d, setD] = useState<Draft>(() => initial(reminder, seed, tz, prefs.defaultLeadMinutes));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((o) => ({ ...o, [k]: v })); setError(""); };
  const applyPatch = (patch: Partial<ReminderInput>) => setD((o) => ({
    ...o, ...(patch.title !== undefined && { title: patch.title }), ...(patch.date !== undefined && { date: patch.date }), ...(patch.time !== undefined && { time: patch.time }),
    ...(patch.repeat !== undefined && { repeat: patch.repeat }), ...(patch.priority !== undefined && { priority: patch.priority }),
  }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const input: ReminderInput = { title: d.title, notes: d.notes, tz, repeat: d.repeat, time: d.time, date: d.date, leadMinutes: d.lead, priority: d.priority };
    const res = reminder
      ? await runCommand("reminders.update", { id: reminder.id, patch: input })
      : await runCommand("reminders.add", input);
    setBusy(false);
    if (res.status !== "executed") { setError(res.status === "invalid" ? res.message : "تعذر حفظ التذكير."); return; }
    toast(reminder ? "تم حفظ التعديل" : "تم ضبط التذكير");
    onClose();
  };

  return (
    <form className="dialog-card" onSubmit={submit}>
      <h2>{reminder ? "تعديل التذكير" : "تذكير جديد"}</h2>
      {clarification && !reminder && (
        <div className="notice warn" role="status">
          <div style={{ display: "grid", gap: 8 }}>
            <strong>{clarification.question}</strong>
            {clarification.options.length > 0 && (
              <div className="row-wrap">
                {clarification.options.map((o) => <button type="button" key={o.label} className="chip" onClick={() => applyPatch(o.patch)}>{o.label}</button>)}
              </div>
            )}
          </div>
        </div>
      )}
      {!!notes?.length && !reminder && <Notice>{notes.join(" · ")}</Notice>}
      <div className="field"><label htmlFor="r-title">ما الذي تريد أن أذكّرك به؟</label>
        <input id="r-title" className="input" autoFocus={!d.title} maxLength={REMINDER_LIMITS.title} value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="مثال: مراجعة الفواتير" enterKeyHint="done" /></div>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="r-date">التاريخ</label><input id="r-date" className="input" type="date" value={d.date} min={reminder && d.repeat !== "none" ? undefined : todayKey(tz)} onChange={(e) => set("date", e.target.value)} /></div>
        <div className="field"><label htmlFor="r-time">الوقت</label><input id="r-time" className="input" type="time" value={d.time} onChange={(e) => set("time", e.target.value)} /></div>
      </div>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="r-repeat">التكرار</label>
          <select id="r-repeat" className="select" value={d.repeat} onChange={(e) => set("repeat", e.target.value as RepeatKind)}>{REPEATS.map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}</select></div>
        <div className="field"><label htmlFor="r-lead">التنبيه المسبق</label>
          <select id="r-lead" className="select" value={d.lead} onChange={(e) => set("lead", Number(e.target.value))}>
            {[...new Set([...LEAD_OPTIONS, d.lead])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{leadLabel(m)}</option>)}
          </select></div>
      </div>
      <div className="field"><label id="r-pri-l">الأهمية</label>
        <div className="seg" role="group" aria-labelledby="r-pri-l">
          {PRIORITIES.map((p) => <button type="button" key={p} aria-pressed={d.priority === p} onClick={() => set("priority", p)}>{PRIORITY_LABEL[p]}</button>)}
        </div>
        {d.priority === "critical" && <span className="field-hint">الحرجة تُنبَّه بصوت أقوى وتبقى ظاهرة حتى تتعامل معها، وتتجاوز أوقات الهدوء إن سمحت بذلك في الإعدادات.</span>}
      </div>
      <div className="field"><label htmlFor="r-notes">ملاحظات (اختياري)</label>
        <textarea id="r-notes" className="textarea" rows={2} maxLength={REMINDER_LIMITS.notes} value={d.notes} onChange={(e) => set("notes", e.target.value)} /></div>
      <small className="muted">المنطقة الزمنية: {TZ_LABEL(tz)}</small>
      {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</p>}
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={!d.title.trim() || busy}>{reminder ? "حفظ" : "ضبط التذكير"}</button>
        <button type="button" className="btn" onClick={onClose}>إلغاء</button>
      </div>
    </form>
  );
}
