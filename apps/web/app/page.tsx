"use client";
import { useEffect, useState } from "react";
import ChatWorkspace from "./chat-workspace";
import AppIcon, { type AppIconName } from "./app-icon";
type Theme = "system" | "light" | "dark";
type Screen = "home" | "tasks" | "files" | "calls" | "settings";
const nav: {id:Screen;label:string;icon:AppIconName}[] = [
  {id:"home",label:"الرئيسية",icon:"home"},{id:"tasks",label:"المهام",icon:"tasks"},
  {id:"files",label:"الملفات",icon:"files"},{id:"calls",label:"المكالمات",icon:"calls"},
  {id:"settings",label:"الإعدادات",icon:"settings"}
];
export default function Home(){
  const [screen,setScreen]=useState<Screen>("home");
  const [theme,setTheme]=useState<Theme>("system");
  const [ready,setReady]=useState(false);
  const [permission,setPermission]=useState("ask");
  const [compact,setCompact]=useState(false);
  useEffect(()=>{
    const saved=localStorage.getItem("safwan-theme");
    if(saved==="light"||saved==="dark"||saved==="system") setTheme(saved);
    setCompact(localStorage.getItem("safwan-compact")==="true");
    const savedPermission=localStorage.getItem("safwan-permission");
    if(savedPermission==="ask"||savedPermission==="review")setPermission(savedPermission);
    setReady(true);
  },[]);
  useEffect(()=>{
    if(!ready)return;
    const media=window.matchMedia("(prefers-color-scheme: dark)");
    const apply=()=>document.documentElement.dataset.theme=theme==="system"?(media.matches?"dark":"light"):theme;
    apply();media.addEventListener("change",apply);
    localStorage.setItem("safwan-theme",theme);
    return()=>media.removeEventListener("change",apply);
  },[theme,ready]);
  useEffect(()=>{
    if(!ready)return;
    localStorage.setItem("safwan-compact",String(compact));
    document.documentElement.dataset.compact=String(compact);
  },[compact,ready]);
  useEffect(()=>{if(ready)localStorage.setItem("safwan-permission",permission)},[permission,ready]);
  const headline: Record<Screen,string>={home:"المحادثات",tasks:"المهام",files:"الملفات",calls:"المكالمات",settings:"الإعدادات"};
  return <div className="app">
    <aside className="sidebar" aria-label="القائمة الرئيسية">
      <button className="brand" onClick={()=>setScreen("home")} aria-label="العودة للرئيسية"><span className="brand-symbol" aria-hidden="true"><span className="brand-monogram">S</span></span><span><strong>صفوان</strong><small>المساعد الذكي</small></span></button>
      <div className="nav-list">{nav.map(item=><button key={item.id} className={"nav-item "+(screen===item.id?"selected":"")} onClick={()=>setScreen(item.id)} aria-current={screen===item.id?"page":undefined}><span className="nav-icon" aria-hidden="true"><AppIcon name={item.icon} /></span>{item.label}</button>)}</div>
      <div className="sidebar-foot"><span className="state-indicator"/> النسخة التأسيسية <small>الخدمات غير متصلة</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="wordmark"><span className="brand-symbol small" aria-hidden="true"><span className="brand-monogram">S</span></span><span>مساعد صفوان الذكي</span></div><span className="private-label">نسخة تجريبية محلية</span></header>
      <main className="content">
        <div className="page-top"><span className="eyebrow">SAFWAN INTELLIGENCE / WORKSPACE</span><h1>{headline[screen]}</h1></div>
        {screen==="home"&&<div className="home-view"><ChatWorkspace /></div>}
        {screen==="settings"&&<div className="settings-view">
          <div className="settings-intro">خصّص تجربة مساعد صفوان. تُحفظ إعدادات العرض على هذا الجهاز فقط، ولا توجد مزامنة أو حساب متصل حالياً.</div><section className="settings-overview" aria-label="حالة التطبيق"><span className="settings-overview-mark" aria-hidden="true">S</span><div><strong>مساعد صفوان الذكي</strong><small>معاينة التصميم • الخدمات الذكية غير متصلة</small></div></section>
          <section className="setting-card"><h2>المظهر</h2><p>اختر المظهر المناسب، أو دع النظام يحدد الوضع تلقائياً.</p><div className="theme-options" role="group" aria-label="المظهر">
            {([{id:"system",label:"تلقائي",symbol:"◐"},{id:"light",label:"فاتح",symbol:"☼"},{id:"dark",label:"داكن",symbol:"☾"}] as const).map(opt=><button aria-pressed={theme===opt.id} className={"theme-option "+(theme===opt.id?"active":"")} key={opt.id} onClick={()=>setTheme(opt.id)}><span>{opt.symbol}</span>{opt.label}</button>)}
          </div><label className="switch-row"><span><strong>عرض مدمج</strong><small>تقليل المسافات بين عناصر الواجهة</small></span><input type="checkbox" checked={compact} onChange={e=>setCompact(e.target.checked)}/></label></section>
          <section className="setting-card"><h2>سياسة المهام الافتراضية</h2><p>سيظل المساعد يطلب تحديد الصلاحية عند بداية كل مهمة قبل التنفيذ.</p><div className="field"><label htmlFor="permission">التفضيل عند فتح مهمة جديدة</label><select id="permission" value={permission} onChange={e=>setPermission(e.target.value)}><option value="ask">اسألني في كل مهمة</option><option value="review">اقترح المراجعة أولاً</option></select></div><p className="field-note">لا تمنح هذه الإعدادات تصريحاً بتنفيذ عمليات مالية أو حساسة.</p></section>
          <section className="setting-card"><h2>الصوت واللغة</h2><div className="setting-line"><span><strong>لغة الواجهة</strong><small>العربية — من اليمين إلى اليسار</small></span><span className="muted">العربية</span></div><div className="setting-line"><span><strong>المحادثة المباشرة</strong><small>اختبار التقاط الكلام متاح؛ الرد الصوتي ينتظر الخادم والمصادقة</small></span><span className="pending">غير مفعّلة</span></div></section>
          <section className="setting-card"><h2>الخصوصية والأجهزة</h2><div className="setting-line"><span><strong>Windows السحابي</strong><small>لم يتم ربط الكمبيوتر بعد</small></span><span className="pending">غير متصل</span></div><div className="setting-line"><span><strong>حساب المستخدم</strong><small>المصادقة الآمنة قيد التطوير</small></span><span className="pending">غير مهيأ</span></div></section>
        </div>}
        {(screen==="tasks"||screen==="files"||screen==="calls")&&<section className="feature-page" aria-label={headline[screen]}>
          <div className="feature-banner"><span className="feature-badge">تصميم أولي — غير متصل بالخدمات</span><div className="feature-banner-row"><div><h2>{screen==="tasks"?"مساحة عملك اليومية":screen==="files"?"مكتبة ملفاتك":"مركز التواصل"}</h2><p>{screen==="tasks"?"نظّم أولوياتك وتابع الأعمال من مكان واحد.":screen==="files"?"الوصول إلى المستندات وفرزها من واجهة واضحة.":"راجع المكالمات وجدول المحادثات الصوتية في واجهة واحدة."}</p></div><span className="feature-banner-icon"><AppIcon name={screen} width={32} height={32}/></span></div></div>
          {screen==="tasks"&&<div className="feature-card-grid"><article className="feature-card"><span className="feature-card-label">ملخص المهام</span><strong>لا توجد مهام متصلة</strong><p>ستظهر مهام اليوم والمتأخرة والقادمة بعد تفعيل التخزين.</p></article><article className="feature-card"><span className="feature-card-label">عرض الجدول</span><strong>التخطيط اليومي</strong><p>مساحة لعرض المواعيد والأولويات القادمة.</p></article><article className="feature-card"><span className="feature-card-label">حالة النظام</span><strong>بانتظار الربط</strong><p>إنشاء المهام وتعديلها غير مفعّل في هذه النسخة.</p></article></div>}
          {screen==="files"&&<div className="feature-card-grid"><article className="feature-card"><span className="feature-card-label">المكتبة</span><strong>المستندات</strong><p>عرض ملفات PDF والوثائق بعد توفير اتصال آمن.</p></article><article className="feature-card"><span className="feature-card-label">التصنيف</span><strong>المجلدات والمفضلة</strong><p>تنظيم الملفات والبحث عنها في واجهة موحّدة.</p></article><article className="feature-card"><span className="feature-card-label">حالة النظام</span><strong>لا يوجد تخزين مرتبط</strong><p>رفع الملفات والمزامنة غير مفعّلين حالياً.</p></article></div>}
          {screen==="calls"&&<div className="feature-card-grid"><article className="feature-card"><span className="feature-card-label">المحادثة الصوتية</span><strong>مكالمات المساعد</strong><p>سيظهر هنا سجل المكالمات بعد تفعيل الخدمة.</p></article><article className="feature-card"><span className="feature-card-label">الإعدادات</span><strong>الميكروفون والسماعة</strong><p>معاينة مكان أدوات التحكم بالمكالمات المستقبلية.</p></article><article className="feature-card"><span className="feature-card-label">حالة النظام</span><strong>المكالمات غير مفعّلة</strong><p>الإملاء في شاشة المحادثة متاح حسب دعم المتصفح.</p></article></div>}
          <div className="feature-footer"><AppIcon name={screen} width={23} height={23}/><span>هذه معاينة للواجهة فقط. لا يتم حفظ أو تنفيذ بيانات في هذا القسم.</span></div>
        </section>}
      </main>
      <nav className="bottom-nav" aria-label="التنقل السفلي">{nav.map(item=><button key={item.id} aria-current={screen===item.id?"page":undefined} className={screen===item.id?"active":""} onClick={()=>setScreen(item.id)}><span aria-hidden="true"><AppIcon name={item.icon} /></span><small>{item.label}</small></button>)}</nav>
    </div>
  </div>;
}
