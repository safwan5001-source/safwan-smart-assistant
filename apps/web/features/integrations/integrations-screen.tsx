"use client";
import { Badge, PageHeader } from "@/components/ui";
import { MODES, MODE_LABEL, RISKS, RISK_LABEL, VERDICT_LABEL, evaluate } from "@/lib/permissions";
import BashtCapabilities from "./basht-capabilities";

/**
 * «التكاملات والصلاحيات»: what BASHT can do right now is read live from the engine (BashtCapabilities); nothing is listed here from a
 * hand-written catalogue. A service the engine does not report is simply absent, never "planned" or "not connected".
 */
export default function IntegrationsScreen() {
  return (
    <div className="page">
      <PageHeader icon="integrations" eyebrow="التكاملات" title="التكاملات والصلاحيات" description="ما يستطيعه باشت الآن كما يقرؤه التطبيق من المحرك مباشرة، وكيف تُدار الصلاحيات. لا تطلب هذه الشاشة رموز وصول." />
      <BashtCapabilities />

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

    </div>
  );
}
