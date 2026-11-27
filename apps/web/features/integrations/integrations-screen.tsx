"use client";
import { useMemo, useState } from "react";
import Icon from "@/components/icon";
import IntegrationLogo from "@/components/integration-logo";
import Modal from "@/components/modal";
import { Badge, Empty, Notice, PageHeader } from "@/components/ui";
import { CATEGORY_LABEL, INTEGRATIONS, STATUS_LABEL, type IntegrationDef, type IntegrationStatus } from "@/lib/integrations";
import { MODES, MODE_LABEL, RISKS, RISK_LABEL, VERDICT_LABEL, evaluate, type Risk } from "@/lib/permissions";
import { matches } from "@/lib/search";
import { useUrlQuery } from "@/lib/hooks";
import BashtCapabilities from "./basht-capabilities";

const statusTone = (s: IntegrationStatus) => (s === "connected" ? "ok" : s === "configured_unverified" ? "warn" : undefined);
const riskTone = (r: Risk) => (r === "sensitive" ? "danger" : r === "write" ? "warn" : "info");

export default function IntegrationsScreen() {
  const items = INTEGRATIONS;
  const [query, setQuery] = useState("");
  useUrlQuery(setQuery);
  const [category, setCategory] = useState("all");
  const [detail, setDetail] = useState<IntegrationDef | null>(null);

  const categories = useMemo(() => ["all", ...Array.from(new Set(items.map((i) => i.category)))], [items]);
  const shown = items.filter((i) => (category === "all" || i.category === category) && matches(i.name + " " + i.description + " " + (CATEGORY_LABEL[i.category] ?? ""), query));
  const connected = items.filter((i) => i.status === "connected").length;

  return (
    <div className="page">
      <PageHeader icon="integrations" eyebrow="التكاملات" title="التكاملات والصلاحيات" description="ما يستطيعه باشت الآن كما يقرؤه التطبيق من المحرك مباشرة، ثم الخدمات المخطط ربطها بالتطبيق نفسه. لا تطلب هذه الشاشة رموز وصول." />
      <BashtCapabilities />

      <details className="ctl-details card card-pad" open={!!query}>
        <summary><strong>ربط مباشر من التطبيق (قيد التخطيط)</strong> <small className="muted num">{connected} من {items.length} متصلة</small></summary>
      <Notice tone="warn">هذه خدمات مخطط أن يتصل بها التطبيق نفسه، ولا يوجد أي اتصال فعلي منها بعد. ما يستطيعه باشت عبر مهاراته وأدواته (مثل دفترة) يظهر أعلاه.</Notice>

      <div className="stack">
        <div className="search"><Icon name="search" size={18} /><input className="input" type="search" aria-label="ابحث عن خدمة" placeholder="ابحث عن خدمة…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="chips" role="group" aria-label="تصفية حسب الفئة">
          {categories.map((c) => <button key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{c === "all" ? "الكل" : CATEGORY_LABEL[c] ?? c}</button>)}
        </div>
      </div>

      {shown.length ? (
        <ul className="grid grid-md-2 grid-lg-3">
          {shown.map((i) => (
            <li key={i.id}>
              <button className="card int-card" onClick={() => setDetail(i)} aria-haspopup="dialog" aria-label={`${i.name} — ${STATUS_LABEL[i.status].label}. عرض التفاصيل`}>
                <span className="int-head"><IntegrationLogo integration={i} /><Badge tone={statusTone(i.status)}>{STATUS_LABEL[i.status].label}</Badge></span>
                <strong>{i.name}</strong>
                <small className="muted">{CATEGORY_LABEL[i.category] ?? i.category}</small>
                <span className="muted" style={{ fontSize: 13.5 }}>{i.description}</span>
                <span className="row-wrap">{(["read", "write", "sensitive"] as Risk[]).filter((r) => i.scopes.some((s) => s.risk === r)).map((r) => <Badge key={r} tone={riskTone(r)}>{RISK_LABEL[r]}</Badge>)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="card"><Empty icon="search" title="لا خدمات مطابقة">جرّب كلمة أخرى أو غيّر الفئة.</Empty></div>}
      </details>

      <section className="card card-pad stack" aria-labelledby="policy-h">
        <div><h2 id="policy-h">كيف تُدار الصلاحيات؟</h2><p className="muted" style={{ fontSize: 14 }}>يُحدَّد نمط كل مهمة في بدايتها، ويُصنَّف كل إجراء حسب خطورته. العمليات الحساسة (تحويل أموال، إرسال، حذف واسع) تحتاج موافقة صريحة خاصة بها مهما كان النمط.</p></div>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">مصفوفة الصلاحيات: نمط المهمة مقابل خطورة الإجراء</caption>
            <thead><tr><th scope="col">نمط المهمة</th>{RISKS.map((r) => <th scope="col" key={r}>{RISK_LABEL[r]}</th>)}</tr></thead>
            <tbody>
              {MODES.map((m) => (
                <tr key={m}>
                  <th scope="row" style={{ background: "transparent", color: "var(--text)", fontSize: 13.5 }}>{MODE_LABEL[m].title}</th>
                  {RISKS.map((r) => { const v = evaluate(m, r); return <td key={r}><Badge tone={v === "allow" ? "ok" : v === "deny" ? "danger" : "warn"}>{VERDICT_LABEL[v]}</Badge></td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={!!detail} onClose={() => setDetail(null)} label={detail ? detail.name : "تفاصيل"}>
        {detail && (
          <div className="dialog-card">
            <div className="row"><IntegrationLogo integration={detail} /><div style={{ flex: 1 }}><h2>{detail.name}</h2><small className="muted">{CATEGORY_LABEL[detail.category]}</small></div><button className="icon-btn" onClick={() => setDetail(null)} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>
            <p>{detail.description}</p>
            <div className="status-line" style={{ padding: 0, border: 0 }}><span><strong>الحالة</strong><small>{STATUS_LABEL[detail.status].hint}</small></span><Badge tone={statusTone(detail.status)}>{STATUS_LABEL[detail.status].label}</Badge></div>
            <div><h3 style={{ marginBlockEnd: 6 }}>الصلاحيات المطلوبة</h3>
              <ul className="scope-list">{detail.scopes.map((s) => <li key={s.title}><span>{s.title}</span><Badge tone={riskTone(s.risk)}>{RISK_LABEL[s.risk]}</Badge></li>)}</ul></div>
            <Notice>الربط غير متاح بعد. عند توفره ستُحفظ بيانات الاعتماد على الخادم فقط، ولن تُعرض ولن تُخزَّن في المتصفح.</Notice>
            <div className="dialog-actions"><button className="btn btn-primary" disabled title="غير متاح بعد">ربط الخدمة (غير متاح)</button><button className="btn" onClick={() => setDetail(null)}>إغلاق</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
