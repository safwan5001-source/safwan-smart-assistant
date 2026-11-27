"use client";
/**
 * Live conversation with the REAL BASHT (the OpenClaw engine) — BASHT Core Integration C2 + C4.
 *
 * - Writes go only to the app's own session (`app:owner`): an owner turn of BASHT with its shared memory, separate from WhatsApp.
 * - The owner's other conversations (WhatsApp direct chat, main session) are read-only here.
 * - A sent turn runs on the server; this screen polls its text. Leaving the page does not stop it (it resumes when you come back).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Icon from "@/components/icon";
import { AgentOrb, BrandMark, Empty, ListSkeleton, Notice } from "@/components/ui";
import { useAssistant } from "@/components/assistant-context";
import { bashtClient, BashtError, bashtErrorText, type BashtMessage, type BashtSession } from "@/lib/basht-client";
import { useDictation } from "@/lib/speech";
import { formatTime } from "@/lib/format";

export const APP_SESSION_KEY = "agent:main:app:owner";
const POLL_MS = 1200;
// The run in flight survives client-side navigation (module scope, never persisted). Only ONE polling loop may exist:
// each new loop (or leaving the screen / the App session) bumps the generation and the older loop exits.
let activeRun: { id: string; prompt: string } | null = null;
let pollGen = 0;

type Gate = "checking" | "disabled" | "locked" | "open";
const errText = (e: unknown) => (e instanceof BashtError ? e.message : bashtErrorText("unavailable"));

export default function BashtChatScreen() {
  const { status } = useAssistant();
  const [gate, setGate] = useState<Gate>("checking");
  const [code, setCode] = useState("");
  const [sessions, setSessions] = useState<BashtSession[]>([]);
  const [key, setKey] = useState(APP_SESSION_KEY);
  const [messages, setMessages] = useState<BashtMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<{ prompt: string; text: string } | null>(null);
  const [notice, setNotice] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const dictation = useDictation();
  const writable = key === APP_SESSION_KEY;
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async (k: string) => {
    try {
      const [list, msgs] = await Promise.all([bashtClient.sessions(), bashtClient.history(k)]);
      setSessions(list); setMessages(msgs); setNotice("");
    } catch (e) {
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      setMessages((m) => m ?? []); setNotice(errText(e));
    }
  }, []);

  const poll = useCallback(async (run: { id: string; prompt: string }) => {
    const gen = ++pollGen;
    const mine = () => gen === pollGen && activeRun?.id === run.id;
    setLive({ prompt: run.prompt, text: "" });
    // the finished turn belongs to the App session: refresh it only if that is still the session on screen
    const finish = async () => { setLive(null); if (keyRef.current === APP_SESSION_KEY) await load(APP_SESSION_KEY); };
    while (mine()) {
      try {
        const r = await bashtClient.run(run.id);
        if (!mine()) return;
        setLive({ prompt: run.prompt, text: r.text });
        if (r.status !== "running") {
          activeRun = null;
          if (r.status === "error") setNotice("تعذّر إكمال الرد من باشت. أعد المحاولة.");
          if (r.status === "stopped") setNotice("أُوقف الرد.");
          await finish();
          return;
        }
      } catch (e) {
        if (!mine()) return;
        if (e instanceof BashtError && e.code === "not_found") { activeRun = null; await finish(); return; }
        setNotice(errText(e));
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, [load]);

  useEffect(() => {
    let alive = true;
    void bashtClient.status().then((s) => {
      if (!alive) return;
      setGate(!s.enabled ? "disabled" : s.authenticated ? "open" : "locked");
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (gate !== "open") return;
    void load(key);
    if (activeRun && key === APP_SESSION_KEY) void poll(activeRun);
    else setLive(null);
    return () => { pollGen++; }; // leaving the App session or the screen stops this consumer; the turn keeps running on the server
  }, [gate, key, load, poll]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live]);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    if (await bashtClient.unlock(code.trim())) { setCode(""); setNotice(""); setGate("open"); }
    else setNotice("رمز الوصول غير صحيح أو تجاوزت عدد المحاولات.");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || live || !writable) return;
    setNotice("");
    try {
      const id = await bashtClient.send(text);
      setDraft("");
      activeRun = { id, prompt: text };
      void poll(activeRun);
    } catch (e) {
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      setNotice(errText(e));
    }
  };

  const stop = async () => { if (activeRun) { try { await bashtClient.stop(activeRun.id); } catch (e) { setNotice(errText(e)); } } };

  const engine = status.server === "online" ? status.basht : "checking";
  const orb = live ? (live.text ? "responding" : "thinking") : engine === "connected" ? "ready" : engine === "checking" ? "connecting" : "offline";
  const engineText = engine === "connected" ? "متصل بمحرك باشت" : engine === "starting" ? "المحرك قيد التشغيل" : engine === "checking" ? "جارٍ الفحص…" : "المحرك غير متاح";

  if (gate === "checking") return <div className="page"><h1 className="sr-only">باشت</h1><ListSkeleton rows={3} h={56} /></div>;

  if (gate === "disabled") return (
    <div className="page"><h1 className="sr-only">باشت</h1>
      <Empty icon="spark" brand title="محادثة باشت الفعلية غير مفعّلة بعد">
        تحتاج ربط الخادم بمحرك باشت (رمز التطبيق) ورمز وصول المالك على خدمة الويب. حتى ذلك الحين استخدم <Link href="/chat">المحادثات</Link>.
      </Empty>
    </div>
  );

  if (gate === "locked") return (
    <div className="page"><h1 className="sr-only">باشت</h1>
      <form className="card card-pad" onSubmit={unlock} style={{ maxWidth: 460, marginInline: "auto", display: "grid", gap: 12 }}>
        <div className="row"><BrandMark size="sm" /><strong>فتح محادثة باشت</strong></div>
        <p className="muted" style={{ margin: 0 }}>هذه محادثة مع باشت الفعلي بصلاحيات المالك. أدخل رمز وصول المالك مرة واحدة؛ تبقى الجلسة 8 ساعات على هذا الجهاز.</p>
        <input className="input" type="password" autoComplete="current-password" aria-label="رمز وصول المالك" placeholder="رمز وصول المالك" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn btn-primary" type="submit"><Icon name="check" size={18} />فتح</button>
        {notice && <small role="alert" style={{ color: "var(--danger)" }}>{notice}</small>}
      </form>
    </div>
  );

  const current = sessions.find((s) => s.key === key);
  return (
    <div className="page">
      <h1 className="sr-only">باشت</h1>
      <div className="chat">
        <section className="chat-main" aria-label="المحادثة مع باشت">
          <div className="chat-head">
            <div className="chat-agent">
              <AgentOrb state={orb} size="sm" />
              <span className="grow"><span className="who-name">باشت</span><small role="status">{live ? (live.text ? "يكتب الرد…" : "يفكّر…") : engineText}</small></span>
            </div>
            <button className="icon-btn" onClick={() => void load(key)} aria-label="تحديث المحادثة"><Icon name="repeat" size={20} /></button>
          </div>

          {sessions.length > 1 && (
            <div className="seg" role="group" aria-label="المحادثات" style={{ marginBlockEnd: 8 }}>
              {sessions.map((s) => (
                <button key={s.key} aria-pressed={s.key === key} onClick={() => { setMessages(null); setKey(s.key); }}>
                  {s.label}{!s.writable && <span className="sr-only"> (قراءة فقط)</span>}
                </button>
              ))}
            </div>
          )}

          <div className="chat-log" ref={log} role="log" aria-live="polite" aria-label="رسائل المحادثة">
            {messages === null && <ListSkeleton rows={3} h={48} />}
            {messages?.length === 0 && !live && (
              <Empty icon="spark" brand title={writable ? "تحدّث مع باشت مباشرة" : "لا رسائل في هذه المحادثة"}>
                {writable ? "اكتب طلبك أو مهمتك؛ ينفّذها باشت بصلاحياتك وذاكرته المشتركة، وتبقى الموافقات الحساسة كما هي." : "هذه المحادثة للقراءة فقط هنا."}
              </Empty>
            )}
            {messages?.map((m, i) => (
              <article key={`${m.at}-${i}`} className={"bubble " + m.role}>
                {m.role === "assistant" && <span className="who"><BrandMark size="xs" />باشت</span>}
                {m.text}
                {m.at > 0 && <div className="meta"><time className="num" dateTime={new Date(m.at).toISOString()}>{formatTime(m.at)}</time></div>}
              </article>
            ))}
            {live && writable && (
              <>
                <article className="bubble user">{live.prompt}</article>
                <article className="bubble assistant streaming" aria-busy="true">
                  <span className="who"><BrandMark size="xs" />باشت</span>
                  {live.text || <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
                </article>
              </>
            )}
          </div>

          {writable ? (
            <div className="composer">
              <div className="composer-row">
                <textarea className="textarea" rows={1} aria-label="اكتب لباشت" placeholder="اكتب لباشت…" value={draft} maxLength={8000}
                  onChange={(e) => setDraft(e.target.value)} enterKeyHint="send" />
                <button className={"icon-btn bordered " + (dictation.listening ? "recording" : "")} disabled={!dictation.supported} aria-pressed={dictation.listening}
                  aria-label={dictation.listening ? "إيقاف الإملاء الصوتي" : "بدء الإملاء الصوتي"}
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start(draft, setDraft))}><Icon name={dictation.listening ? "stop" : "mic"} size={20} /></button>
                {live
                  ? <button className="icon-btn send-btn stop-btn" onClick={() => void stop()} aria-label="إيقاف الرد"><Icon name="stop" size={20} /></button>
                  : <button className="icon-btn send-btn" onClick={() => void send()} disabled={!draft.trim()} aria-label="إرسال"><Icon name="send" size={20} style={{ transform: "scaleX(-1)" }} /></button>}
              </div>
              {(notice || dictation.error) && <small role="alert" style={{ color: "var(--danger)" }}>{notice || dictation.error}</small>}
              <small className="composer-note">محادثة التطبيق مع باشت الفعلي، منفصلة عن واتساب، بذاكرة باشت المشتركة وصلاحيات المالك. الموافقات الحساسة تبقى في مساراتها الحالية.</small>
            </div>
          ) : (
            <Notice tone="info">{current?.label ?? "هذه المحادثة"}: للقراءة فقط من التطبيق. للكتابة لباشت اختر «التطبيق».</Notice>
          )}
          {!writable && notice && <small role="alert" style={{ color: "var(--danger)" }}>{notice}</small>}
        </section>
      </div>
    </div>
  );
}
