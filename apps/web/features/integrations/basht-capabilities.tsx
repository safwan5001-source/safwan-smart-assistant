"use client";
/**
 * «ما يستطيعه باشت الآن» (B7): live, read-only status from the engine — channels (WhatsApp linked/connected), skills ready or
 * missing requirements, the tools this app conversation really has, and enabled plugins. No toggles: installs and changes happen
 * in the OpenClaw Control UI (they also change BASHT on WhatsApp).
 */
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge, ListSkeleton, Notice } from "@/components/ui";
import { bashtClient, BashtError } from "@/lib/basht-client";
import { channelIssueText, channelState, controlClient, isUnavailable, missingText, relative, toolGroupLabel, type Capabilities } from "@/lib/basht-control";

type View = "loading" | "off" | "unavailable" | "ready" | "error";

export default function BashtCapabilities() {
  const [view, setView] = useState<View>("loading");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const load = useCallback(async () => {
    const s = await bashtClient.status();
    if (!s.enabled || !s.authenticated) { setView("off"); return; }
    try { setCaps(await controlClient.capabilities()); setView("ready"); }
    catch (e) { setView(isUnavailable(e) ? "unavailable" : e instanceof BashtError && e.code === "unauthorized" ? "off" : "error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="stack" aria-labelledby="caps-h" style={{ gap: 10 }}>
      <div className="section-head">
        <h2 id="caps-h"><Icon name="spark" size={18} />ما يستطيعه باشت الآن</h2>
        {view !== "off" && view !== "unavailable" && <button className="btn btn-sm" onClick={() => { setView("loading"); void load(); }}><Icon name="repeat" size={16} />تحديث</button>}
      </div>
      {view === "loading" && <ListSkeleton rows={3} h={80} />}
      {view === "off" && <Notice>سجّل الدخول وفعّل محادثة باشت لعرض حالته الحية.</Notice>}
      {view === "unavailable" && <Notice>عرض قدرات باشت غير متاح في نسخة المحرك الحالية.</Notice>}
      {view === "error" && <Notice tone="warn" role="alert">تعذّرت قراءة حالة باشت الآن. <button className="btn btn-sm" onClick={() => { setView("loading"); void load(); }}>إعادة المحاولة</button></Notice>}
      {view === "ready" && caps && <>
        <div className="card card-pad" aria-label="القنوات">
          <h3 className="ctl-h3"><Icon name="phone" size={16} />القنوات</h3>
          {caps.channels === null ? <small className="muted">تعذّرت قراءة القنوات.</small> : caps.channels.length === 0 ? (
            <div className="status-line"><span><strong>واتساب</strong><small>لا توجد قناة مربوطة بباشت.</small></span><Badge>غير مربوط</Badge></div>
          ) : caps.channels.map((c) => {
            const s = channelState(c);
            return (
              <div key={c.id} className="status-line">
                <span><strong>{c.id === "whatsapp" ? "واتساب" : c.label}</strong>
                  <small>{c.issue ? channelIssueText(c.issue) : c.connected && c.last_connected_at ? `متصل منذ ${relative(c.last_connected_at).replace(/^قبل /, "")}` : c.accounts > 1 ? `${c.accounts} حسابات` : ""}</small></span>
                <Badge tone={c.issue ? "danger" : s.tone}>{s.label}</Badge>
              </div>
            );
          })}
        </div>

        <div className="card card-pad stack" style={{ gap: 8 }} aria-label="المهارات">
          <h3 className="ctl-h3"><Icon name="bolt" size={16} />المهارات {caps.skills && <small className="muted num">{caps.skills.ready.length} جاهزة من {caps.skills.total}</small>}</h3>
          {caps.skills === null ? <small className="muted">تعذّرت قراءة المهارات.</small> : <>
            <ul className="ctl-chips">{caps.skills.ready.map((s) => <li key={s.name} title={s.description ?? undefined}><span aria-hidden="true">{s.emoji ?? "•"}</span><bdi dir="ltr">{s.name}</bdi></li>)}</ul>
            {caps.skills.missing.length > 0 && (
              <details className="ctl-details">
                <summary>تنقصها متطلبات <span className="num">({caps.skills.missing.length})</span></summary>
                <ul className="ctl-list">{caps.skills.missing.map((s) => <li key={s.name}><span><bdi dir="ltr">{s.emoji ? `${s.emoji} ` : ""}{s.name}</bdi></span><small className="muted">{missingText(s.missing)}</small></li>)}</ul>
              </details>
            )}
            {caps.skills.unavailable.length > 0 && <small className="muted">{caps.skills.unavailable.length} مهارة معطّلة أو غير متوافقة مع هذا الخادم.</small>}
          </>}
        </div>

        <div className="card card-pad stack" style={{ gap: 8 }} aria-label="الأدوات">
          <h3 className="ctl-h3"><Icon name="target" size={16} />أدوات هذه المحادثة {caps.tools && <small className="muted num">{caps.tools.count} أداة</small>}</h3>
          {caps.tools === null ? <small className="muted">تعذّرت قراءة الأدوات.</small> : caps.tools.groups.map((g) => (
            <div key={g.id} className="ctl-group">
              <strong>{toolGroupLabel(g.id, g.label)}</strong>
              <ul className="ctl-chips">{g.tools.map((t) => <li key={t.id}><bdi dir="ltr">{t.label}</bdi></li>)}</ul>
            </div>
          ))}
          <small className="muted">هذه هي الأدوات المتاحة فعلًا لمحادثة التطبيق حسب سياسة باشت؛ بعضها يطلب موافقتك قبل التنفيذ.</small>
        </div>

        <div className="card card-pad stack" style={{ gap: 8 }} aria-label="الإضافات">
          <h3 className="ctl-h3"><Icon name="integrations" size={16} />الإضافات {caps.plugins && <small className="muted num">{caps.plugins.enabled.length} مفعّلة</small>}</h3>
          {caps.plugins === null ? <small className="muted">تعذّرت قراءة الإضافات.</small> : <>
            {caps.plugins.failed.length > 0 && <Notice tone="warn">إضافات متعطلة: <bdi dir="ltr">{caps.plugins.failed.map((p) => p.name).join(", ")}</bdi></Notice>}
            <details className="ctl-details"><summary>المفعّلة</summary><ul className="ctl-chips">{caps.plugins.enabled.map((p) => <li key={p.id}><bdi dir="ltr">{p.name}</bdi></li>)}</ul></details>
            {caps.plugins.needs_setup.length > 0 && <small className="muted">تحتاج إعدادًا: <bdi dir="ltr">{caps.plugins.needs_setup.map((p) => p.name).join(", ")}</bdi></small>}
          </>}
        </div>
        <Notice>العرض للقراءة فقط. تثبيت المهارات والإضافات وتفعيلها وربط واتساب يتم من واجهة OpenClaw، لأنها تغيّر باشت في كل القنوات.</Notice>
      </>}
    </section>
  );
}
