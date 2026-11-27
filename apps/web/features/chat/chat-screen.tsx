"use client";
/**
 * THE conversation of the app (U1): the app is BASHT, so /chat is one continuous conversation with BASHT.
 *
 * - Brain: BASHT (the engine, `app:owner`) by default. Direct Claude (CHAT-AI-1) only backs this same conversation when no engine
 *   is configured on the server; it is never a second, parallel conversation.
 * - One timeline: the engine's messages (server, every device) merged by time with this device's own events in ONE local thread
 *   (`main`): quick commands, reminders, browser cards, attachments. Quick commands stay local and are never sent to a model.
 * - Honest delivery: when BASHT is unreachable or locked, nothing is "sent" — the draft stays and the state is shown. No silent
 *   fallback to notes.
 * - Read-only: the owner's WhatsApp / main engine conversations, and the local archive (the old on-device threads, kept as they were).
 * - Voice lives here too (?voice=1, the mic in the composer); /calls and /chat/basht redirect to this screen.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Icon from "@/components/icon";
import Modal from "@/components/modal";
import { AgentOrb, BrandMark, Empty, ListSkeleton, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { aiReady, useAssistant } from "@/components/assistant-context";
import { useHydrated, useMediaQuery, useStore, useStoreError } from "@/lib/hooks";
import { threadsStore } from "@/lib/stores";
import { runCommand, runQuickCommand, type QuickReply, type ReminderOffer } from "@/lib/commands";
import ReminderDialog from "@/components/reminder-dialog";
import BrowserCard from "./browser-card";
import BrowserSessionCard, { dispatchSessionAction } from "./browser-session-card";
import VoicePanel from "@/features/calls/calls-screen";
import { APP_SESSION_KEY, useBashtConversation } from "./use-basht";
import { AssistantRequestError, assistantService } from "@/lib/assistant";
import { ensureClaudeSession } from "@/lib/claude-session";
import { useDictation } from "@/lib/speech";
import { downloadBlob, getFile, putFiles, tooLarge, toLocalFiles } from "@/lib/files-db";
import { formatTime } from "@/lib/format";
import { matches } from "@/lib/search";
import type { Attachment, Message, Thread } from "@/lib/domain";
import type { BashtMessage } from "@/lib/basht-client";
import { AGENT_STATE_TEXT, agentState, phaseForBrowser, phaseForQuick, setAgentPhase, useAgentActivity } from "@/lib/agent-activity";
import type { BrowserRef } from "@/lib/domain";

/** Tap-to-fill starters: they only put text in the composer; nothing is sent until the user presses send. */
const STARTERS: { label: string; text: string }[] = [
  { label: "أضف مهمة", text: "/مهمة " },
  { label: "ذكّرني غدًا", text: "ذكرني بكرة الساعة 9 " },
  { label: "تصفح تجريبي", text: "/متصفح" },
];

type Preview = { name: string; url: string; kind: "image" | "pdf" };
type View = { kind: "main" } | { kind: "engine"; key: string } | { kind: "archive"; id: string };
type Item = { kind: "local"; at: number; m: Message } | { kind: "engine"; at: number; m: BashtMessage; i: number };

