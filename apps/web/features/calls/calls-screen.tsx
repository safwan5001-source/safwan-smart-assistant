"use client";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice, PageHeader, VoiceOrb } from "@/components/ui";
import { VOICE_TEXT, voiceState, type VoiceState } from "@/lib/voice-state";
import { useDictation } from "@/lib/speech";
import { useStore } from "@/lib/hooks";
import { earcon, voiceFxStore } from "@/lib/earcons";
import { bashtClient, BashtError } from "@/lib/basht-client";
import { clock, MAX_NOTE_MS, primeAudioInput, useVoiceAvailability, usePlayer, useVoiceRecorder, voiceAvailability, voiceNoteText, voicePlayer } from "@/lib/basht-voice";

/** What the live session needs from the conversation: send one owner turn (as a voice note) and get BASHT's reply text back. */
export type LiveVoice = { ready: boolean; ask: (text: string) => Promise<string> };

/**
 * The voice session, opened as a panel INSIDE the conversation (/chat?voice=1).
 * - With BASHT's engine voice: a hands-free turn loop in the SAME conversation (app:owner) — listen → transcribe → send → BASHT
 *   replies → spoken in BASHT's own voice → listen again. Every turn lands in the timeline behind this panel.
 * - Without it (no engine voice, no recording in this browser): browser dictation, whose text goes into the composer for review.
 */
export default function VoicePanel({ onUse, live }: { onUse: (text: string) => void; live?: LiveVoice }) {
  const avail = useVoiceAvailability();
  const rec = useVoiceRecorder();
  const engineVoice = !!live?.ready && rec.supported && avail.transcribe !== "no" && avail.speak !== "no";
  return engineVoice ? <LiveSession live={live!} rec={rec} /> : <DictationPanel onUse={onUse} reason={live?.ready && (avail.transcribe === "no" || avail.speak === "no") ? "engine" : null} />;
}

type Phase = "idle" | "listening" | "thinking" | "speaking";
const LIVE_TEXT: Record<Phase, { title: string; sub: string; orb: VoiceState }> = {
  idle: { title: "محادثة صوتية مع باشت", sub: "اضغط وتحدّث؛ يرد باشت بصوته، ثم يستمع إليك من جديد. كل دور يظهر في المحادثة.", orb: "ready" },
  listening: { title: "يستمع…", sub: "تحدّث بالعربية. ينتهي دورك عندما تصمت قليلًا، أو اضغط الزر.", orb: "listening" },
  thinking: { title: "يفكّر…", sub: "يُفرَّغ كلامك ويُرسل إلى باشت في محادثتكما، ثم ينتظر رده.", orb: "listening" },
  speaking: { title: "يتحدث…", sub: "باشت يرد بصوته. اضغط الزر لإيقافه.", orb: "listening" },
};

