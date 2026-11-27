"use client";
/**
 * «الاستهلاك» (B5) inside the model panel: this conversation's tokens and cost, and BASHT's 30-day totals, as the engine records
 * them (sessions.usage / usage.cost). Read once when the panel opens; hidden when the engine does not report usage. A model without
 * pricing makes the cost "غير معروفة", never $0.
 */
import { useEffect, useState } from "react";
import { controlClient, formatCost, formatTokens, type Usage } from "@/lib/basht-control";

export default function UsageRow() {
  const [u, setU] = useState<Usage | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    controlClient.usage().then((x) => { if (live) { if (!x.app && !x.all) setHidden(true); else setU(x); } }).catch(() => { if (live) setHidden(true); });
    return () => { live = false; };
  }, []);
  if (hidden) return null;
  if (!u) return <small className="muted">جارٍ قراءة الاستهلاك…</small>;
  const days = u.all?.daily ?? [];
  const peak = Math.max(1, ...days.map((d) => d.tokens));
  return (
    <section className="card card-pad stack" style={{ gap: 6 }} aria-labelledby="usage-h">
      <strong id="usage-h">الاستهلاك</strong>
      <div className="ctl-usage">
        {u.app && <>
          <span>هذه المحادثة · 30 يومًا</span><bdi className="num" dir="ltr">{formatTokens(u.app.tokens)}</bdi><bdi className="num" dir="ltr">{formatCost(u.app.cost, u.app.cost_partial && u.app.cost != null)}</bdi>
          {u.app.today && <><span>هذه المحادثة · اليوم</span><bdi className="num" dir="ltr">{formatTokens(u.app.today.tokens)}</bdi><bdi className="num" dir="ltr">{formatCost(u.app.today.cost, u.app.today.cost_partial && u.app.today.cost != null)}</bdi></>}
        </>}
        {u.all && <>
          <span>كل باشت · اليوم</span><bdi className="num" dir="ltr">{formatTokens(u.all.today?.tokens ?? 0)}</bdi><bdi className="num" dir="ltr">{formatCost(u.all.today?.cost ?? null, !!u.all.today?.cost_partial && u.all.today?.cost != null)}</bdi>
          <span>كل باشت · {u.all.days ?? 30} يومًا</span><bdi className="num" dir="ltr">{formatTokens(u.all.tokens)}</bdi><bdi className="num" dir="ltr">{formatCost(u.all.cost, u.all.cost_partial && u.all.cost != null)}</bdi>
        </>}
      </div>
      {days.length > 1 && (
        <div className="ctl-spark" role="img" aria-label={`استهلاك باشت اليومي لآخر ${days.length} يومًا`}>
          {days.map((d) => <i key={d.date} title={`${d.date}: ${formatTokens(d.tokens)}`} style={{ blockSize: `${Math.max(4, Math.round((d.tokens / peak) * 100))}%` }} />)}
        </div>
      )}
      <small className="muted">الأرقام بالرموز (tokens) كما سجّلها محرك باشت.{u.missing_cost_models.length > 0 && <> التكلفة غير معروفة لنموذج بلا تسعير: <bdi dir="ltr">{u.missing_cost_models.join(", ")}</bdi>.</>}</small>
    </section>
  );
}
