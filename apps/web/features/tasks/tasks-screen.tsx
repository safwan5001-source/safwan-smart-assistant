"use client";
import { useMemo, useState } from "react";
import Icon from "@/components/icon";
import Modal from "@/components/modal";
import { Badge, Empty, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { useHydrated, useStore, useStoreError, useUrlQuery } from "@/lib/hooks";
import { tasksStore } from "@/lib/stores";
import { runCommand } from "@/lib/commands";
import type { Priority, Task } from "@/lib/domain";
import { dueState, formatDay, localDateKey } from "@/lib/format";
import { matches } from "@/lib/search";
import BashtAutomations from "./basht-automations";

type Filter = "all" | "pending" | "overdue" | "done";
type Sort = "newest" | "priority" | "due";
const PRIORITY_LABEL: Record<Priority, string> = { high: "عالية", normal: "عادية", low: "منخفضة" };
const WEIGHT: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export default function TasksScreen() {
  const hydrated = useHydrated();
  const tasks = useStore(tasksStore);
  const storageError = useStoreError(tasksStore);
  const { confirm, toast } = useDialogs();

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [formError, setFormError] = useState("");
  const [filter, setFilter] = useState<Filter>("pending");
  const [sort, setSort] = useState<Sort>("due");
  const [query, setQuery] = useState("");
  useUrlQuery(setQuery);
  const [editing, setEditing] = useState<Task | null>(null);

  const today = localDateKey();
  const counts = useMemo(() => ({
    all: tasks.length,
    pending: tasks.filter((t) => !t.done).length,
    overdue: tasks.filter((t) => !t.done && dueState(t.due, today) === "overdue").length,
    done: tasks.filter((t) => t.done).length,
  }), [tasks, today]);

  const shown = useMemo(() => {
    const list = tasks.filter((t) =>
      (filter === "all" || (filter === "done" ? t.done : filter === "pending" ? !t.done : !t.done && dueState(t.due, today) === "overdue")) &&
      matches(t.title + " " + (t.notes ?? ""), query));
    return list.sort((a, b) =>
      sort === "priority" ? WEIGHT[a.priority ?? "normal"] - WEIGHT[b.priority ?? "normal"] || b.created - a.created
      : sort === "due" ? (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.created - a.created
      : b.created - a.created);
  }, [tasks, filter, sort, query, today]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await runCommand("tasks.add", { title, priority, due: due || undefined });
    if (res.status !== "executed") { setFormError(res.status === "invalid" ? res.message : "تعذر إضافة المهمة."); return; }
    setTitle(""); setDue(""); setPriority("normal"); setFormError(""); toast("أُضيفت المهمة");
  };
  const toggle = (t: Task) => void runCommand("tasks.toggle", { id: t.id });
  const remove = async (t: Task) => {
    if (!(await confirm({ title: "حذف المهمة؟", message: `سيتم حذف «${t.title}» من هذا الجهاز.`, confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("tasks.remove", { id: t.id }); toast("حُذفت المهمة");
  };
  const clearDone = async () => {
    const ok = await confirm({ title: "حذف كل المهام المكتملة؟", message: `سيتم حذف ${counts.done} مهمة مكتملة نهائياً من هذا الجهاز.`, confirmLabel: "حذف المكتملة", tone: "danger" });
    if (!ok) return;
    const res = await runCommand("tasks.clear_completed", {}, { approved: true });
    if (res.status === "executed") toast(`حُذفت ${res.data} مهمة`);
  };

  const filters: { id: Filter; label: string }[] = [
    { id: "pending", label: "المتبقية" }, { id: "overdue", label: "المتأخرة" }, { id: "done", label: "المكتملة" }, { id: "all", label: "الكل" },
  ];

  return (
    <div className="page">
      <PageHeader icon="tasks" eyebrow="المهام" title="مهامي" description="رتّب أولوياتك ومواعيدك. المهام محفوظة على هذا الجهاز فقط." />
      {storageError && <Notice tone="warn" role="alert">{storageError}</Notice>}

      <form className="card card-pad add-form" onSubmit={add} aria-label="إضافة مهمة">
        <div className="field">
          <label htmlFor="new-task">مهمة جديدة</label>
          <input id="new-task" className="input" value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); setFormError(""); }} placeholder="مثال: مراجعة فواتير الأسبوع" enterKeyHint="done" autoComplete="off" />
        </div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="new-priority">الأولوية</label>
            <select id="new-priority" className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="high">عالية</option><option value="normal">عادية</option><option value="low">منخفضة</option>
            </select></div>
          <div className="field"><label htmlFor="new-due">الاستحقاق</label><input id="new-due" className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        </div>
        {formError && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>{formError}</p>}
        <button type="submit" className="btn btn-primary" disabled={!title.trim()}><Icon name="plus" size={18} />إضافة مهمة</button>
      </form>

      <div className="stack">
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" type="search" aria-label="البحث في المهام" placeholder="ابحث في المهام" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="chips" role="group" aria-label="تصفية المهام">
          {filters.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="count num">{counts[f.id]}</span></button>
          ))}
        </div>
        <div className="row">
          <label className="row muted" style={{ fontSize: 13 }}>ترتيب
            <select className="select" style={{ minHeight: 38, width: "auto", paddingBlock: 4 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="ترتيب المهام">
              <option value="due">الاستحقاق</option><option value="priority">الأولوية</option><option value="newest">الأحدث</option>
            </select></label>
          <span className="spacer" />
          {counts.done > 0 && <button className="btn btn-sm" onClick={() => void clearDone()}><Icon name="trash" size={16} />حذف المكتملة</button>}
        </div>
      </div>

      <section aria-label="قائمة المهام" aria-live="polite">
        {!hydrated ? <ListSkeleton rows={3} h={68} /> : shown.length ? (
          <ul className="stack">
            {shown.map((t) => {
              const d = t.done ? "none" : dueState(t.due, today);
              return (
                <li key={t.id} className={"task " + (t.done ? "done" : "")}>
                  <label className="task-check"><input type="checkbox" checked={t.done} onChange={() => toggle(t)} aria-label={(t.done ? "إلغاء إكمال " : "إكمال ") + t.title} /></label>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="task-title">{t.title}</div>
                    {t.notes && <div className="task-notes">{t.notes}</div>}
                    <div className="task-meta">
                      <Badge tone={t.priority === "high" ? "danger" : t.priority === "low" ? undefined : "info"}>{PRIORITY_LABEL[t.priority ?? "normal"]}</Badge>
                      {t.due && <Badge tone={d === "overdue" ? "danger" : d === "today" ? "warn" : undefined}><Icon name="calendar" size={13} />{d === "overdue" ? "متأخرة · " : d === "today" ? "اليوم · " : ""}<span className="num">{formatDay(t.due)}</span></Badge>}
                    </div>
                  </div>
                  <button className="icon-btn sm" onClick={() => setEditing(t)} aria-label={"تعديل " + t.title}><Icon name="edit" size={18} /></button>
                  <button className="icon-btn sm" onClick={() => void remove(t)} aria-label={"حذف " + t.title}><Icon name="trash" size={18} /></button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="card"><Empty icon={tasks.length ? "search" : "tasks"} title={tasks.length ? "لا مهام في هذا العرض" : "لا مهام بعد"}>
            {tasks.length ? "غيّر التصفية أو عبارة البحث." : "أضف أول مهمة من النموذج أعلاه، أو اكتب «/مهمة عنوان» في المحادثات."}</Empty></div>
        )}
      </section>

      <BashtAutomations />

      <EditDialog task={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function EditDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { toast } = useDialogs();
  const [draft, setDraft] = useState<{ title: string; priority: Priority; due: string; notes: string }>({ title: "", priority: "normal", due: "", notes: "" });
  const [error, setError] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (task && task.id !== loadedId) {
    setLoadedId(task.id); setError("");
    setDraft({ title: task.title, priority: task.priority ?? "normal", due: task.due ?? "", notes: task.notes ?? "" });
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task) return;
    const res = await runCommand("tasks.update", { id: task.id, title: draft.title, priority: draft.priority, due: draft.due || null, notes: draft.notes });
    if (res.status !== "executed") { setError(res.status === "invalid" ? res.message : "تعذر الحفظ."); return; }
    toast("تم حفظ التعديل"); setLoadedId(null); onClose();
  };
  return (
    <Modal open={!!task} onClose={() => { setLoadedId(null); onClose(); }} label="تعديل المهمة">
      <form className="dialog-card" onSubmit={save}>
        <h2>تعديل المهمة</h2>
        <div className="field"><label htmlFor="e-title">العنوان</label><input id="e-title" className="input" autoFocus maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="e-pri">الأولوية</label>
            <select id="e-pri" className="select" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}><option value="high">عالية</option><option value="normal">عادية</option><option value="low">منخفضة</option></select></div>
          <div className="field"><label htmlFor="e-due">الاستحقاق</label><input id="e-due" className="input" type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="e-notes">ملاحظات</label><textarea id="e-notes" className="textarea" rows={3} maxLength={2000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></div>
        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>{error}</p>}
        <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={!draft.title.trim()}>حفظ</button><button type="button" className="btn" onClick={() => { setLoadedId(null); onClose(); }}>إلغاء</button></div>
      </form>
    </Modal>
  );
}
