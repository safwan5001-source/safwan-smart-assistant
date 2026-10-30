"use client";
import { useEffect, useState } from "react";

type Task = { id: string; title: string; done: boolean; created: number };
const KEY = "safwan-local-tasks-v1";
const valid = (v: unknown): v is Task => {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<Task>;
  return typeof t.id === "string" && typeof t.title === "string" &&
    typeof t.done === "boolean" && typeof t.created === "number";
};
export default function TasksWorkspace() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all"|"pending"|"done">("all");
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const data = localStorage.getItem(KEY);
      if (data) {
        const parsed: unknown = JSON.parse(data);
        if (!Array.isArray(parsed)) throw new Error("invalid");
        setTasks(parsed.filter(valid).slice(0, 1000));
      }
    } catch { setError("تعذر قراءة المهام المحفوظة. يمكنك إنشاء قائمة جديدة."); }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(KEY, JSON.stringify(tasks)); }
    catch { setError("تعذر حفظ المهام على هذا الجهاز. راجع مساحة التخزين."); }
  }, [tasks, loaded]);
  const add = () => {
    const value = title.trim();
    if (!value) return;
    setTasks(old => [{id: crypto.randomUUID(), title: value.slice(0, 200), done: false, created: Date.now()}, ...old]);
    setTitle("");
  };
  const edit = (task: Task) => {
    const value = window.prompt("تعديل المهمة", task.title);
    if (value === null) return;
    if (!value.trim()) { setError("لا يمكن حفظ مهمة بلا عنوان."); return; }
    setTasks(old => old.map(t => t.id === task.id ? {...t, title:value.trim().slice(0,200)} : t));
  };
  const remove = (task: Task) => {
    if (!window.confirm("حذف هذه المهمة؟")) return;
    setTasks(old => old.filter(t => t.id !== task.id));
  };
  const shown = tasks.filter(t => filter === "all" || (filter === "done" ? t.done : !t.done));
  return <section className="setting-card" aria-label="إدارة المهام" style={{display:"grid",gap:16}}>
    <div><h2>مهامي</h2><p>مهام محفوظة على هذا الجهاز فقط، دون حساب أو مزامنة.</p></div>
    <form onSubmit={e=>{e.preventDefault();add()}} style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <input aria-label="عنوان مهمة جديدة" maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="اكتب مهمة جديدة" style={{flex:"1 1 170px",minWidth:0,padding:12,borderRadius:12,border:"1px solid var(--border)",background:"var(--surface-alt)",color:"var(--text)"}}/>
      <button type="submit" disabled={!title.trim()} className="secondary-button">إضافة مهمة</button>
    </form>
    <p role="status" style={{margin:0}}>{tasks.filter(t=>!t.done).length} متبقية · {tasks.filter(t=>t.done).length} مكتملة</p>
    <div role="group" aria-label="تصفية المهام" style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      {([{id:"all",label:"الكل"},{id:"pending",label:"المتبقية"},{id:"done",label:"المكتملة"}] as const).map(x=><button key={x.id} aria-pressed={filter===x.id} onClick={()=>setFilter(x.id)} className="secondary-button" style={{opacity:filter===x.id?1:.65}}>{x.label}</button>)}
    </div>
    {error && <p role="alert">{error}</p>}
    {!shown.length && <p>لا توجد مهام في هذا العرض.</p>}
    <ul style={{padding:0,margin:0,listStyle:"none",display:"grid",gap:10}}>
      {shown.map(t=><li key={t.id} style={{border:"1px solid var(--border)",borderRadius:13,padding:12,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <label style={{display:"flex",alignItems:"center",gap:10,flex:"1 1 150px",minWidth:0,overflowWrap:"anywhere"}}>
          <input type="checkbox" checked={t.done} onChange={()=>setTasks(old=>old.map(x=>x.id===t.id?{...x,done:!x.done}:x))}/>
          <span style={{textDecoration:t.done?"line-through":"none"}}>{t.title}</span>
        </label>
        <button className="secondary-button" onClick={()=>edit(t)}>تعديل</button>
        <button className="secondary-button" onClick={()=>remove(t)}>حذف</button>
      </li>)}
    </ul>
  </section>;
}
