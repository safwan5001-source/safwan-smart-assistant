"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Icon from "@/components/icon";
import { Badge, Notice, VoiceOrb } from "@/components/ui";
import { VOICE_TEXT, voiceState, type VoiceState } from "@/lib/voice-state";
import { useDictation } from "@/lib/speech";
import { useStore } from "@/lib/hooks";
import { earcon, voiceFxStore } from "@/lib/earcons";
import { claimVoiceSession, enterVoiceSession, leaveVoiceSession, type VoiceToken } from "@/lib/audio";
import { bashtClient, BashtError } from "@/lib/basht-client";
import {
  BACKGROUND_TEXT, browserSettle, recorderSupported, clock, createLiveSession, watchBackground, MAX_NOTE_MS, prepareCapture, primeAudioInput, releaseAudioInput, useInputLevel,
  usePlayerProgress, useVoiceAvailability, useVoiceRecorder, voiceAvailability, voicePlayer, type LivePhase, type LiveStep,
} from "@/lib/basht-voice";
import { isDurableVoiceFailure, speakGate, useVoiceStatus } from "@/lib/voice-status";
import { releaseVoicePress, takeVoiceAutostart, voiceAutostartDeadline, voiceAutostartPending } from "@/lib/voice-launch";

/** What the live session needs from the conversation: send one owner turn (as a voice note) and get BASHT's reply text back. */
export type LiveVoice = { ready: boolean; ask: (text: string) => Promise<string> };

/** The honest footer of every voice screen: this is a turn-by-turn loop, not a real-time call. */
export const TURN_NOTE = "محادثة صوتية بالتناوب — ليست مكالمة لحظية";

/**
 * The voice experience, opened INSIDE the conversation (/chat?voice=1, the wave button, a long-press on the BASHT tab). Full screen
 * on phones (centred dialog on desktop); the dialog itself lives in the conversation screen.
 * - With BASHT's engine voice: a SEQUENTIAL turn loop in the SAME conversation (app:owner) — listen → transcribe → send → BASHT
 *   replies → spoken in BASHT's own voice → listen again. Every turn lands in the timeline behind this screen.
 * - Without it (no engine voice, no recording in this browser): browser dictation (clearly labelled: not BASHT's voice), whose
 *   text goes into the composer for review.
 */
