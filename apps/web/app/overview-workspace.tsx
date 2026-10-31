"use client";
import {useEffect,useState} from "react";
type Task={id:string;title:string;done:boolean;created:number;priority?:"high"|"normal"|"low";due?:string};
type Thread={id:string;title:string;created:number;messages:unknown[]};
type Screen="home"|"chat"|"tasks"|"files"|"calls"|"integrations"|"settings";
const examples=[{title:"محادثة جديدة",description:"اكتب أفكارك واحتفظ بها على هذا الجهاز",screen:"chat" as Screen,icon:"✦"},{title:"إضافة مهمة",description:"رتّب أولوياتك ومواعيدك",screen:"tasks" as Screen,icon:"✓"},{title:"ملفاتي",description:"افتح مستنداتك المحفوظة محليًا",screen:"files" as Screen,icon:"▤"},{title:"التكاملات",description:"راجع الخدمات المتاحة وحالة ربطها",screen:"integrations" as Screen,icon:"⌘"}];
export default function Overview({navigate}:{navigate:(screen:Screen)=>void}){
 const [tasks,setTasks]=useState<Task[]>([]),[threads,setThreads]=useState<Thread[]>([]),[now,setNow]=useState<Date|null>(null);
 useEffect(()=>{
   const load=()=>{
     try{const t:unknown=JSON.parse(localStorage.getItem("safwan-local-tasks-v1")||"[]");setTasks(Array.isArray(t)?t.filter((x):x is Task=>x&&typeof x.id==="string"&&typeof x.title==="string"&&typeof x.done==="boolean").slice(0,1000):[])}catch{setTasks([])}
     try{const c:unknown=JSON.parse(localStorage.getItem("safwan-local-chats-v1")||"[]");setThreads(Array.isArray(c)?c.filter((x):x is Thread=>x&&typeof x.id==="string"&&typeof x.title==="string"&&Array.isArray(x.messages)).slice(0,1000):[])}catch{setThreads([])}
   };
   load();setNow(new Date());
   window.addEventListener("focus",load);return()=>window.removeEventListener("focus",load);
 },[]);
 const pending=tasks.filter(t=>!t.done),urgent=pending.filter(t=>t.priority==="high"),today=now?now.toLocaleDateString("ar-SA",{weekday:"long",day:"numeric",month:"long"}):"مساحة عملك";
 const next=pending.slice().sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999")||b.created-a.created).slice(0,4);
 return <div className="overview" aria-label="لوحة المساعد">
   <section className="overview-hero"><div className="overview-hero-copy"><span className="eyebrow">مساحة العمل الشخصية · نسخة تجريبية</span><h2>مرحبًا بك في مساحة صفوان</h2><p>محادثاتك ومهامك وملفاتك في مكان واحد. البيانات الحالية محفوظة على هذا الجهاز فقط، والمساعد الذكي لم يُربط بالخادم بعد.</p><div className="overview-actions"><button className="action-primary" onClick={()=>navigate("chat")}>ابدأ محادثة <span aria-hidden="true">←</span></button><button className="action-outline" onClick={()=>navigate("tasks")}>إدارة المهام</button></div></div><div className="overview-brand" aria-hidden="true"><img src="/safwan-logo.svg" alt=""/></div></section>
   <div className="overview-date">{today}<span>نظرة سريعة على البيانات المحلية</span></div>
   <div className="overview-stats"><button onClick={()=>navigate("tasks")}><span>المهام المتبقية</span><strong>{pending.length}</strong><small>للمتابعة</small></button><button onClick={()=>navigate("tasks")}><span>عالية الأولوية</span><strong>{urgent.length}</strong><small>تحتاج اهتمامًا</small></button><button onClick={()=>navigate("chat")}><span>المحادثات</span><strong>{threads.length}</strong><small>محفوظة محليًا</small></button></div>
   <div className="overview-section-heading"><h3>الوصول السريع</h3><span>اختر ما تريد إنجازه</span></div>
   <div className="overview-shortcuts">{examples.map(x=><button key={x.screen} onClick={()=>navigate(x.screen)}><span className="shortcut-icon" aria-hidden="true">{x.icon}</span><strong>{x.title}</strong><small>{x.description}</small><span className="shortcut-arrow" aria-hidden="true">←</span></button>)}</div>
   <section className="overview-next"><div className="overview-section-heading"><h3>مهام للمتابعة</h3><button onClick={()=>navigate("tasks")}>عرض جميع المهام ←</button></div>{next.length?<ul>{next.map(t=><li key={t.id}><span className="task-marker" aria-hidden="true"/><span><strong>{t.title}</strong><small>{t.due?"الاستحقاق: "+t.due:t.priority==="high"?"أولوية عالية":"دون موعد محدد"}</small></span></li>)}</ul>:<div className="overview-empty">لا توجد مهام معلقة حاليًا. <button onClick={()=>navigate("tasks")}>أنشئ أول مهمة</button></div>}</section>
   <div className="overview-notice"><span aria-hidden="true">ⓘ</span><span>الرسائل والمهام والملفات ليست متزامنة بين الأجهزة. لا تعتبر هذه النسخة مساعدًا متصلًا أو نظام نسخ احتياطي.</span></div>
 </div>;
}
