"use client";
import {useState} from "react";
type Connector={name:string;kind:string;description:string;icon:string};
const catalog:Connector[]=[
{name:"GitHub",kind:"التطوير",description:"المستودعات وطلبات الدمج والتحقق من البناء.",icon:"⌘"},
{name:"Vercel",kind:"الاستضافة",description:"نشر الواجهات ومتابعة البيئات.",icon:"▲"},
{name:"Railway",kind:"الاستضافة",description:"خدمات التطبيق وقواعد البيانات.",icon:"▥"},
{name:"Gmail",kind:"البريد",description:"قراءة الرسائل ومتابعة العمل.",icon:"✉"},
{name:"Google Drive",kind:"الملفات",description:"الوصول إلى المستندات والملفات السحابية.",icon:"◇"},
{name:"Google Calendar",kind:"الجدولة",description:"المواعيد والتنبيهات المستقبلية.",icon:"▦"}
];
export default function IntegrationsWorkspace(){
 const [search,setSearch]=useState(""),[filter,setFilter]=useState("الكل");
 const categories=["الكل",...Array.from(new Set(catalog.map(x=>x.kind)))];
 const shown=catalog.filter(x=>(filter==="الكل"||x.kind===filter)&&(x.name+" "+x.description).toLowerCase().includes(search.toLowerCase()));
 return <section className="integrations-view" aria-label="مركز التكاملات">
   <div className="integrations-intro"><span className="feature-badge">استكشاف فقط · لا توجد اتصالات داخل التطبيق</span><h2>خدماتك في مساحة واحدة</h2><p>استعرض التكاملات المخطط لها. هذه الشاشة لا تطلب رموز وصول، ولا تُنشئ اتصالًا تلقائيًا. الربط الفعلي يحتاج مصادقة وموافقات آمنة.</p></div>
   <div className="integrations-controls"><label className="integrations-search"><span className="sr-only">ابحث عن خدمة</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ابحث عن خدمة…" /></label><div className="integrations-filters" role="group" aria-label="تصفية الخدمات">{categories.map(x=><button key={x} aria-pressed={filter===x} onClick={()=>setFilter(x)}>{x}</button>)}</div></div>
   <div className="integrations-grid">{shown.map(x=><article className="integration-card" key={x.name}><div className="integration-card-head"><span className="integration-icon" aria-hidden="true">{x.icon}</span><span className="integration-status">غير متصل</span></div><strong>{x.name}</strong><small>{x.kind}</small><p>{x.description}</p><div className="integration-card-foot">يتطلب ربطًا آمنًا لاحقًا</div></article>)}</div>
   {!shown.length&&<p className="integrations-empty">لا توجد خدمات مطابقة للبحث.</p>}
   <p className="integrations-disclaimer">ملاحظة: اتصال حساباتك بخدمات خارجية داخل ChatGPT لا يعني أن تلك الخدمات متصلة تلقائيًا بهذا التطبيق المستقل.</p>
 </section>;
}
