"use client";
/**
 * «حالة النظام» (R11): every badge here is the result of a function in lib/status-model.ts applied to a REAL source — the app's health,
 * the engine's own /status, what a real voice call learned, this device's push registration. Nothing is typed by hand, and "no data"
 * reads «غير معروف» with no success colour. The old direct-Claude key is not a source of any indicator here.
 */
import { useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge } from "@/components/ui";
import { useAssistant } from "@/components/assistant-context";
import { voiceAvailability, useVoiceAvailability } from "@/lib/basht-voice";
import { relative } from "@/lib/basht-control";
import { engineStatusStore, useEngineStatus } from "@/lib/engine-status-store";
import { getPushState, type PushState } from "@/lib/push-client";
import { ATTACHMENT_KEYS } from "@/lib/engine-status";
import { checkedText, readApprovals, readEngine, readPush, readServer, readVoice, readingLabel, statusIcon, statusTone, type EngineSnapshot, type StatusReading } from "@/lib/status-model";

/** One badge: icon + text, never colour alone. */
export function StatusBadge({ r }: { r: StatusReading }) {
  return <Badge tone={statusTone(r.level)}><Icon name={statusIcon(r.level)} size={13} />{readingLabel(r)}</Badge>;
}

/** The readings the settings and dashboard show, from the shared sources. `push` is read only when `withPush` (it asks the browser). */
export function useReadings(withPush = false) {
  const { status, refresh, checkedAt } = useAssistant();
  const snap = useEngineStatus(status.server === "online" && status.bashtChat);
  const learned = useVoiceAvailability();
  const [push, setPush] = useState<{ state: PushState | "loading"; at: number | null }>({ state: "loading", at: null });
  useEffect(() => {
    if (!withPush) return;
    let live = true;
    void getPushState().then((state) => live && setPush({ state, at: Date.now() }));
    return () => { live = false; };
  }, [withPush, checkedAt]);
  // "now" for the «قبل N» text: advances only when something is re-read, never on a timer
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [checkedAt, snap.at, push.at]);

  const server = readServer(status, checkedAt);
  const engine = readEngine(status, checkedAt, snap);
  const voice = readVoice(snap, { speak: learned.speak, reason: learned.reason || "", at: voiceAvailability.speakCheckedAt() });
  const pushReading = readPush(push.state, push.at);
  const approvals = readApprovals(snap);
  const recheck = () => { refresh(); void engineStatusStore.refresh({ force: true }); if (withPush) void getPushState().then((state) => setPush({ state, at: Date.now() })); };
  return { status, snap, now, server, engine, voice, push: pushReading, approvals, recheck };
}

export function StatusRow({ title, r, now, hint }: { title: string; r: StatusReading; now: number; hint?: string }) {
  const sub = [r.detail ?? hint, checkedText(r.checkedAt, now, relative)].filter(Boolean).join(" · ");
  return (
    <div className="status-line">
      <span><strong>{title}</strong><small>{sub}</small></span>
      <StatusBadge r={r} />
    </div>
  );
}

const MB = 1024 * 1024;
const mb = (n: number) => `${Math.round((n / MB) * 10) / 10} ميجابايت`;
const ATTACH_LABEL: Record<(typeof ATTACHMENT_KEYS)[number], (n: number) => string> = {
  maxImages: (n) => `حتى ${n} صور في الرسالة`, maxImageBytes: (n) => `الصورة الواحدة حتى ${mb(n)}`, maxTotalImageBytes: (n) => `الصور معًا حتى ${mb(n)}`,
  maxFileBytes: (n) => `الملف الذي يرسله باشت حتى ${mb(n)}`, maxInlineBytes: (n) => `الصورة المضمّنة حتى ${mb(n)}`,
};
const LINK_TEXT = { off: "غير مفعّل", connecting: "يتصل", up: "متصل", down: "منقطع", unknown: "غير معروف" } as const;
const SIGNING_TEXT = { off: "معطّل", optional: "اختياري", required: "إلزامي", unknown: "غير معروف" } as const;

/** What the engine itself reported (only what it sent; absent fields are not shown). Never an id, a path or a log line. */
export function EngineDetails({ snap }: { snap: EngineSnapshot }) {
  const s = snap.status;
  if (!s || !s.reachable) return <small className="muted">لا بيانات من المحرك الآن.</small>;
  const rows: [string, string][] = [];
  if (s.version) rows.push(["إصدار المحرك", s.version]);
  if (s.commit) rows.push(["بناء الواجهة الوسيطة", s.commit]);
  if (s.link.state !== "unknown") rows.push(["الاتصال الداخلي", LINK_TEXT[s.link.state]]);
  if (s.signing.mode !== "unknown") rows.push(["توقيع الطلبات", SIGNING_TEXT[s.signing.mode] + (s.signing.active === false ? " (غير فعّال)" : "")]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.length > 0 && <ul className="eng-kv">{rows.map(([k, v]) => <li key={k}><span>{k}</span><bdi dir="ltr" className="num">{v}</bdi></li>)}</ul>}
      {ATTACHMENT_KEYS.some((k) => s.attachments[k] !== undefined) && (
        <div className="stack" style={{ gap: 4 }}><strong style={{ fontSize: 13.5 }}>حدود المرفقات</strong>
          <ul className="eng-kv">{ATTACHMENT_KEYS.filter((k) => s.attachments[k] !== undefined).map((k) => <li key={k}><span>{ATTACH_LABEL[k](s.attachments[k] as number)}</span></li>)}</ul></div>
      )}
      {s.features.length > 0 && (
        <div className="stack" style={{ gap: 4 }}><strong style={{ fontSize: 13.5 }}>القدرات المعلنة</strong>
          <ul className="ctl-chips">{s.features.map((f) => <li key={f}><bdi dir="ltr">{f}</bdi></li>)}</ul></div>
      )}
    </div>
  );
}

export default function SystemStatus() {
  const { status, snap, now, server, engine, voice, push, approvals, recheck } = useReadings(true);
  const engineOn = status.server === "online" && (status.bashtChat || status.basht !== "unconfigured");
  return (
    <section className="card card-pad" aria-labelledby="sys-h">
      <div className="section-head"><h2 id="sys-h">حالة النظام</h2><button className="btn" onClick={recheck}><Icon name="repeat" size={16} />إعادة الفحص</button></div>
      <div style={{ marginBlockStart: 6 }}>
        <StatusRow title="الخادم" r={server} now={now} />
        <StatusRow title="جاهزية باشت" r={engine} now={now} />
        <StatusRow title="الصوت" r={voice} now={now} hint="النطق والاستماع عبر المحرك" />
        <StatusRow title="الموافقات" r={approvals} now={now} hint="طلبات تنتظر قرارك على المحرك" />
        <StatusRow title="الإشعارات" r={push} now={now} />
      </div>
      {engineOn && (
        <details className="ctl-details" style={{ marginBlockStart: 8 }}>
          <summary className="tall"><strong>تفاصيل المحرك</strong></summary>
          <EngineDetails snap={snap} />
        </details>
      )}
    </section>
  );
}