function LiveSession({ live, rec }: { live: LiveVoice; rec: ReturnType<typeof useVoiceRecorder> }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const running = useRef(false);
  const player = usePlayer();
  const fx = useStore(voiceFxStore);
  useEffect(() => () => { running.current = false; rec.cancel(); voicePlayer().stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const end = (msg = "") => { running.current = false; rec.cancel(); voicePlayer().stop(); setPhase("idle"); if (msg) setError(msg); };

  const loop = async () => {
    let quiet = 0;
    while (running.current) {
      setPhase("listening");
      if (fx) earcon("start");
      const r = await rec.record({ maxMs: MAX_NOTE_MS, silence: true });
      if (!running.current) return;
      if (!r.audio) {
        if (r.ended === "no_speech" && ++quiet < 2) continue; // one quiet turn is forgiven; two end the session
        return end(r.ended === "no_speech" ? "لم أسمع كلامًا، فأنهيت الجلسة. اضغط للبدء من جديد." : rec.error || "");
      }
      quiet = 0;
      if (fx) earcon("stop");
      setPhase("thinking");
      let text: string;
      try { text = await bashtClient.transcribe(r.audio); voiceAvailability.set("transcribe", "yes"); }
      catch (e) {
        if (!running.current) return;
        if (e instanceof BashtError && e.code === "no_speech") continue;
        if (e instanceof BashtError && e.code === "voice_unavailable") voiceAvailability.set("transcribe", "no");
        return end(e instanceof Error ? e.message : "تعذّر تفريغ الصوت.");
      }
      if (!running.current) return;
      setHeard(text);
      let reply: string;
      try { reply = await live.ask(voiceNoteText(text)); }
      catch (e) { return end(e instanceof Error ? e.message : "تعذّر الإرسال إلى باشت."); }
      if (!running.current) return;
      setPhase("speaking");
      const played = await voicePlayer().play("live", reply);
      if (played === "error") return end(voicePlayer().getSnapshot().error);
    }
  };

  const start = () => {
    setError(""); setHeard("");
    voicePlayer().unlock(); primeAudioInput(); // inside the tap: iOS then allows the mic level probe and BASHT's voice later on
    running.current = true;
    void loop().finally(() => { if (!running.current) setPhase("idle"); });
  };
  /** The main button: start · end my turn now · stop BASHT speaking (and listen again). */
  const main = () => {
    if (phase === "idle") return start();
    if (phase === "listening") return rec.stop();
    if (phase === "speaking") return voicePlayer().stop();
  };
  const t = LIVE_TEXT[phase];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <PageHeader icon="wave" eyebrow="الصوت" title="الجلسة الصوتية" description="محادثة صوتية حية مع باشت في محادثتكما نفسها: بصوت باشت المعتمد في المحرك، ويظهر كل دور في المحادثة." />
      <section className="voice" data-state={phase === "idle" ? "ready" : "listening"} data-phase={phase} aria-labelledby="voice-h">
        <div className="voice-orb">
          <span className="voice-halo" aria-hidden="true" /><span className="voice-halo" aria-hidden="true" />
          <VoiceOrb state={t.orb} />
        </div>
        <div className="voice-bars" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</div>
        <div className="stack" style={{ gap: 4, justifyItems: "center" }}>
          <h2 id="voice-h" className="voice-label" role="status">{t.title}</h2>
          <p className="voice-sub">{phase === "listening" && rec.recording ? `${t.sub} · ${clock(rec.elapsed)}` : t.sub}</p>
        </div>
        <div className="voice-states" aria-label="حالات الجلسة">
          <span aria-current={phase === "listening" ? "true" : undefined}>يستمع</span>
          <span aria-current={phase === "thinking" ? "true" : undefined}>يفكّر</span>
          <span aria-current={phase === "speaking" ? "true" : undefined}>يتحدث</span>
        </div>
        <div className="voice-actions">
          <button className="voice-side" onClick={() => end()} disabled={phase === "idle"} aria-label="إنهاء المحادثة الصوتية"><Icon name="close" size={20} /></button>
          <button className="voice-main" onClick={main} disabled={phase === "thinking"} aria-pressed={phase !== "idle"}
            aria-label={phase === "idle" ? "ابدأ المحادثة الصوتية" : phase === "listening" ? "أنهِ دورك الآن" : phase === "speaking" ? "أوقف رد باشت" : "باشت يفكّر"}>
            <Icon name={phase === "idle" ? "mic" : phase === "speaking" ? "stop" : phase === "listening" ? "send" : "hourglass"} size={30} style={phase === "listening" ? { transform: "scaleX(-1)" } : undefined} />
          </button>
          <button className="voice-side" onClick={() => voiceFxStore.set(!fx)} aria-pressed={fx} aria-label={fx ? "إيقاف المؤثرات الصوتية" : "تشغيل المؤثرات الصوتية"} title="مؤثرات صوتية عند البدء والإيقاف"><Icon name="volume" size={20} /></button>
        </div>
      </section>
      {heard && phase !== "idle" && <section className="card card-pad stack" aria-label="آخر ما سمعه باشت"><small className="muted">سمعتُ منك:</small><div className="transcript" style={{ minHeight: 0 }}>{heard}</div></section>}
      {(error || rec.error || (player.error && phase === "idle")) && <Notice tone="danger" role="alert">{error || rec.error || player.error}</Notice>}
      <small className="muted">التفريغ والنطق يجريان في محرك باشت بإعداداته (نفس صوت باشت ونطقه). لا يُحفظ الصوت؛ النص يبقى في المحادثة. المكالمات الهاتفية والصوت الفوري (WebRTC) خارج هذه المرحلة.</small>
    </div>
  );
}

/** Browser dictation (the fallback): the transcript goes into the composer for review. */
function DictationPanel({ onUse, reason }: { onUse: (text: string) => void; reason: "engine" | null }) {
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
      <PageHeader icon="wave" eyebrow="الصوت" title="الجلسة الصوتية" description="تحدّث مع باشت بصوتك. المتاح هنا: إملاء عربي يحوّل كلامك إلى نص ترسله للمحادثة." />
      {reason === "engine" && <Notice tone="info" role="status">صوت باشت (التفريغ أو النطق) غير مفعّل في المحرك الآن، فالمحادثة الصوتية الحية غير متاحة. استخدم الإملاء أدناه.</Notice>}

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

      <div className="card card-pad row"><span className="file-ico"><Icon name="calls" size={22} /></span><span style={{ flex: 1 }}><strong>مكالمات صادرة وواردة</strong><small className="muted" style={{ display: "block" }}>تتطلب مزود اتصالات يدعم أرقام السعودية؛ لم يُختر بعد.</small></span><Badge>قريبًا</Badge></div>
    </div>
  );
}
