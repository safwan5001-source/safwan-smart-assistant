"use client";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice, PageHeader, VoiceOrb } from "@/components/ui";
import { VOICE_TEXT, voiceState } from "@/lib/voice-state";
import { useDictation } from "@/lib/speech";
import { useStore } from "@/lib/hooks";
import { earcon, voiceFxStore } from "@/lib/earcons";

/** The voice session, opened as a panel INSIDE the conversation (/chat?voice=1): the transcript goes into the same composer. */
export default function VoicePanel({ onUse }: { onUse: (text: string) => void }) {
  const d = useDictation();
  const [text, setText] = useState("");
  const fx = useStore(voiceFxStore);
  const state = voiceState(d);
  const wasListening = useRef(false);
  // the engine can end on its own (silence): play the stop cue for that too
  useEffect(() => { if (wasListening.current && !d.listening && fx) earcon("stop"); wasListening.current = d.listening; }, [d.listening, fx]);

  const toggle = () => {
    if (d.listening) { d.stop(); return; }
    if (fx) earcon("start");
    d.start(text, setText, true);
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader icon="wave" eyebrow="الصوت" title="الجلسة الصوتية" description="تحدّث مع باشت بصوتك. المتاح الآن: إملاء عربي يحوّل كلامك إلى نص ترسله للمحادثة. الرد الصوتي المباشر والمكالمات لم تُفعَّل بعد." />

      <section className="voice" data-state={state} aria-labelledby="voice-h">
        <div className="voice-orb">
          <span className="voice-halo" aria-hidden="true" /><span className="voice-halo" aria-hidden="true" />
          <VoiceOrb state={state} />
        </div>
        <div className="voice-bars" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</div>
        <div className="stack" style={{ gap: 4, justifyItems: "center" }}>
          <h2 id="voice-h" className="voice-label" role="status">{VOICE_TEXT[state].title}</h2>
          <p className="voice-sub">{VOICE_TEXT[state].sub}</p>
        </div>
        <div className="voice-states" aria-label="حالات الجلسة">
          <span aria-current={state === "ready" ? "true" : undefined}>الميكروفون جاهز</span>
          <span aria-current={state === "listening" ? "true" : undefined}>تسجيل الكلام</span>
          <span>ردّ باشت الصوتي · قريبًا</span>
        </div>
        <div className="voice-actions">
          <button className="voice-side" onClick={() => { d.abort(); setText(""); d.clearError(); }} disabled={!text && !d.listening} aria-label="مسح النص وإلغاء"><Icon name="trash" size={20} /></button>
          <button className="voice-main" onClick={toggle} disabled={!d.supported} aria-pressed={d.listening} aria-label={d.listening ? "إيقاف الاستماع" : "بدء الاستماع"}>
            <Icon name={d.listening ? "stop" : "mic"} size={30} />
          </button>
          <button className="voice-side" onClick={() => voiceFxStore.set(!fx)} aria-pressed={fx} aria-label={fx ? "إيقاف المؤثرات الصوتية" : "تشغيل المؤثرات الصوتية"} title="مؤثرات صوتية عند البدء والإيقاف"><Icon name="volume" size={20} /></button>
        </div>
      </section>

      <section className="card card-pad stack" aria-labelledby="tr-h">
        <div className="section-head"><h2 id="tr-h"><Icon name="doc" size={18} />النص</h2><Badge tone={d.supported ? "ok" : "warn"}>{d.supported ? "الإملاء مدعوم" : "غير مدعوم"}</Badge></div>
        <div className="transcript" aria-live="polite" aria-label="نص الكلام">{text || <span className="muted">سيظهر نص كلامك هنا.</span>}</div>
        {d.error && <Notice tone="danger" role="alert">{d.error}</Notice>}
        <div className="row-wrap">
          <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => { const t = text.trim(); if (!t) return; d.abort(); onUse(t); }}>
            <Icon name="send" size={18} style={{ transform: "scaleX(-1)" }} />راجع وأرسل لباشت
          </button>
        </div>
        <small className="muted">تفريغ صوتي فقط: يُفتح النص في المحادثة لتراجعه قبل الإرسال. قد يعالج المتصفح (أو مزوّده) الصوت عبر خدمة خارجية.</small>
      </section>

      <section className="grid grid-md-2" aria-label="قدرات قادمة">
        {([["calls", "مكالمات صادرة وواردة", "تتطلب مزود اتصالات يدعم أرقام السعودية؛ لم يُختر بعد."], ["spark", "الرد الصوتي المباشر", "باشت يرد بصوته ويمكن مقاطعته؛ يتطلب خادمًا ومزوّد نماذج صوتية."]] as const).map(([icon, title, sub]) => (
          <div key={title} className="card card-pad row"><span className="file-ico"><Icon name={icon} size={22} /></span><span style={{ flex: 1 }}><strong>{title}</strong><small className="muted" style={{ display: "block" }}>{sub}</small></span><Badge>قريبًا</Badge></div>
        ))}
      </section>
    </div>
  );
}
