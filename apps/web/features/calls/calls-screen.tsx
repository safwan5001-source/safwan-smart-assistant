"use client";
import { useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice, PageHeader } from "@/components/ui";
import { useDictation } from "@/lib/speech";

export default function CallsScreen() {
  const d = useDictation();
  const [text, setText] = useState("");
  return (
    <div className="page">
      <PageHeader eyebrow="المكالمات" title="المحادثة الصوتية" description="المكالمات الصادرة والواردة والرد الصوتي المباشر غير مفعّلة بعد. المتاح الآن اختبار الإملاء العربي بالميكروفون." />
      <section className="card card-pad stack" aria-labelledby="mic-h">
        <div className="section-head"><h2 id="mic-h">اختبار الإملاء</h2><Badge tone={d.supported ? "ok" : "warn"}>{d.supported ? "مدعوم في هذا المتصفح" : "غير مدعوم"}</Badge></div>
        <div className="row-wrap">
          <button className={"btn " + (d.listening ? "btn-danger" : "btn-primary")} disabled={!d.supported} aria-pressed={d.listening}
            onClick={() => (d.listening ? d.stop() : d.start(text, setText, true))}>
            <Icon name={d.listening ? "stop" : "mic"} size={18} />{d.listening ? "إيقاف الاستماع" : "بدء الاستماع"}
          </button>
          <button className="btn" onClick={() => { d.abort(); setText(""); d.clearError(); }} disabled={!text && !d.listening}>مسح النص</button>
        </div>
        <p role="status" className="muted" style={{ fontSize: 14 }}>{d.listening ? "الميكروفون يعمل — تحدّث بالعربية." : "اضغط «بدء الاستماع» ثم تحدّث."}</p>
        <div className="card card-pad" aria-label="نص الكلام" style={{ minHeight: 84, background: "var(--surface-2)", overflowWrap: "anywhere" }}>{text || <span className="muted">سيظهر نص كلامك هنا.</span>}</div>
        {d.error && <Notice tone="danger" role="alert">{d.error}</Notice>}
        <small className="muted">تفريغ صوتي فقط: لا رد ذكي ولا تنفيذ أوامر. قد يعالج المتصفح (أو مزوّده) الصوت عبر خدمة خارجية.</small>
      </section>
      <section className="grid grid-md-2" aria-label="قدرات قادمة">
        {[["calls", "مكالمات صادرة وواردة", "تتطلب مزود اتصالات يدعم أرقام السعودية؛ لم يُختر بعد."], ["spark", "المحادثة الصوتية المباشرة", "ردّ صوتي قابل للمقاطعة؛ يتطلب خادماً ومزوّد نماذج."]].map(([icon, title, sub]) => (
          <div key={title} className="card card-pad row"><span className="file-ico"><Icon name={icon as "calls"} size={22} /></span><span style={{ flex: 1 }}><strong>{title}</strong><small className="muted" style={{ display: "block" }}>{sub}</small></span><Badge>قريباً</Badge></div>
        ))}
      </section>
    </div>
  );
}
