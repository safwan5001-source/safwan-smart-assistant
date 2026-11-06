"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { AssistantRequestError, assistantService } from "@/lib/assistant";
import { ensureClaudeSession } from "@/lib/claude-session";
import { useDictation } from "@/lib/speech";
import { downloadBlob, getFile, putFiles, tooLarge, toLocalFiles } from "@/lib/files-db";
import { formatTime } from "@/lib/format";
import { matches } from "@/lib/search";
import type { Attachment, Message, Thread } from "@/lib/domain";
import { AGENT_STATE_TEXT, agentState, phaseForBrowser, phaseForQuick, setAgentPhase, useAgentActivity } from "@/lib/agent-activity";
import type { BrowserRef } from "@/lib/domain";

/** Tap-to-fill starters: they only put text in the composer; nothing is sent until the user presses send. */
const STARTERS: { label: string; text: string }[] = [
  { label: "أضف مهمة", text: "/مهمة " },
  { label: "ذكّرني غدًا", text: "ذكرني بكرة الساعة 9 " },
  { label: "تصفح تجريبي", text: "/متصفح" },
];

type Preview = { name: string; url: string; kind: "image" | "pdf" };

export default function ChatScreen() {
  const hydrated = useHydrated();
  const threads = useStore(threadsStore);
  const storageError = useStoreError(threadsStore);
  const { confirm, prompt, toast } = useDialogs();
  const { status } = useAssistant();
  const desktop = useMediaQuery("(min-width: 900px)");
  const params = useSearchParams();
  const router = useRouter();

  const [selected, setSelected] = useState<string | null>(null); // null = auto, "new" = blank chat
  const [sheet, setSheet] = useState(false);
  const [offer, setOffer] = useState<ReminderOffer | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState("");
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

  const visible = useMemo(
    () => threads.filter((t) => Boolean(t.archived) === showArchived && matches(t.title + " " + t.messages.map((m) => m.text).join(" "), search))
      .sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created)),
    [threads, showArchived, search]);
  const fromUrl = params.get("t");
  const activeId = selected === "new" ? null : selected ?? (fromUrl && threads.some((t) => t.id === fromUrl) ? fromUrl : threads.find((t) => !t.archived)?.id ?? null);
  const current = threads.find((t) => t.id === activeId);
  const ready = aiReady(status);

  // A new ?t= target (e.g. from global search while already on /chat) wins over local selection.
  useEffect(() => { if (fromUrl) { dictation.abort(); setSelected(null); setDraft(""); setAttachments([]); setNotice(""); setSheet(false); } }, [fromUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  // «?draft=» from the Command Center: prefill only (the user still presses send), then drop it from the URL.
  const draftParam = params.get("draft");
  useEffect(() => {
    if (draftParam === null) return;
    setSelected("new"); setDraft(draftParam.slice(0, 2000)); router.replace("/chat", { scroll: false });
    requestAnimationFrame(() => input.current?.focus());
  }, [draftParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncUrl = (id: string | null) => { if ((params.get("t") ?? null) !== id) router.replace(id ? `/chat?t=${id}` : "/chat", { scroll: false }); };
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [current?.messages.length, activeId, streaming?.text]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const resetComposer = () => { dictation.abort(); setDraft(""); setAttachments([]); setNotice(""); };
  const open = (id: string) => { resetComposer(); setSelected(id); setSheet(false); syncUrl(id); };
  const newChat = () => { resetComposer(); setSelected("new"); setSheet(false); syncUrl(null); };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || busy) return;
    setBusy(true); dictation.abort();
    try {
      const sent = await runCommand("chat.send", { threadId: activeId, text, attachments });
      if (sent.status !== "executed") { setNotice(sent.status === "invalid" ? sent.message : "تعذر إرسال الرسالة."); return; }
      const id = sent.data;
      setSelected(id); syncUrl(id); setDraft(""); setAttachments([]); setNotice("");
      const quick: QuickReply = text ? await runQuickCommand(text) : { handled: false };
      const executed = phaseForQuick(quick); // a local command that really ran (or failed) — distinct from a Claude reply
      if (executed) setAgentPhase(executed);
      if (quick.reminderOffer) setOffer(quick.reminderOffer);
      // «/متصفح»: only a card is added. The page is opened when (and only if) the user presses «السماح وتشغيل» on it.
      if (quick.browserOffer) {
        const interactive = quick.browserOffer.mode === "interactive";
        await runCommand("chat.send", interactive
          ? { threadId: id, text: "طلب جلسة متصفح تفاعلية (اختبار)", role: "system", browser: { url: "", mode: "interactive", state: "offer" } }
          : { threadId: id, text: "طلب تصفح تجريبي (قراءة فقط): " + quick.browserOffer.url, role: "system", browser: { url: quick.browserOffer.url, state: "offer" } });
      }
      // «/انقر …» «/اكتب …» «/افتح …» «/اقرأ»: handed to the newest ACTIVE session card of this thread, which submits it like its own form does.
      if (quick.browserAction) {
        const card = [...(threadsStore.getSnapshot().find((t) => t.id === id)?.messages ?? [])].reverse().find((m) => m.browser?.mode === "interactive" && m.browser.state === "started");
        if (card) dispatchSessionAction({ messageId: card.id, action: quick.browserAction });
        else await runCommand("chat.send", { threadId: id, text: "لا توجد جلسة متصفح تفاعلية نشطة. ابدأ واحدة بالأمر: /متصفح تفاعلي", role: "system" });
      }
      // a handled quick command (incl. the browser card) is final: it is never forwarded to the AI provider (review F4)
      if (quick.handled) { if (quick.reply) await runCommand("chat.send", { threadId: id, text: quick.reply, role: "system" }); }
      else if (ready && text) {
        // Streaming (CHAT-AI-1): the server owns the Claude context (keyed by this thread's id), so only the new message travels.
        // Browser commands/cards are handled above and never reach Claude.
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
    } finally { setBusy(false); }
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
    await runCommand("chat.remove", { id: t.id }); if (activeId === t.id) setSelected(null);
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
  const copy = async (m: Message) => {
    try { await navigator.clipboard.writeText(m.text); toast("تم النسخ"); } catch { toast("تعذر النسخ. حدّد النص وانسخه يدوياً.", "error"); }
  };
  const editMsg = async (m: Message) => {
    if (!current) return;
    const text = await prompt({ title: "تعديل الرسالة", label: "النص", initial: m.text, multiline: true });
    if (text) await runCommand("chat.message.edit", { threadId: current.id, id: m.id, text });
  };
  const deleteMsg = async (m: Message) => {
    if (!current || !(await confirm({ title: "حذف الرسالة؟", confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("chat.message.remove", { threadId: current.id, id: m.id });
  };

  const list = (
    <>
      <div className="stack" style={{ padding: sheet && !desktop ? 12 : 0 }}>
        <button className="btn btn-primary btn-block" onClick={newChat}><Icon name="plus" size={18} />محادثة جديدة</button>
        <div className="search"><Icon name="search" size={18} /><input className="input" type="search" aria-label="البحث في المحادثات" placeholder="بحث في المحادثات" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="seg" role="group" aria-label="نوع القائمة">
          <button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>المحادثات</button>
          <button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>الأرشيف</button>
        </div>
      </div>
      <ul className="threads" aria-label="قائمة المحادثات">
        {visible.map((t) => (
          <li key={t.id} className="thread-item" aria-current={t.id === activeId ? "true" : undefined}>
            <button className="thread-open" onClick={() => open(t.id)}><strong>{t.title}</strong><small className="num">{t.messages.length} رسالة · {formatTime(t.updated ?? t.created)}</small></button>
            <span className="row" style={{ gap: 0 }}>
              <button className="icon-btn sm" onClick={() => void onRename(t)} aria-label={"إعادة تسمية " + t.title}><Icon name="edit" size={17} /></button>
              <button className="icon-btn sm" onClick={() => void runCommand("chat.archive", { id: t.id })} aria-label={(t.archived ? "استعادة " : "أرشفة ") + t.title}><Icon name="archive" size={17} /></button>
              <button className="icon-btn sm" onClick={() => void onDelete(t)} aria-label={"حذف " + t.title}><Icon name="trash" size={17} /></button>
            </span>
          </li>
        ))}
        {hydrated && !visible.length && <li className="empty"><p>{search ? "لا نتائج مطابقة." : showArchived ? "الأرشيف فارغ." : "لا محادثات بعد."}</p></li>}
      </ul>
    </>
  );

  if (!hydrated) return <div className="page"><h1 className="sr-only">المحادثات</h1><ListSkeleton rows={4} h={56} /></div>;

  return (
    <div className="page">
      <h1 className="sr-only">المحادثات</h1>
      {storageError && <Notice tone="warn" role="alert">{storageError}</Notice>}
      <div className="chat">
        <aside className="chat-side" aria-label="المحادثات">{desktop && list}</aside>
        <section className="chat-main" aria-label="المحادثة الحالية">
          <div className="chat-head">
            {!desktop && <button className="icon-btn mobile-only" onClick={() => setSheet(true)} aria-label="قائمة المحادثات" aria-haspopup="dialog"><Icon name="menu" size={21} /></button>}
            <div className="chat-agent">
              <AgentOrb state={agent} size="sm" />
              <span className="grow"><span className="who-name">{current?.title ?? "محادثة جديدة"}</span><small role="status">باشت · {AGENT_STATE_TEXT[agent].label}</small></span>
            </div>
            <button className="icon-btn" onClick={newChat} aria-label="محادثة جديدة"><Icon name="plus" size={21} /></button>
          </div>

          <div className="chat-log" ref={log} role="log" aria-live="polite" aria-label="رسائل المحادثة">
            {!current?.messages.length && (
              <Empty icon="spark" brand title="أهلًا، أنا باشت. بماذا أبدأ؟"
                action={<div className="suggest" aria-label="اقتراحات للبدء">{STARTERS.map((s) => (
                  <button key={s.label} type="button" onClick={() => { setDraft(s.text); input.current?.focus(); }}><Icon name="spark" size={15} />{s.label}</button>))}</div>}>
                {ready ? "اكتب ما تريد إنجازه، وسأرد عليك هنا." : "أنت في وضع الملاحظات: الذكاء الاصطناعي غير مفعّل بعد، وتُحفظ رسائلك على هذا الجهاز فقط."}
                <span style={{ display: "block", marginBlockStart: 8 }}>أوامر سريعة: <span className="kbd">/مهمة</span> · <span className="kbd">/متصفح</span> (قراءة فقط) · <span className="kbd">/متصفح تفاعلي</span> (بموافقتك لكل خطوة)</span>
              </Empty>
            )}
            {current?.messages.map((m) => (
              <article key={m.id} className={"bubble " + (m.role ?? "user")}>
                {m.role && m.role !== "user" && <span className="who">{m.role === "system" ? <><Icon name="info" size={14} />النظام</> : <><BrandMark size="xs" />باشت</>}</span>}
                {m.browser && current
                  ? (m.browser.mode === "interactive"
                    ? <BrowserSessionCard browser={m.browser} messageId={m.id} onChange={(patch) => updateBrowser(current.id, m, patch)} />
                    : <BrowserCard browser={m.browser} onChange={(patch) => updateBrowser(current.id, m, patch)} />)
                  : m.text}
                {m.attachments?.map((a) => (
                  <div key={a.id} style={{ marginBlockStart: 6 }}>
                    <button className="attach-chip" onClick={() => void openAttachment(a)} aria-label={"فتح المرفق " + a.name}><Icon name="clip" size={16} /><span>{a.name}</span></button>
                  </div>
                ))}
                <div className="meta">
                  <time className="num" dateTime={new Date(m.created).toISOString()}>{formatTime(m.created)}{m.edited ? " · معدّلة" : ""}</time>
                  {m.text && <button className="icon-btn sm" onClick={() => void copy(m)} aria-label="نسخ الرسالة"><Icon name="copy" size={16} /></button>}
                  {(m.role ?? "user") === "user" && <button className="icon-btn sm" onClick={() => void editMsg(m)} aria-label="تعديل الرسالة"><Icon name="edit" size={16} /></button>}
                  <button className="icon-btn sm" onClick={() => void deleteMsg(m)} aria-label="حذف الرسالة"><Icon name="trash" size={16} /></button>
                </div>
              </article>
            ))}
            {streaming && streaming.threadId === activeId && (
              <article className="bubble assistant streaming" aria-busy="true">
                <span className="who"><BrandMark size="xs" />باشت</span>
                {streaming.text || <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
              </article>
            )}
          </div>

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
              <textarea ref={input} className="textarea" rows={1} aria-label="اكتب رسالة" placeholder={ready ? "اكتب لباشت…" : "اكتب ملاحظة أو أمرًا سريعًا…"} value={draft}
                onChange={(e) => setDraft(e.target.value)} enterKeyHint="send"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && desktop) { e.preventDefault(); void send(); } }} />
              <button className={"icon-btn bordered " + (dictation.listening ? "recording" : "")} disabled={!dictation.supported} aria-pressed={dictation.listening}
                aria-label={dictation.listening ? "إيقاف الإملاء الصوتي" : "بدء الإملاء الصوتي"} title={dictation.supported ? "إملاء عربي" : "التعرف الصوتي غير مدعوم في هذا المتصفح"}
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start(draft, setDraft))}><Icon name={dictation.listening ? "stop" : "mic"} size={20} /></button>
              {streaming
                ? <button className="icon-btn send-btn stop-btn" onClick={() => abortRef.current?.abort()} aria-label="إيقاف الرد" title="إيقاف الرد"><Icon name="stop" size={20} /></button>
                : <button className="icon-btn send-btn" onClick={() => void send()} disabled={busy || (!draft.trim() && !attachments.length)} aria-label="إرسال"><Icon name="send" size={20} style={{ transform: "scaleX(-1)" }} /></button>}
            </div>
            {dictation.listening && <small role="status" style={{ color: "var(--ai-ink)" }}>يستمع الآن… تحدّث بالعربية ثم راجع النص قبل الإرسال.</small>}
            {(notice || dictation.error) && <small role="alert" style={{ color: "var(--danger)" }}>{notice || dictation.error}</small>}
            <small className="composer-note">{ready ? "باشت يعمل بـ Claude: تُحفظ المحادثة على خادم باشت لتتابعها لاحقًا." : "وضع الملاحظات — الذكاء الاصطناعي غير مفعّل."} المرفقات تبقى على هذا الجهاز ولا تُرسل إلى Claude؛ لا تكتب بيانات حساسة.</small>
          </div>
        </section>
      </div>

      <Modal open={sheet && !desktop} onClose={() => setSheet(false)} label="قائمة المحادثات" variant="sheet">
        <div className="sheet-card">
          <div className="row" style={{ padding: "10px 12px 0" }}><h2 style={{ flex: 1 }}>المحادثات</h2><button className="icon-btn" onClick={() => setSheet(false)} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>
          <div style={{ overflowY: "auto", display: "grid", alignContent: "start", gap: 8 }}>{list}</div>
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