export default function ChatScreen() {
  const hydrated = useHydrated();
  const threads = useStore(threadsStore);
  const storageError = useStoreError(threadsStore);
  const { confirm, prompt, toast } = useDialogs();
  const { status } = useAssistant();
  const desktop = useMediaQuery("(min-width: 900px)");
  const params = useSearchParams();
  const router = useRouter();

  const [view, setView] = useState<View>({ kind: "main" });
  const [sheet, setSheet] = useState(false);
  const [voice, setVoice] = useState(false);
  const [offer, setOffer] = useState<ReminderOffer | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<{ threadId: string; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const dictation = useDictation();
  const input = useRef<HTMLTextAreaElement>(null);
  const agent = agentState(status, useAgentActivity());

  // Which brain backs the conversation. BASHT whenever the server has it configured; Claude only without an engine.
  const bashtOn = status.server === "online" && status.bashtChat;
  const claudeOn = !bashtOn && aiReady(status);
  const engineUp = bashtOn && status.server === "online" && status.basht === "connected";
  const engineKey = view.kind === "main" ? APP_SESSION_KEY : view.kind === "engine" ? view.key : null;
  const basht = useBashtConversation(bashtOn, bashtOn ? engineKey : null);

  const mainThread = threads.find((t) => t.main);
  const archive = useMemo(
    () => threads.filter((t) => !t.main && Boolean(t.archived) === showArchived && matches(t.title + " " + t.messages.map((m) => m.text).join(" "), search))
      .sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created)),
    [threads, showArchived, search]);
  const archived = view.kind === "archive" ? threads.find((t) => t.id === view.id && !t.main) : undefined;
  const ready = bashtOn ? basht.gate === "open" && engineUp : claudeOn;

  // ?t=<id> (global search, old links) opens that local thread: the archive, or the conversation itself for its own thread.
  const fromUrl = params.get("t");
  useEffect(() => {
    if (!fromUrl || !hydrated) return;
    const t = threads.find((x) => x.id === fromUrl);
    setView(t && !t.main ? { kind: "archive", id: t.id } : { kind: "main" });
    setSheet(false);
  }, [fromUrl, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps
  // «?draft=» from the Command Center / voice: prefill only (the user still presses send), then drop it from the URL.
  const draftParam = params.get("draft");
  useEffect(() => {
    if (draftParam === null) return;
    setView({ kind: "main" }); setDraft(draftParam.slice(0, 2000)); router.replace("/chat", { scroll: false });
    requestAnimationFrame(() => input.current?.focus());
  }, [draftParam]); // eslint-disable-line react-hooks/exhaustive-deps
  // «?voice=1» (the old /calls address, the voice entry points): the voice panel opens inside the conversation.
  const voiceParam = params.get("voice");
  useEffect(() => { if (voiceParam === "1") { setView({ kind: "main" }); setVoice(true); router.replace("/chat", { scroll: false }); } }, [voiceParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // One timeline: engine messages (server) + this device's events (local), ordered by time.
  const items: Item[] = useMemo(() => {
    if (view.kind !== "main") return [];
    const local: Item[] = (mainThread?.messages ?? []).map((m) => ({ kind: "local", at: m.created, m }));
    const remote: Item[] = bashtOn ? (basht.messages ?? []).map((m, i) => ({ kind: "engine", at: m.at, m, i })) : [];
    return [...local, ...remote].sort((a, b) => a.at - b.at);
  }, [view.kind, mainThread, bashtOn, basht.messages]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [items.length, archived?.messages.length, basht.messages, basht.live?.text, streaming?.text, view]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const resetComposer = () => { dictation.abort(); setDraft(""); setAttachments([]); setNotice(""); };
  const go = (v: View) => {
    resetComposer(); setView(v); setSheet(false);
    const t = v.kind === "archive" ? v.id : null;
    if ((params.get("t") ?? null) !== t) router.replace(t ? `/chat?t=${t}` : "/chat", { scroll: false });
  };

  /** Records a local event in the conversation's own on-device thread (created on first use). */
  const local = async (text: string, extra: { role?: Message["role"]; attachments?: Attachment[]; browser?: BrowserRef } = {}) => {
    const r = await runCommand("chat.send", { threadId: null, main: true, text, ...extra });
    return r.status === "executed" ? r.data : null;
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || busy || view.kind !== "main") return;
    setBusy(true); dictation.abort();
    try {
      const quick: QuickReply = text ? await runQuickCommand(text) : { handled: false };
      // Free text needs a brain that is really reachable: otherwise nothing is recorded as sent and the draft stays.
      if (!quick.handled && text && !ready) {
        setNotice(bashtOn ? (basht.gate === "locked" ? "افتح جلسة باشت أولًا برمز المالك؛ لم تُرسل رسالتك." : "باشت غير متصل الآن؛ لم تُرسل رسالتك. ستبقى في مربع الكتابة.")
          : "لم يُفعَّل محرك باشت على الخادم بعد؛ لم تُرسل رسالتك.");
        return;
      }
      const executed = phaseForQuick(quick); // a local command that really ran (or failed) — distinct from a model reply
      if (executed) setAgentPhase(executed);
      if (quick.reminderOffer) setOffer(quick.reminderOffer);
      // On this device: a quick command and its result, attachments, and (with direct Claude) the message itself.
      const keepLocally = quick.handled || claudeOn;
      const id = keepLocally ? await local(text, { attachments }) : attachments.length ? await local("", { attachments }) : mainThread?.id ?? null;
      if (keepLocally && !id) { setNotice("تعذر حفظ الرسالة على هذا الجهاز."); return; }
      setAttachments([]); setNotice("");
      // «/متصفح»: only a card is added. The page is opened when (and only if) the user presses «السماح وتشغيل» on it.
      if (quick.browserOffer) {
        const interactive = quick.browserOffer.mode === "interactive";
        await local(interactive ? "طلب جلسة متصفح تفاعلية (اختبار)" : "طلب تصفح تجريبي (قراءة فقط): " + quick.browserOffer.url,
          { role: "system", browser: interactive ? { url: "", mode: "interactive", state: "offer" } : { url: quick.browserOffer.url, state: "offer" } });
      }
      // «/انقر …» «/اكتب …» «/افتح …» «/اقرأ»: handed to the newest ACTIVE session card, which submits it like its own form does.
      if (quick.browserAction) {
        const card = [...(threadsStore.getSnapshot().find((t) => t.main)?.messages ?? [])].reverse().find((m) => m.browser?.mode === "interactive" && m.browser.state === "started");
        if (card) dispatchSessionAction({ messageId: card.id, action: quick.browserAction });
        else await local("لا توجد جلسة متصفح تفاعلية نشطة. ابدأ واحدة بالأمر: /متصفح تفاعلي", { role: "system" });
      }
      // a handled quick command (incl. the browser card) is final: it is never forwarded to a model (review F4)
      if (quick.handled) { if (quick.reply) await local(quick.reply, { role: "system" }); setDraft(""); }
      else if (ready && text) {
        if (bashtOn) {
          try { await basht.send(text); setDraft(""); } // the draft is cleared only once BASHT accepted the turn
          catch (e) { setAgentPhase("reply_failed"); setNotice(e instanceof Error ? e.message : "تعذّر الإرسال إلى باشت."); }
        } else if (id) {
          // Direct Claude (CHAT-AI-1) backing the same conversation: the server owns its context, keyed by this thread's id.
          setDraft("");
          const ctl = new AbortController();
          abortRef.current = ctl;
          const keep = async (reply: string) => { if (reply.trim()) await runCommand("chat.send", { threadId: id, text: reply, role: "assistant" }, { origin: "assistant", mode: "execute" }); };
          let first = true;
          try {
            await ensureClaudeSession(prompt);
            setAgentPhase("thinking");
            setStreaming({ threadId: id, text: "" });
            const out = await assistantService.chat(id, text, { signal: ctl.signal, onDelta: (_d, all) => { if (first) { first = false; setAgentPhase("responding"); } setStreaming({ threadId: id, text: all }); } });
            await keep(out.text);
            setAgentPhase(out.stopped ? "stopped" : "replied");
            if (out.stopped) await runCommand("chat.send", { threadId: id, text: "أُوقف الرد بناءً على طلبك.", role: "system" });
          } catch (e) {
            setAgentPhase("reply_failed");
            await keep((e as { partial?: string }).partial ?? "");
            await runCommand("chat.send", { threadId: id, text: e instanceof AssistantRequestError ? e.message : e instanceof Error ? e.message : "تعذر الحصول على رد.", role: "system" });
          } finally { setStreaming(null); abortRef.current = null; }
        }
      } else setDraft("");
    } finally { setBusy(false); }
  };

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    if (await basht.unlock(code.trim())) { setCode(""); setNotice(""); } else setNotice("رمز الوصول غير صحيح أو تجاوزت عدد المحاولات.");
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list);
    if (tooLarge(files)) { setNotice("الحد الأقصى لكل ملف 25 ميجابايت."); return; }
    try {
      const items = toLocalFiles(files);
      await putFiles(items);
      setAttachments((old) => [...old, ...items.map(({ id, name }) => ({ id, name }))]);
      setNotice("");
    } catch { setNotice("تعذر حفظ المرفق محلياً. قد تكون مساحة المتصفح ممتلئة."); }
    finally { if (picker.current) picker.current.value = ""; }
  };
  const openAttachment = async (a: Attachment) => {
    try {
      const f = await getFile(a.id);
      if (!f) { setNotice("المرفق غير موجود في مكتبة الجهاز؛ ربما حُذفت بيانات الموقع."); return; }
      const kind = f.type.startsWith("image/") ? "image" : f.type === "application/pdf" ? "pdf" : null;
      if (!kind) { downloadBlob(f.file, f.name); return; }
      setPreview({ name: f.name, url: URL.createObjectURL(f.file), kind });
    } catch { setNotice("تعذر فتح المرفق. حاول إعادة فتح الصفحة."); }
  };

  const onRename = async (t: Thread) => {
    const title = await prompt({ title: "إعادة تسمية المحادثة", label: "الاسم", initial: t.title, maxLength: 80 });
    if (title) await runCommand("chat.rename", { id: t.id, title });
  };
  const onDelete = async (t: Thread) => {
    if (!(await confirm({ title: "حذف المحادثة؟", message: `سيتم حذف «${t.title}» ورسائلها نهائياً من هذا الجهاز. لن تُحذف المرفقات من مكتبة الملفات.`, confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("chat.remove", { id: t.id }); if (view.kind === "archive" && view.id === t.id) go({ kind: "main" });
    // the Claude copy of this conversation lives on the server: remove it too (best effort; a 404 just means it never reached Claude)
    const gone = await assistantService.removeConversation(t.id).then(() => true, (e: unknown) => e instanceof AssistantRequestError && (e.code === "not_found" || e.code === "unauthorized" || e.code === "disabled"));
    toast(gone ? "حُذفت المحادثة" : "حُذفت محليًا، لكن تعذر حذف نسختها على الخادم. أعد المحاولة لاحقًا.", gone ? "ok" : "error");
  };
  // browser task cards: persist the patch as before; a real started → done transition is an executed-task outcome
  const updateBrowser = (threadId: string, m: Message, patch: Partial<BrowserRef>) => {
    const phase = phaseForBrowser(m.browser, patch);
    if (phase) setAgentPhase(phase);
    void runCommand("chat.browser.update", { threadId, id: m.id, patch });
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("تم النسخ"); } catch { toast("تعذر النسخ. حدّد النص وانسخه يدوياً.", "error"); }
  };
  const editMsg = async (threadId: string, m: Message) => {
    const text = await prompt({ title: "تعديل الرسالة", label: "النص", initial: m.text, multiline: true });
    if (text) await runCommand("chat.message.edit", { threadId, id: m.id, text });
  };
  const deleteMsg = async (threadId: string, m: Message) => {
    if (!(await confirm({ title: "حذف الرسالة؟", confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("chat.message.remove", { threadId, id: m.id });
  };

  /** A message kept on this device (the conversation's local events, or an archived thread). */
  const localBubble = (threadId: string, m: Message) => (
    <article key={m.id} className={"bubble " + (m.role ?? "user")}>
      {m.role && m.role !== "user" && <span className="who">{m.role === "system" ? <><Icon name="info" size={14} />النظام</> : <><BrandMark size="xs" />باشت</>}</span>}
      {m.browser
        ? (m.browser.mode === "interactive"
          ? <BrowserSessionCard browser={m.browser} messageId={m.id} onChange={(patch) => updateBrowser(threadId, m, patch)} />
          : <BrowserCard browser={m.browser} onChange={(patch) => updateBrowser(threadId, m, patch)} />)
        : m.text}
      {m.attachments?.map((a) => (
        <div key={a.id} style={{ marginBlockStart: 6 }}>
          <button className="attach-chip" onClick={() => void openAttachment(a)} aria-label={"فتح المرفق " + a.name}><Icon name="clip" size={16} /><span>{a.name}</span></button>
          <small className="muted" style={{ display: "block" }}>على هذا الجهاز فقط</small>
        </div>
      ))}
      <div className="meta">
        <time className="num" dateTime={new Date(m.created).toISOString()}>{formatTime(m.created)}{m.edited ? " · معدّلة" : ""}</time>
        {m.text && <button className="icon-btn sm" onClick={() => void copy(m.text)} aria-label="نسخ الرسالة"><Icon name="copy" size={16} /></button>}
        {(m.role ?? "user") === "user" && <button className="icon-btn sm" onClick={() => void editMsg(threadId, m)} aria-label="تعديل الرسالة"><Icon name="edit" size={16} /></button>}
        <button className="icon-btn sm" onClick={() => void deleteMsg(threadId, m)} aria-label="حذف الرسالة"><Icon name="trash" size={16} /></button>
      </div>
    </article>
  );
  /** A message from BASHT's own record (the engine): read here, kept there. */
  const engineBubble = (m: BashtMessage, key: string) => (
    <article key={key} className={"bubble " + m.role}>
      {m.role === "assistant" && <span className="who"><BrandMark size="xs" />باشت</span>}
      {m.text}
      <div className="meta">
        {m.at > 0 && <time className="num" dateTime={new Date(m.at).toISOString()}>{formatTime(m.at)}</time>}
        <button className="icon-btn sm" onClick={() => void copy(m.text)} aria-label="نسخ الرسالة"><Icon name="copy" size={16} /></button>
      </div>
    </article>
  );

  const others = basht.sessions.filter((s) => s.key !== APP_SESSION_KEY);
  const list = (
    <>
      <div className="stack" style={{ padding: sheet && !desktop ? 12 : 0 }}>
        <ul className="threads" aria-label="محادثات باشت">
          <li className="thread-item" aria-current={view.kind === "main" ? "true" : undefined}>
            <button className="thread-open" onClick={() => go({ kind: "main" })}><strong>باشت</strong><small>المحادثة الرئيسية</small></button>
          </li>
          {others.map((s) => (
            <li key={s.key} className="thread-item" aria-current={view.kind === "engine" && view.key === s.key ? "true" : undefined}>
              <button className="thread-open" onClick={() => go({ kind: "engine", key: s.key })}><strong>{s.label}</strong><small>للقراءة فقط</small></button>
            </li>
          ))}
        </ul>
        <h2 className="muted" style={{ fontSize: "var(--fs-sm, .85rem)", margin: "8px 4px 0" }}>الأرشيف المحلي</h2>
        <div className="search"><Icon name="search" size={18} /><input className="input" type="search" aria-label="البحث في المحادثات" placeholder="بحث في الأرشيف" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="seg" role="group" aria-label="نوع القائمة">
          <button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>المحفوظة</button>
          <button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>المؤرشفة</button>
        </div>
      </div>
      <ul className="threads" aria-label="الأرشيف المحلي">
        {archive.map((t) => (
          <li key={t.id} className="thread-item" aria-current={view.kind === "archive" && view.id === t.id ? "true" : undefined}>
            <button className="thread-open" onClick={() => go({ kind: "archive", id: t.id })}><strong>{t.title}</strong><small className="num">{t.messages.length} رسالة · {formatTime(t.updated ?? t.created)}</small></button>
            <span className="row" style={{ gap: 0 }}>
              <button className="icon-btn sm" onClick={() => void onRename(t)} aria-label={"إعادة تسمية " + t.title}><Icon name="edit" size={17} /></button>
              <button className="icon-btn sm" onClick={() => void runCommand("chat.archive", { id: t.id })} aria-label={(t.archived ? "استعادة " : "أرشفة ") + t.title}><Icon name="archive" size={17} /></button>
              <button className="icon-btn sm" onClick={() => void onDelete(t)} aria-label={"حذف " + t.title}><Icon name="trash" size={17} /></button>
            </span>
          </li>
        ))}
        {hydrated && !archive.length && <li className="empty"><p>{search ? "لا نتائج مطابقة." : "لا محادثات محلية سابقة."}</p></li>}
      </ul>
    </>
  );

  if (!hydrated) return <div className="page"><h1 className="sr-only">باشت</h1><ListSkeleton rows={4} h={56} /></div>;

  const live = view.kind === "main" ? basht.live : null;
  const claudeLive = streaming && mainThread && streaming.threadId === mainThread.id ? streaming : null;
  const title = view.kind === "main" ? "باشت" : view.kind === "engine" ? others.find((s) => s.key === view.key)?.label ?? "محادثة" : archived?.title ?? "الأرشيف";
  const sub = live ? (live.text ? "يكتب الرد…" : "يفكّر…") : view.kind === "main" ? AGENT_STATE_TEXT[agent].label : view.kind === "engine" ? "للقراءة فقط" : "أرشيف محلي · للقراءة";

  return (
    <div className="page">
      <h1 className="sr-only">باشت</h1>
      {storageError && <Notice tone="warn" role="alert">{storageError}</Notice>}
      {status.server === "online" && status.bashtChat && (
        <Link href="/chat/basht" className="card card-pad row" style={{ marginBlockEnd: 10, gap: 10 }}>
          <BrandMark size="sm" /><span className="grow"><strong>تحدّث مع باشت الفعلي</strong><small className="muted" style={{ display: "block" }}>محادثة مباشرة مع محرك باشت وإرسال المهام، بذاكرته المشتركة</small></span><Icon name="forward" size={18} />
        </Link>
      )}
      <div className="chat">
        <aside className="chat-side" aria-label="المحادثات">{desktop && list}</aside>
        <section className="chat-main" aria-label="المحادثة الحالية">
          <div className="chat-head">
            {!desktop && <button className="icon-btn mobile-only" onClick={() => setSheet(true)} aria-label="المحادثات والأرشيف" aria-haspopup="dialog"><Icon name="menu" size={21} /></button>}
            <div className="chat-agent">
              <AgentOrb state={agent} size="sm" />
              <span className="grow"><span className="who-name">{title}</span><small role="status">{sub}</small></span>
            </div>
            {view.kind !== "archive" && bashtOn && <button className="icon-btn" onClick={basht.refresh} aria-label="تحديث المحادثة"><Icon name="repeat" size={20} /></button>}
            {view.kind === "main" && <button className="icon-btn" onClick={() => setVoice(true)} aria-label="الجلسة الصوتية"><Icon name="wave" size={21} /></button>}
          </div>

          {view.kind === "main" && bashtOn && basht.gate === "locked" && (
            <form className="card card-pad stack" onSubmit={unlock} style={{ marginBlockEnd: 8, gap: 10 }}>
              <div className="row"><BrandMark size="sm" /><strong>افتح جلسة باشت</strong></div>
              <small className="muted">محادثة باشت بصلاحيات المالك: أدخل رمز وصول المالك مرة واحدة على هذا الجهاز.</small>
              <div className="row"><input className="input" type="password" autoComplete="current-password" aria-label="رمز وصول المالك" placeholder="رمز وصول المالك" value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-primary" type="submit">فتح</button></div>
            </form>
          )}
          {view.kind === "main" && bashtOn && basht.gate !== "locked" && !engineUp && (
            <Notice tone="warn" role="status">باشت غير متصل الآن. لن تُرسل الرسائل حتى يعود الاتصال؛ الأوامر السريعة تعمل على جهازك.</Notice>
          )}
          {view.kind === "main" && !bashtOn && !claudeOn && status.server !== "checking" && (
            <Notice tone="info" role="status">لم يُفعَّل محرك باشت على الخادم بعد. الأوامر السريعة تعمل على جهازك، ولن تُرسل الرسائل الأخرى.</Notice>
          )}

          <div className="chat-log" ref={log} role="log" aria-live="polite" aria-label="رسائل المحادثة">
            {view.kind === "main" && (
              <>
                {bashtOn && basht.gate === "open" && basht.messages === null && <ListSkeleton rows={3} h={48} />}
                {!items.length && !live && !claudeLive && (bashtOn ? basht.messages !== null || basht.gate !== "open" : true) && (
                  <Empty icon="spark" brand title="أهلًا، أنا باشت. بماذا أبدأ؟"
                    action={<div className="suggest" aria-label="اقتراحات للبدء">{STARTERS.map((s) => (
                      <button key={s.label} type="button" onClick={() => { setDraft(s.text); input.current?.focus(); }}><Icon name="spark" size={15} />{s.label}</button>))}</div>}>
                    اكتب ما تريد إنجازه؛ ينفّذه باشت بصلاحياتك وذاكرته المشتركة، وتبقى الموافقات الحساسة في مساراتها.
                    <span style={{ display: "block", marginBlockStart: 8 }}>أوامر سريعة على جهازك: <span className="kbd">/مهمة</span> · <span className="kbd">/متصفح</span> (قراءة فقط) · <span className="kbd">/متصفح تفاعلي</span> (بموافقتك لكل خطوة)</span>
                  </Empty>
                )}
                {items.map((it) => (it.kind === "local" ? localBubble(mainThread!.id, it.m) : engineBubble(it.m, `e-${it.i}-${it.at}`)))}
                {live && (
                  <>
                    <article className="bubble user">{live.prompt}</article>
                    <article className="bubble assistant streaming" aria-busy="true">
                      <span className="who"><BrandMark size="xs" />باشت</span>
                      {live.text || <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
                    </article>
                  </>
                )}
                {claudeLive && (
                  <article className="bubble assistant streaming" aria-busy="true">
                    <span className="who"><BrandMark size="xs" />باشت</span>
                    {claudeLive.text || <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
                  </article>
                )}
              </>
            )}
            {view.kind === "engine" && (basht.messages === null ? <ListSkeleton rows={3} h={48} />
              : basht.messages.length ? basht.messages.map((m, i) => engineBubble(m, `r-${i}-${m.at}`)) : <Empty icon="chat" title="لا رسائل في هذه المحادثة" />)}
            {view.kind === "archive" && (archived ? archived.messages.map((m) => localBubble(archived.id, m)) : <Empty icon="archive" title="المحادثة غير موجودة" />)}
          </div>

          {view.kind === "main" ? (
            <div className="composer">
              <input ref={picker} type="file" multiple hidden aria-label="إضافة مرفقات من الجهاز" onChange={(e) => void addFiles(e.target.files)} />
              {attachments.length > 0 && (
                <div className="row-wrap">
                  {attachments.map((a) => (
                    <span key={a.id} className="attach-chip"><Icon name="clip" size={16} /><span>{a.name}</span>
                      <button className="icon-btn sm" style={{ width: 28, height: 28 }} aria-label={"إزالة المرفق " + a.name} onClick={() => setAttachments((o) => o.filter((x) => x.id !== a.id))}><Icon name="close" size={15} /></button></span>
                  ))}
                </div>
              )}
              <div className="composer-row">
                <button className="icon-btn bordered" onClick={() => picker.current?.click()} aria-label="إرفاق ملف" title="إرفاق ملف"><Icon name="clip" size={20} /></button>
                <textarea ref={input} className="textarea" rows={1} aria-label="اكتب رسالة" placeholder="اكتب لباشت…" value={draft} maxLength={8000}
                  onChange={(e) => setDraft(e.target.value)} enterKeyHint="send"
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && desktop) { e.preventDefault(); void send(); } }} />
                <button className={"icon-btn bordered " + (dictation.listening ? "recording" : "")} disabled={!dictation.supported} aria-pressed={dictation.listening}
                  aria-label={dictation.listening ? "إيقاف الإملاء الصوتي" : "بدء الإملاء الصوتي"} title={dictation.supported ? "إملاء عربي" : "التعرف الصوتي غير مدعوم في هذا المتصفح"}
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start(draft, setDraft))}><Icon name={dictation.listening ? "stop" : "mic"} size={20} /></button>
                {live || claudeLive
                  ? <button className="icon-btn send-btn stop-btn" onClick={() => (live ? void basht.stop() : abortRef.current?.abort())} aria-label="إيقاف الرد" title="إيقاف الرد"><Icon name="stop" size={20} /></button>
                  : <button className="icon-btn send-btn" onClick={() => void send()} disabled={busy || (!draft.trim() && !attachments.length)} aria-label="إرسال"><Icon name="send" size={20} style={{ transform: "scaleX(-1)" }} /></button>}
              </div>
              {dictation.listening && <small role="status" style={{ color: "var(--ai-ink)" }}>يستمع الآن… تحدّث بالعربية ثم راجع النص قبل الإرسال.</small>}
              {(notice || basht.error || dictation.error) && <small role="alert" style={{ color: "var(--danger)" }}>{notice || basht.error || dictation.error}</small>}
              <small className="composer-note">محادثتك مع باشت: منفصلة عن واتساب، بذاكرة باشت المشتركة وصلاحيات المالك، والموافقات الحساسة في مساراتها. المرفقات تبقى على هذا الجهاز ولا تُرسل بعد.</small>
            </div>
          ) : (
            <Notice tone="info">{view.kind === "engine" ? "هذه المحادثة للقراءة فقط من التطبيق." : "أرشيف محلي على هذا الجهاز للقراءة؛ الرسائل الجديدة تُكتب في محادثة باشت."}
              {" "}<button className="btn-link" onClick={() => go({ kind: "main" })}>العودة إلى باشت</button></Notice>
          )}
        </section>
      </div>

      <Modal open={sheet && !desktop} onClose={() => setSheet(false)} label="المحادثات والأرشيف" variant="sheet">
        <div className="sheet-card">
          <div className="row" style={{ padding: "10px 12px 0" }}><h2 style={{ flex: 1 }}>المحادثات</h2><button className="icon-btn" onClick={() => setSheet(false)} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>
          <div style={{ overflowY: "auto", display: "grid", alignContent: "start", gap: 8 }}>{list}</div>
        </div>
      </Modal>

      <Modal open={voice} onClose={() => setVoice(false)} label="الجلسة الصوتية" variant="sheet">
        <div className="sheet-card" style={{ padding: 12, overflowY: "auto" }}>
          <div className="row"><h2 style={{ flex: 1 }}>الجلسة الصوتية</h2><button className="icon-btn" onClick={() => setVoice(false)} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>
          <VoicePanel onUse={(t) => { setVoice(false); setView({ kind: "main" }); setDraft(t); requestAnimationFrame(() => input.current?.focus()); }} />
        </div>
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} label={preview ? "معاينة " + preview.name : "معاينة"}>
        {preview && (
          <div className="dialog-card wide">
            <div className="row"><strong style={{ flex: 1, overflowWrap: "anywhere" }}>{preview.name}</strong><button className="icon-btn" onClick={() => setPreview(null)} aria-label="إغلاق المعاينة"><Icon name="close" size={20} /></button></div>
            {preview.kind === "image"
              // eslint-disable-next-line @next/next/no-img-element
              ? <img className="preview-img" src={preview.url} alt={preview.name} />
              : <iframe className="preview-frame" src={preview.url} title={preview.name} />}
            <a className="btn" href={preview.url} download={preview.name}><Icon name="download" size={18} />تنزيل</a>
          </div>
        )}
      </Modal>
      <ReminderDialog open={!!offer} onClose={() => setOffer(null)} seed={offer?.draft} clarification={offer?.clarification} notes={offer?.notes} />
    </div>
  );
}
