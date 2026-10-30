const modules = [
  { title: "المهام", description: "إدارة العمل والموافقات" },
  { title: "الكمبيوتر السحابي", description: "الربط بمحرك Windows غير مفعل بعد" },
  { title: "المكالمات", description: "بانتظار تهيئة خدمة الاتصالات" },
  { title: "الملفات", description: "قراءة المستندات وتنظيمها" },
];
export default function Home() {
  return <main className="shell"><div className="eyebrow">SAFWAN · PERSONAL AI</div><h1>مساعد صفوان الذكي</h1><p className="intro">مساحة العمل الشخصية — نموذج الواجهة الأولي. لم تُفعّل الأوامر أو المكالمات بعد.</p>
    <section className="status" aria-label="حالة النظام"><span className="dot" /> وضع العرض فقط — لا يوجد اتصال بخادم التنفيذ</section>
    <section className="cards">{modules.map(m => <article className="card" key={m.title}><h2>{m.title}</h2><p>{m.description}</p></article>)}</section>
    <section className="notice"><h2>الصوت المباشر</h2><p>سيُضاف بعد إنشاء جلسات آمنة ومصادقة. هذه الواجهة لا تستمع أو ترسل بيانات حالياً.</p></section>
  </main>;
}