export default function VoicePanel({ onUse, live, autostart = false, onClose }: { onUse: (text: string) => void; live?: LiveVoice; autostart?: boolean; onClose?: () => void }) {
  const avail = useVoiceAvailability();
  const rec = useVoiceRecorder();
  const status = useVoiceStatus(false); // fetched by the conversation; read here
  const gate = speakGate(avail, status);
  // read synchronously (the hook learns it in an effect): a first render must not mistake "not checked yet" for "unsupported"
  const recOk = rec.supported || recorderSupported();
  const engineVoice = !!live?.ready && recOk && avail.transcribe !== "no" && gate.show;
  const close = onClose ?? (() => {});
  const reason = !live?.ready ? "" : !gate.show ? gate.note || "صوت باشت غير مفعّل في المحرك الآن."
    : avail.transcribe === "no" ? "تفريغ الصوت غير مفعّل في محرك باشت الآن." : !recOk ? "هذا المتصفح لا يدعم تسجيل الصوت لباشت." : "";
  // ONE deadline (the press's): while it runs and BASHT is still connecting, wait; once it passes — or the dictation fallback is
  // what the owner sees — the press is given back, so a late «ready» can never start recording behind that screen
  const [, rerender] = useState(0);
  const view = panelView({ engineVoice, reason, autostart, pending: voiceAutostartPending() });
  useEffect(() => {
    if (view === "dictation") { releaseVoicePress(); return; }
    if (view !== "connecting") return;
    const t = setTimeout(() => rerender((n) => n + 1), Math.max(0, voiceAutostartDeadline() - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [view]);
  // leaving the voice screen (any variant) gives back an unclaimed press and drops the probe's context
  useEffect(() => () => { releaseVoicePress(); releaseAudioInput(); }, []);
  if (view === "live") return <LiveSession live={live!} rec={rec} autostart={autostart} onClose={close} note={gate.note} />;
  if (view === "connecting") return <Connecting onClose={close} />;
  return <DictationPanel onUse={onUse} reason={reason} onClose={close} />;
}

/** Which voice screen to show: the live loop, a short wait for BASHT (only while a fresh press is pending), or dictation. */
export function panelView(p: { engineVoice: boolean; reason: string; autostart: boolean; pending: boolean }): "live" | "connecting" | "dictation" {
  if (p.engineVoice) return "live";
  return p.autostart && p.pending && !p.reason ? "connecting" : "dictation";
}

/** A short wait for the conversation (opened by a long-press from another screen). Nothing is recorded meanwhile. */
function Connecting({ onClose }: { onClose: () => void }) {
  return (
    <div className="vs" data-phase="starting">
      <VoiceTop title="محادثة صوتية مع باشت" onClose={onClose} closeLabel="إغلاق" />
      <div className="vs-stage">
        <div className="vs-face"><span className="vs-ring" aria-hidden="true" /><span className="vs-ring r2" aria-hidden="true" /><VoiceOrb state="ready" /></div>
        <div className="vs-text">
          <h2 id="voice-h" className="vs-label" role="status" aria-live="polite">يتصل بباشت…</h2>
          <p className="vs-sub">تُفتح محادثتكما ثم يبدأ الاستماع. لا يُسجَّل شيء قبل ذلك.</p>
        </div>
      </div>
      <footer className="vs-foot"><strong>{TURN_NOTE}</strong></footer>
    </div>
  );
}

type Turn = { you: string; basht?: string };
const LIVE_TEXT: Record<Exclude<LivePhase, "thinking">, { title: string; sub: string }> & { thinking: Record<Exclude<LiveStep, "" | "manual">, { title: string; sub: string }>; manual: { title: string; sub: string } } = {
  idle: { title: "محادثة صوتية بالتناوب", sub: "اضغط «ابدأ المحادثة» وتحدّث؛ يرد باشت بصوته ثم يستمع إليك من جديد. كل دور يظهر في المحادثة." },
  starting: { title: "يفتح الميكروفون…", sub: "اسمح باستخدام الميكروفون إن طُلب منك. لم يبدأ التسجيل بعد." },
  listening: { title: "يستمع…", sub: "تحدّث بالعربية. ينتهي دورك حين تصمت قليلًا، أو اضغط «أنهِ دورك»." },
  // no input level on this device right now: a pause does NOT end the turn — say so
  manual: { title: "يستمع…", sub: "اضغط «أنهِ دورك» حين تنتهي (حتى 60 ثانية). الصمت لا يُنهي دورك هنا." },
  muted: { title: "الميكروفون مكتوم", sub: "لا يُسجَّل شيء. اضغط «ألغِ الكتم» حين تريد التحدث." },
  speaking: { title: "يتحدث…", sub: "باشت يرد بصوته. اضغط «أوقفه وتحدّث» لمقاطعته." },
  blocked: { title: "الصوت متوقف", sub: "منع المتصفح التشغيل أو قاطعته مكالمة. اضغط «شغّل الصوت» للمتابعة بنفس الرد." },
  thinking: {
    transcribing: { title: "يفكّر…", sub: "يُفرَّغ كلامك في محرك باشت…" },
    waiting: { title: "يفكّر…", sub: "أُرسل كلامك إلى باشت في محادثتكما؛ ينتظر رده…" },
    voice: { title: "يجهّز الصوت…", sub: "رد باشت جاهز ويظهر في المحادثة؛ يُجهَّز بصوته الآن." },
  },
};
export const liveText = (p: LivePhase, s: LiveStep) =>
  p === "thinking" ? LIVE_TEXT.thinking[s === "transcribing" || s === "voice" ? s : "waiting"] : p === "listening" && s === "manual" ? LIVE_TEXT.manual : LIVE_TEXT[p];
/** The voice face shows the microphone only (never an agent state). */
const orbOf = (p: LivePhase, failed: boolean): VoiceState => (failed ? "error" : p === "listening" ? "listening" : "ready");

function LiveSession({ live, rec, autostart, onClose, note }: { live: LiveVoice; rec: ReturnType<typeof useVoiceRecorder>; autostart: boolean; onClose: () => void; note: string }) {
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [step, setStep] = useState<LiveStep>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [micMuted, setMicMuted] = useState(false);
  const [spkMuted, setSpkMuted] = useState(false);
  const [showTurns, setShowTurns] = useState(false);
  const fx = useStore(voiceFxStore);
  // the latest props/state, read by the session at each step (the session object itself lives as long as the screen)
  const latest = useRef({ live, rec, fx });
  latest.current = { live, rec, fx };
  const session = useRef<ReturnType<typeof createLiveSession> | null>(null);
  /** this screen's audio-session owner token (from the start tap, or claimed from the long-press) */
  const owner = useRef<VoiceToken | null>(null);
  const claim = (kind: "playback" | "play-and-record") => { owner.current = claimVoiceSession(kind, owner.current); };
  const release = () => { leaveVoiceSession(owner.current); owner.current = null; releaseAudioInput(); };
  session.current ??= createLiveSession({
    record: (onStarted) => latest.current.rec.record({ maxMs: MAX_NOTE_MS, silence: true, onStart: onStarted }),
    cancelRecord: () => latest.current.rec.cancel(),
    transcribe: async (audio, signal) => {
      try { const t = await bashtClient.transcribe(audio, signal); voiceAvailability.set("transcribe", "yes"); return t; }
      catch (e) { if (e instanceof BashtError && e.code === "voice_unavailable" && isDurableVoiceFailure(e.reason)) voiceAvailability.set("transcribe", "no", e.reason); throw e; }
    },
    ask: (text) => latest.current.live.ask(text),
    play: (text, onPlayer) => voicePlayer().play("live", text, { onPhase: onPlayer }),
    stopPlay: () => voicePlayer().stop(),
    canResume: () => voicePlayer().getSnapshot().canResume,
    resume: (onPlayer) => { claim("playback"); return voicePlayer().resume({ onPhase: onPlayer }); },
    playError: () => voicePlayer().getSnapshot().error,
    recordError: () => latest.current.rec.errorNow(),
    beforeCapture: (live) => prepareCapture(owner.current, live),
    afterCapture: (live, turnInfo) => browserSettle(() => owner.current, live, turnInfo.handsFree), // manual turn: keep the tap-started context
    onPhase: (p, s) => { setPhase(p); setStep(s); },
    onHeard: (t) => { if (t) setTurns((ts) => [...ts, { you: t }].slice(-20)); },
    onReply: (t) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), { ...ts[ts.length - 1], basht: t }] : ts)),
    onError: setError,
    onEnd: release,
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    cue: (kind) => { if (!latest.current.fx) return false; earcon(kind); return true; },
  });
  // closing the screen ends the session: no mic, no voice, nothing sent afterwards
  useEffect(() => () => { session.current?.end(); release(); }, []);
  // backgrounding: the partial turn is discarded and BASHT stops at once; the session ends if it stays hidden 3 s (or on pagehide).
  // A hidden event is ignored only while the microphone permission prompt can be open (getUserMedia pending).
  useEffect(() => watchBackground({
    onHide: () => session.current?.setHidden(true),
    onShow: () => session.current?.setHidden(false),
    onEnd: () => { const x = session.current; if (x && x.phase() !== "idle") x.end(BACKGROUND_TEXT); },
    ignoreHide: () => !!session.current?.awaitingMic(), // only a REAL permission prompt (getUserMedia pending), not the whole start
  }), []);
  // opened by a press (long-press / wave button) that already unlocked audio and the probe: start listening right away, owning
  // that press's audio session. A reload or a stale link never records on its own — «ابدأ المحادثة» is shown instead.
  // NOTE: the press is single-use. React StrictMode (next dev only) mounts → unmounts → mounts this screen: the first mount claims
  // the press and its cleanup ends that session, so the second mount finds no press and shows «ابدأ المحادثة». Production builds
  // mount once and are unaffected — test the long-press on a production build (docs/verification/BATCH-1-IPHONE-CHECKLIST.md).
  useEffect(() => {
    const press = autostart ? takeVoiceAutostart() : null;
    if (press) { owner.current = press.token; session.current?.start(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = session.current;
  /** Inside the tap: the record-capable session, the playback unlock and the level probe (iOS allows them only here). */
  const start = () => {
    owner.current = enterVoiceSession("play-and-record"); voicePlayer().unlock(); primeAudioInput();
    setError(""); setMicMuted(false); s.setMicMuted(false); s.setSpeakerMuted(spkMuted);
    s.start();
  };
  const end = () => { s.end(); onClose(); };
  // unmuting is a tap: the record session and the probe's context are (re)claimed inside it
  const toggleMic = () => { const m = !micMuted; setMicMuted(m); if (!m) { claim("play-and-record"); primeAudioInput(); } s.setMicMuted(m); };
  const toggleSpk = () => { const m = !spkMuted; setSpkMuted(m); s.setSpeakerMuted(m); };
  const failed = phase === "idle" && !!error;
  const main: { label: string; icon: string; run?: () => void; aria: string } =
    phase === "idle" ? { label: failed ? "ابدأ من جديد" : "ابدأ المحادثة", icon: "mic", run: start, aria: "ابدأ المحادثة الصوتية (يبدأ التسجيل)" }
      : phase === "starting" ? { label: "إلغاء", icon: "close", run: () => s.end(), aria: "إلغاء فتح الميكروفون" }
        : phase === "listening" ? { label: "أنهِ دورك", icon: "send", run: () => { primeAudioInput(); rec.stop(); }, aria: "أنهِ دورك الآن وأرسل كلامك" }
          : phase === "muted" ? { label: "ألغِ الكتم", icon: "mic", run: toggleMic, aria: "ألغِ الكتم وتحدّث" }
            : phase === "speaking" ? { label: "أوقفه وتحدّث", icon: "stop", run: () => s.interrupt(), aria: "أوقفه وتحدّث (يوقف رد باشت)" }
              : phase === "blocked" ? { label: "شغّل الصوت", icon: "play", run: () => s.resumePlayback(), aria: "شغّل الصوت (رد باشت نفسه)" }
                : step === "voice" ? { label: "تخطَّ الصوت", icon: "stop", run: () => s.interrupt(), aria: "تخطَّ الصوت وتحدّث" }
                  : { label: "يفكّر…", icon: "hourglass", aria: "باشت يفكّر" };
  const t = failed ? { title: "توقّفت المحادثة", sub: error } : liveText(phase, step);
  const active = phase !== "idle";

  return (
    <div className="vs" data-phase={failed ? "error" : phase} data-step={step || undefined}>
      <VoiceTop title="محادثة صوتية مع باشت" onClose={end} closeLabel={active ? "إنهاء المحادثة الصوتية وإغلاقها" : "إغلاق"}
        extra={<button type="button" className="icon-btn vs-fx" onClick={() => voiceFxStore.set(!fx)} aria-pressed={fx} aria-label={fx ? "إيقاف المؤثرات الصوتية" : "تشغيل المؤثرات الصوتية عند بدء الاستماع وانتهائه"} title="مؤثرات صوتية"><Icon name="wave" size={20} /></button>} />
      <div className="vs-stage">
        <VoiceFace phase={phase} orb={orbOf(phase, failed)} />
        <div className="vs-text">
          <h2 id="voice-h" className="vs-label" role="status" aria-live="polite">{t.title}</h2>
          <p className="vs-sub">{t.sub}</p>
          {phase === "listening" && rec.recording && (
            <span className="rec-chip" role="note"><i className="rec-dot" aria-hidden="true" />يسجّل الآن <bdi className="num">{clock(rec.elapsed)}</bdi></span>
          )}
          {micMuted && phase !== "idle" && phase !== "muted" && <span className="vs-flag"><Icon name="mic-off" size={14} />الميكروفون مكتوم بعد هذا الدور</span>}
          {spkMuted && <span className="vs-flag"><Icon name="volume-off" size={14} />صوت باشت مكتوم: ردوده تظهر كتابةً فقط</span>}
        </div>
      </div>
      {note && <p className="vs-note-line" role="note">{note}</p>}
      <div className="vs-controls">
        <button type="button" className="vs-side" onClick={toggleMic} disabled={!active} aria-pressed={micMuted}
          aria-label={micMuted ? "ألغِ كتم الميكروفون" : "اكتم الميكروفون"}><Icon name={micMuted ? "mic-off" : "mic"} size={22} /><span>{micMuted ? "مكتوم" : "الميكروفون"}</span></button>
        <span className="vs-main-wrap">
          <button type="button" className="vs-main" data-kind={main.icon} onClick={main.run} disabled={!main.run} aria-label={main.aria} autoFocus>
            <Icon name={main.icon} size={32} style={main.icon === "send" ? { transform: "scaleX(-1)" } : undefined} />
          </button>
          <span className="vs-main-label" aria-hidden="true">{main.label}</span>
        </span>
        <button type="button" className="vs-side" onClick={toggleSpk} aria-pressed={spkMuted}
          aria-label={spkMuted ? "شغّل صوت باشت" : "اكتم صوت باشت (تبقى الردود كتابةً)"}><Icon name={spkMuted ? "volume-off" : "volume"} size={22} /><span>{spkMuted ? "مكتوم" : "الصوت"}</span></button>
      </div>
      <div className="vs-row">
        <button type="button" className="btn vs-end" onClick={end}><Icon name="close" size={18} />{active ? "إنهاء المحادثة" : "إغلاق"}</button>
        <button type="button" className="btn btn-ghost vs-tr" onClick={() => setShowTurns((v) => !v)} aria-expanded={showTurns} aria-controls="vs-turns" disabled={!turns.length}>
          <Icon name="doc" size={18} />النص{turns.length ? <bdi className="num"> ({turns.length})</bdi> : null}
        </button>
      </div>
      {showTurns && (
        <ol id="vs-turns" className="vs-turns" aria-label="نص المحادثة الصوتية">
          {turns.map((x, i) => (
            <li key={i}>
              <p><strong>أنت:</strong> {x.you}</p>
              {x.basht && <p><strong>باشت:</strong> {x.basht}</p>}
            </li>
          ))}
        </ol>
      )}
      {(rec.error && !failed) && <Notice tone="danger" role="alert">{rec.error}</Notice>}
      <footer className="vs-foot">
        <strong>{TURN_NOTE}</strong>
        <small>دورك ثم دور باشت، بصوت باشت المعتمد في محركه. لا يُحفظ الصوت؛ النص يبقى في المحادثة.</small>
      </footer>
    </div>
  );
}

/** The centred BASHT face (the official mark — never redrawn) with a restrained wave driven by the real state. */
function VoiceFace({ phase, orb }: { phase: LivePhase; orb: VoiceState }) {
  const level = useInputLevel();
  const v = phase === "listening" ? Math.min(1, Math.sqrt(level) * 2.4) : 0; // perceptual: quiet speech still moves
  return (
    <div className="vs-face" style={{ "--lvl": v.toFixed(3) } as CSSProperties}>
      <span className="vs-ring" aria-hidden="true" /><span className="vs-ring r2" aria-hidden="true" />
      <VoiceOrb state={orb} />
      <VoiceWave phase={phase} level={v} />
    </div>
  );
}
const SHAPE = [0.35, 0.6, 0.85, 1, 0.75, 1, 0.85, 0.6, 0.35];
function VoiceWave({ phase, level }: { phase: LivePhase; level: number }) {
  const progress = usePlayerProgress();
  return (
    <div className="vs-wave" aria-hidden="true" data-phase={phase}>
      <span className="vs-bars">{SHAPE.map((s, i) => <i key={i} style={{ "--s": s, "--h": (4 + level * s * 30).toFixed(1) + "px" } as CSSProperties} />)}</span>
      {phase === "speaking" && <span className="vs-progress"><span style={{ inlineSize: `${Math.round(progress * 100)}%` }} /></span>}
    </div>
  );
}

function VoiceTop({ title, onClose, closeLabel, badge, extra }: { title: string; onClose: () => void; closeLabel: string; badge?: string; extra?: ReactNode }) {
  return (
    <div className="vs-top">
      <span className="grow vs-title"><strong>{title}</strong>{badge && <Badge tone="warn">{badge}</Badge>}</span>
      {extra}
      <button type="button" className="icon-btn vs-close" onClick={onClose} aria-label={closeLabel}><Icon name="close" size={22} /></button>
    </div>
  );
}

/** Browser dictation (the fallback): NOT BASHT's voice. The transcript goes into the composer for review. */
function DictationPanel({ onUse, reason, onClose }: { onUse: (text: string) => void; reason: string; onClose: () => void }) {
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
    <div className="vs" data-phase={d.listening ? "listening" : "idle"} data-mode="dictation">
      <VoiceTop title="إملاء المتصفح" badge="ليس صوت باشت" onClose={onClose} closeLabel="إغلاق الإملاء" />
      {reason && <Notice tone="info" role="status"><strong>صوت باشت غير متاح:</strong> {reason} المتاح هنا إملاء المتصفح: يحوّل كلامك إلى نص تراجعه وترسله، ولا يرد باشت بصوته.</Notice>}
      <div className="vs-stage">
        <div className="vs-face">
          <span className="vs-ring" aria-hidden="true" /><span className="vs-ring r2" aria-hidden="true" />
          <VoiceOrb state={state} />
        </div>
        <div className="vs-text">
          <h2 id="voice-h" className="vs-label" role="status" aria-live="polite">{VOICE_TEXT[state].title}</h2>
          <p className="vs-sub">{VOICE_TEXT[state].sub}</p>
        </div>
      </div>
      <div className="vs-controls">
        <button type="button" className="vs-side" onClick={() => { d.abort(); setText(""); d.clearError(); }} disabled={!text && !d.listening} aria-label="مسح النص وإلغاء"><Icon name="trash" size={22} /><span>مسح</span></button>
        <span className="vs-main-wrap">
          <button type="button" className="vs-main" onClick={toggle} disabled={!d.supported} aria-pressed={d.listening} aria-label={d.listening ? "إيقاف إملاء المتصفح" : "بدء إملاء المتصفح"} autoFocus>
            <Icon name={d.listening ? "stop" : "mic"} size={32} />
          </button>
          <span className="vs-main-label" aria-hidden="true">{d.listening ? "إيقاف" : "ابدأ الإملاء"}</span>
        </span>
        <button type="button" className="vs-side" onClick={() => voiceFxStore.set(!fx)} aria-pressed={fx} aria-label={fx ? "إيقاف المؤثرات الصوتية" : "تشغيل المؤثرات الصوتية"}><Icon name="wave" size={22} /><span>المؤثرات</span></button>
      </div>
      <section className="vs-dictation" aria-labelledby="tr-h">
        <div className="section-head"><h3 id="tr-h"><Icon name="doc" size={18} />النص</h3><Badge tone={d.supported ? "ok" : "warn"}>{d.supported ? "الإملاء مدعوم" : "غير مدعوم"}</Badge></div>
        <div className="transcript" aria-live="polite" aria-label="نص الكلام">{text || <span className="muted">سيظهر نص كلامك هنا.</span>}</div>
        {d.error && <Notice tone="danger" role="alert">{d.error}</Notice>}
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => { const v = text.trim(); if (!v) return; d.abort(); onUse(v); }}>
          <Icon name="send" size={18} style={{ transform: "scaleX(-1)" }} />راجع وأرسل لباشت
        </button>
      </section>
      <footer className="vs-foot">
        <strong>إملاء المتصفح — ليس صوت باشت</strong>
        <small>تفريغ صوتي فقط في المتصفح: يُفتح النص في المحادثة لتراجعه قبل الإرسال، وقد يعالج المتصفح (أو مزوّده) الصوت عبر خدمة خارجية. المكالمات الهاتفية خارج هذه المرحلة.</small>
      </footer>
    </div>
  );
}
