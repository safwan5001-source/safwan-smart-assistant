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
 * - Voice lives here too (?voice=1, the mic in the composer); /calls and /chat/basht redirect to this screen. With the engine's voice:
 *   «استمع» on every BASHT reply (BASHT's own voice), voice notes from the composer mic (transcribed by the engine, sent as the
 *   owner's message), and the live voice session in the voice panel. Without it: browser dictation, one mic button either way.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import ModelPanel from "./model-panel";
import MessageBody from "./message-body";
import ListenButton from "./listen-button";
import { useBashtModel } from "./use-basht-model";
import { replyModelName, summary as modelSummary, reasonLabel, headerModel } from "@/lib/basht-model";
import { APP_SESSION_KEY, useBashtConversation } from "./use-basht";
import ApprovalInlineCard from "./approval-inline-card";
import MessageMedia, { LiveImages } from "./message-media";
import MediaViewer from "@/components/media-viewer";
import { localRowKey, useLocalAttachments, type PendingLocal } from "./use-local-attachments";
import { viewerItems, type ViewerItem } from "@/lib/viewer-items";
import { engineRowView } from "@/lib/engine-row";
import { buildTimeline, type TimelineItem } from "@/lib/timeline-items";
import { ComposerImages, useComposerImages } from "./composer-images";
import { BashtSearchResults, EarlierButton, ResetDivider, RetryBar, RunSteps, WindowBanner } from "./chat-extras";
import { modelReadsImages } from "@/lib/image-prep";
import { AssistantRequestError, assistantService } from "@/lib/assistant";
import { ensureClaudeSession } from "@/lib/claude-session";
import { useOwnerGate } from "@/components/owner-gate";
import { authClient, type AuthStatus } from "@/lib/owner-auth";
import { useDictation } from "@/lib/speech";
import { downloadBlob, getFile, putFiles, tooLarge, toLocalFiles } from "@/lib/files-db";
import { formatTime } from "@/lib/format";
import { matches } from "@/lib/search";
import type { Attachment, Message, Thread } from "@/lib/domain";
import { bashtClient, BashtError, type BashtMessage } from "@/lib/basht-client";
import { clock, createVoiceNotes, MAX_NOTE_MS, parseVoiceNote, usePlayer, useVoiceAvailability, useVoiceRecorder, voiceAvailability, voicePlayer } from "@/lib/basht-voice";
import { isDurableVoiceFailure, useVoiceStatus } from "@/lib/voice-status";
import { stripMediaMarkers } from "@/lib/speakable";
import { OPEN_VOICE_EVENT, primeVoiceFromGesture } from "@/lib/voice-launch";
import { overlayHistory } from "@/lib/overlay-history";
import { AGENT_STATE_TEXT, agentState, phaseForBrowser, phaseForQuick, setAgentPhase, useAgentActivity } from "@/lib/agent-activity";
import type { BrowserRef } from "@/lib/domain";
import { focusKey, focusTarget, newFocusScroll, nextScroll } from "@/lib/chat-scroll";

/** Tap-to-fill starters: they only put text in the composer; nothing is sent until the user presses send. */
const STARTERS: { label: string; text: string }[] = [
  { label: "أضف مهمة", text: "/مهمة " },
  { label: "ذكّرني غدًا", text: "ذكرني بكرة الساعة 9 " },
  { label: "تصفح تجريبي", text: "/متصفح" },
];

type Preview = { name: string; url: string; kind: "image" | "pdf" };
type View = { kind: "main" } | { kind: "engine"; key: string } | { kind: "archive"; id: string };
type Item = TimelineItem<Message, BashtMessage, PendingLocal>;

export default function ChatScreen() {
  const hydrated = useHydrated();
  const threads = useStore(threadsStore);
  const storageError = useStoreError(threadsStore);
  const { confirm, prompt, toast } = useDialogs();
  const { status, refresh: refreshHealth } = useAssistant();
  const desktop = useMediaQuery("(min-width: 900px)");
  const params = useSearchParams();
  const router = useRouter();

  const [view, setView] = useState<View>({ kind: "main" });
  const [sheet, setSheet] = useState(false);
  const [voice, setVoice] = useState(false);
  const [voiceAuto, setVoiceAuto] = useState(false); // opened by a press that may start listening at once (lib/voice-launch)
  const [modelOpen, setModelOpen] = useState(false);
  const [offer, setOffer] = useState<ReminderOffer | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  // one sign-in for the whole app (A1) when the server has it on; otherwise the legacy per-door code form
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  useEffect(() => { let alive = true; void authClient.status().then((s) => { if (alive) setAuth(s); }); return () => { alive = false; }; }, []);
  // login gate: a lapsed owner session goes back to the login page (and returns to this conversation), never to a form in the chat
  const ownerGate = useOwnerGate();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<{ threadId: string; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const dictation = useDictation();
  const recorder = useVoiceRecorder();
  const voiceAvail = useVoiceAvailability();
  const player = usePlayer();
  const [noteBusy, setNoteBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const agent = agentState(status, useAgentActivity());

  // Which brain backs the conversation. BASHT whenever the server has it configured; Claude only without an engine.
  // A health re-check passes through "checking": keep the last known configuration meanwhile, so nothing flickers or resets.
  const lastBashtOn = useRef(false);
  if (status.server === "online") lastBashtOn.current = status.bashtChat;
  const bashtOn = status.server === "online" ? status.bashtChat : status.server === "checking" && lastBashtOn.current;
  const claudeOn = !bashtOn && aiReady(status);
  const engineUp = bashtOn && status.server === "online" && status.basht === "connected";
  const engineKey = view.kind === "main" ? APP_SESSION_KEY : view.kind === "engine" ? view.key : null;
  const basht = useBashtConversation(bashtOn, bashtOn ? engineKey : null);
  const pics = useComposerImages(); // B2: photos waiting to go to BASHT with the next message
  const [jump, setJump] = useState<{ key: string; id: string } | null>(null); // B1: a search hit to open once its conversation is loaded
  useEffect(() => { if ((ownerGate.on || auth?.owner_auth) && basht.gate === "locked") ownerGate.signInAgain(); }, [ownerGate, auth, basht.gate]);
  // Voice with BASHT's engine (its own voice and transcription): only inside an open BASHT conversation, never pretended.
  const voiceOn = bashtOn && basht.gate === "open";
  useVoiceStatus(voiceOn); // what the engine says about BASHT's voice: once on open, then on focus at most every 60 s
  const noteMode = voiceOn && recorder.supported && voiceAvail.transcribe !== "no"; // the ONE mic: voice note, else dictation
  const lapsed = (e: unknown) => { if (e instanceof BashtError && e.code === "unauthorized" && (ownerGate.on || auth?.owner_auth)) ownerGate.signInAgain(); };
  // a voice error is shown where it happened («استمع» shows it with «أعد المحاولة»; the voice screen shows its own) — only a
  // lapsed owner session is handled here
  useEffect(() => {
    if (player.phase !== "error" || player.code !== "unauthorized") return;
    if (ownerGate.on || auth?.owner_auth) ownerGate.signInAgain();
    else toast(player.error, "error");
    voicePlayer().clearError();
  }, [player.phase, player.code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { voicePlayer().stop(); }, []);

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
  // «&autostart=1» (a long-press on the BASHT tab) may start listening at once — only with a fresh press (lib/voice-launch).
  const autostartParam = params.get("autostart") === "1";
  useEffect(() => { if (voiceParam === "1") { setView({ kind: "main" }); openVoice(autostartParam); router.replace("/chat", { scroll: false }); } }, [voiceParam]); // eslint-disable-line react-hooks/exhaustive-deps
  // a long-press on the BASHT tab while already here
  useEffect(() => {
    const on = (e: Event) => { setView({ kind: "main" }); openVoice(!!(e as CustomEvent<{ autostart?: boolean }>).detail?.autostart); };
    window.addEventListener(OPEN_VOICE_EVENT, on);
    return () => window.removeEventListener(OPEN_VOICE_EVENT, on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // the phone's back gesture/button closes the voice screen (and so ends the session) instead of leaving the conversation
  // (not pushed when the screen was opened by its address: that entry is being replaced; back then returns where the owner was)
  useEffect(() => {
    if (!voice) return;
    return overlayHistory().open(() => setVoice(false), { push: !location.search.includes("voice=1") });
  }, [voice]);

  // R5: the owner's own photos kept on this device — shown on their row when the engine's row has none, and as the owner's own
  // bubble while no row stands for a sent photo message (it never vanishes)
  const localMedia = useLocalAttachments(view.kind === "main" ? basht.messages : null,
    { enabled: bashtOn && view.kind === "main" && basht.gate === "open", liveRunId: basht.live?.runId ?? null, windowed: basht.windowed });
  // One timeline: engine messages (server) + this device's events (local), ordered by time.
  const items: Item[] = useMemo(() => {
    if (view.kind !== "main") return [];
    return buildTimeline({ local: mainThread?.messages ?? [], engine: bashtOn ? basht.messages ?? [] : [], pending: bashtOn ? localMedia.pending : [] });
  }, [view.kind, mainThread, bashtOn, basht.messages, localMedia.pending]);

  // The full-screen viewer walks through every picture of the conversation on screen (a live photo opens alone).
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const gallery = useMemo((): ViewerItem[] => {
    if (view.kind === "engine") return (basht.messages ?? []).flatMap((m) => viewerItems({ sessionKey: view.key, messageId: m.id, media: m.media }));
    return items.flatMap((it) => it.kind === "engine" ? viewerItems({ sessionKey: engineKey, messageId: it.m.id, media: it.m.media, local: localMedia.byRow.get(localRowKey(it.m, it.i)) })
      : it.kind === "pending" ? viewerItems({ sessionKey: null, messageId: null, media: [], local: it.p.images }) : []);
  }, [view, items, basht.messages, engineKey, localMedia.byRow]);
  // «إعادة المحاولة» on an unavailable picture: re-read the failed device photos AND refresh that message's media wherever it lives (a server copy may be available now)
  const retryMedia = useCallback((messageId?: string | null) => { localMedia.retry(); void basht.refreshMedia(messageId); }, [localMedia.retry, basht.refreshMedia]); // eslint-disable-line react-hooks/exhaustive-deps
  const galleryRef = useRef(gallery);
  galleryRef.current = gallery;
  const openViewer = useCallback((item: ViewerItem) => {
    const g = galleryRef.current; const i = g.findIndex((x) => x.id === item.id);
    setViewer(i >= 0 ? { items: g, index: i } : { items: [item], index: 0 });
  }, []);

  // Follow new messages only while the owner is at the bottom: reading older messages is never yanked away by a poll; opening a
  // conversation or sending jumps to the end (instantly — a smooth scroll over a long conversation lags on a phone).
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const toBottom = () => { stick.current = true; log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "instant" }); };
  const onLogScroll = () => {
    const el = log.current; if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 80; setAway(gap > 400);
  };
  useEffect(() => { stick.current = true; }, [view]);
  const focusScroll = useRef(newFocusScroll());
  useEffect(() => {
    // B1: a search hit / the first earlier row is scrolled to once (and stops following); picking the same hit again is a new
    // request. Otherwise follow the newest message while the owner is at the bottom. A streaming reply never pulls the owner
    // back to the focused row (lib/chat-scroll).
    const next = nextScroll(focusScroll.current, focusKey(basht.focusId ?? null, basht.focusReq), (k) => !!document.getElementById("m-" + focusTarget(k)), stick.current);
    if (next?.to === "focus") { stick.current = false; document.getElementById("m-" + focusTarget(next.id))?.scrollIntoView({ block: "center" }); }
    else if (next?.to === "bottom") toBottom();
  }, [items.length, archived?.messages.length, basht.messages, basht.live?.text, streaming?.text, view, basht.focusId, basht.focusReq]);
  // B1: a picked search hit opens once its conversation is on screen
  useEffect(() => {
    if (!jump || basht.messages === null || engineKey !== jump.key) return;
    setJump(null); void basht.jumpTo(jump.id);
  }, [jump, basht.messages, engineKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // While BASHT is unreachable, re-check health every 20 s so sending unlocks by itself when it is back.
  useEffect(() => {
    if (!bashtOn || engineUp) return;
    const t = setInterval(refreshHealth, 20_000);
    return () => clearInterval(t);
  }, [bashtOn, engineUp, refreshHealth]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  /** The voice panel takes the microphone: a composer voice note still recording is cancelled (never kept running behind it). */
  const openVoice = (autostart = false) => { recorder.cancel(); setVoiceAuto(autostart); setVoice(true); };
  const closeVoice = () => { setVoice(false); setVoiceAuto(false); };
  const resetComposer = () => { dictation.abort(); recorder.cancel(); notes.current?.cancel(); setDraft(""); setAttachments([]); setNotice(""); };
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
    const photos = bashtOn ? pics.images : [];
    // same barrier as the send button (Enter submits here too): never send while photos are still being prepared
    if (bashtOn && pics.preparing) { setNotice("انتظر حتى تُجهَّز الصور، ثم أرسل."); return; }
    if ((!text && !attachments.length && !photos.length) || busy || view.kind !== "main") return;
    setBusy(true); dictation.abort(); stick.current = true;
    try {
      const quick: QuickReply = text ? await runQuickCommand(text) : { handled: false };
      // Free text needs a brain that is really reachable: otherwise nothing is recorded as sent and the draft stays.
      if (!quick.handled && (text || photos.length) && !ready) {
        if (bashtOn && !engineUp) refreshHealth(); // re-check now: the engine may be back
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
      if (keepLocally && !id) {
        // a quick command has ALREADY run: clear it so a retry can never repeat its effect (no duplicate task/reminder)
        if (quick.handled) { setDraft(""); setAttachments([]); setNotice("نُفّذ الأمر، لكن تعذر حفظه في المحادثة على هذا الجهاز."); }
        else setNotice("تعذر حفظ الرسالة على هذا الجهاز.");
        return;
      }
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
      else if (ready && (text || photos.length)) {
        if (bashtOn) {
          // B2: a model that does not read images would never see them — say so before sending
          if (photos.length && modelReadsImages(model.state?.model.id, model.models) === false
            && !(await confirm({ title: "النموذج الحالي لا يقرأ الصور", message: "لن يرى باشت الصور مع هذا النموذج. يمكنك اختيار نموذج يقرأ الصور من زر النموذج، أو الإرسال على أي حال.", confirmLabel: "إرسال على أي حال" }))) return;
          pics.lock(photos.map((p) => p.id)); // until accepted, the sent photos cannot be removed or revoked (ownership in transit)
          try { await basht.send(text, photos); setDraft(""); pics.clear(photos.map((p) => p.id)); } // the draft is cleared only once BASHT accepted the turn
          catch (e) { pics.unlock(photos.map((p) => p.id)); setAgentPhase("reply_failed"); setNotice(e instanceof Error ? e.message : "تعذّر الإرسال إلى باشت."); }
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
            const onDelta = (_d: string, all: string) => { if (first) { first = false; setAgentPhase("responding"); } setStreaming({ threadId: id, text: all }); };
            // the server keeps Claude's context per conversation (capped): when it is full, continue in a fresh one, once
            let cid = threadsStore.getSnapshot().find((t) => t.id === id)?.claudeId ?? id;
            const out = await assistantService.chat(cid, text, { signal: ctl.signal, onDelta }).catch(async (e: unknown) => {
              if (!(e instanceof AssistantRequestError && e.code === "conversation_full")) throw e;
              const r = await runCommand("chat.claude.rotate", { id });
              if (r.status !== "executed") throw e;
              cid = r.data;
              await runCommand("chat.send", { threadId: id, text: "بدأ سياق جديد للمحادثة لدى Claude؛ الرسائل السابقة باقية هنا.", role: "system" });
              return assistantService.chat(cid, text, { signal: ctl.signal, onDelta });
            });
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

  /** A voice note: recorded here, transcribed by the engine, then sent to BASHT as the owner's message (marked as a voice note).
   *  Nothing is claimed as sent unless BASHT accepted it; if sending fails the transcript stays in the composer. Switching
   *  conversations or leaving the screen cancels it (createVoiceNotes): a late transcript is then never sent or written anywhere. */
  const sendable = useRef(false);
  sendable.current = ready && !basht.live; // read when the transcript is back, not when the note started
  const notes = useRef<ReturnType<typeof createVoiceNotes> | null>(null);
  const noteDeps = useRef({ basht, lapsed, toast });
  noteDeps.current = { basht, lapsed, toast };
  notes.current ??= createVoiceNotes({
    transcribe: async (audio, signal) => {
      try { const t = await bashtClient.transcribe(audio, signal); voiceAvailability.set("transcribe", "yes"); return t; }
      catch (e) { if (e instanceof BashtError && e.code === "voice_unavailable" && isDurableVoiceFailure(e.reason, e.reasonGiven)) voiceAvailability.set("transcribe", "no", e.reason); throw e; }
    },
    canSend: () => sendable.current,
    send: async (text) => { try { await noteDeps.current.basht.send(text); } catch (e) { setAgentPhase("reply_failed"); throw e; } },
    setDraft, setNotice, setBusy: setNoteBusy,
    onError: (e) => noteDeps.current.lapsed(e),
    onLimit: () => noteDeps.current.toast("بلغ التسجيل حده (3 دقائق)، فأُرسل حتى هنا."),
  });
  useEffect(() => () => notes.current?.cancel(), []);
  const recordNote = async () => {
    if (recorder.recording || noteBusy) return;
    setNotice(""); dictation.abort();
    const r = await recorder.record({ maxMs: MAX_NOTE_MS });
    if (!r.audio) return; // cancelled, or the mic could not start (recorder.error says why)
    await notes.current?.run(r.audio, r.ended);
  };
  /** The live voice session: one owner turn (a voice note) and BASHT's finished reply, in this same conversation. */
  const liveVoice = {
    ready: voiceOn && engineUp,
    ask: async (text: string) => {
      if (basht.live) throw new Error("باشت ينفّذ طلبًا سابقًا الآن؛ انتظر حتى يكتمل.");
      const id = await basht.send(text);
      const end = await basht.waitRun(id);
      if (end.status === "done" && end.text.trim()) return end.text;
      throw new Error(end.status === "stopped" ? "أُوقف الرد." : "تعذّر الحصول على رد باشت.");
    },
  };

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    if (await basht.unlock(code.trim())) { setCode(""); setNotice(""); } else setNotice("رمز الوصول غير صحيح أو تجاوزت عدد المحاولات.");
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    let files = Array.from(list);
    // B2: with BASHT on, photos go to BASHT (prepared on this device); other files stay on the device as before
    const docsSoon = bashtOn && files.some((f) => !f.type.startsWith("image/"));
    if (bashtOn) { files = await pics.take(files); if (!files.length) { if (picker.current) picker.current.value = ""; return; } }
    if (tooLarge(files)) { setNotice("الحد الأقصى لكل ملف 25 ميجابايت."); return; }
    try {
      const items = toLocalFiles(files);
      await putFiles(items);
      setAttachments((old) => [...old, ...items.map(({ id, name }) => ({ id, name }))]);
      setNotice(docsSoon ? "إرسال المستندات إلى باشت قريبًا؛ حُفظ الملف على جهازك فقط (ملفاتي). الصور تُرسل." : "");
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

  /** B1 «محادثة جديدة»: a fresh context for the app conversation; nothing is deleted and earlier messages stay readable above the divider. */
  const startNew = async () => {
    if (!(await confirm({ title: "بدء محادثة جديدة؟", message: "يبدأ باشت سياقًا جديدًا لمحادثة التطبيق. لا يُحذف شيء: الرسائل السابقة تبقى قابلة للقراءة أعلى الخط الفاصل.", confirmLabel: "محادثة جديدة" }))) return;
    const e = await basht.newConversation();
    toast(e ?? "بدأت محادثة جديدة", e ? "error" : "ok");
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
        : m.role === "assistant" ? <MessageBody text={m.text} /> : m.text}
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
  /** A sent photo message whose row is not in the history (yet): the owner's own bubble from this device, never silently dropped. */
  const pendingBubble = (p: PendingLocal) => {
    const parsed = parseVoiceNote(p.text);
    return (
      <article key={"p-" + p.clientMsgId} className="bubble user">
        {parsed.text}
        {p.status === "loading" && <span className="media-thumb loading" aria-busy="true" aria-label="جارٍ تحميل الصورة" />}
        <MessageMedia sessionKey={null} messageId={null} media={[]} local={p.images} localFailed={p.status === "failed"} onOpen={openViewer} onRetry={retryMedia} localOnly />
        <div className="meta"><time className="num" dateTime={new Date(p.sentAt).toISOString()}>{formatTime(p.sentAt)}</time></div>
      </article>
    );
  };
  /** A message from BASHT's own record (the engine): read here, kept there. */
  const engineBubble = (m: BashtMessage, key: string, sk: string | null = engineKey, idx = -1) => {
    if (m.kind === "reset") return <ResetDivider key={key} at={m.at} />;
    const lk = idx >= 0 ? localRowKey(m, idx) : null;
    const localState = lk && localMedia.loadingRows.has(lk) ? "loading" : lk && localMedia.failedRows.has(lk) ? "failed" : lk && localMedia.byRow.has(lk) ? "ready" : "none";
    const view = engineRowView(m, parseVoiceNote, localState); // placeholder-only text is no caption; the provider's quota notice reads in clear Arabic
    const note = { voice: view.voice, text: view.text };
    const noText = view.noText;
    const localImgs = idx >= 0 ? localMedia.byRow.get(localRowKey(m, idx)) : undefined;
    return (
    <article key={key} id={m.id ? "m-" + m.id : undefined} className={"bubble " + m.role + (m.id && m.id === basht.focusId ? " focused" : "")}>
      {m.role === "assistant" && <span className="who"><BrandMark size="xs" />باشت</span>}
      {note.voice && <span className="voice-tag"><Icon name="mic" size={13} />رسالة صوتية</span>}
      {m.role === "assistant" ? <MessageBody text={view.assistantText} /> : note.text}
      {sk && <MessageMedia sessionKey={sk} messageId={m.id} media={m.media} local={localImgs} ownerNoText={noText} localFailed={view.localFailed} onOpen={openViewer} onRetry={retryMedia} />}
      {m.role === "assistant" && m.fallback?.to && (
        <small className="model-fallback" role="note">↪ نموذج احتياطي: <bdi>{replyModelName(null, m.fallback.to, model.models)}</bdi>{m.fallback.reason ? ` (${reasonLabel(m.fallback.reason)})` : ""}</small>
      )}
      <div className="meta">
        {m.at > 0 && <time className="num" dateTime={new Date(m.at).toISOString()}>{formatTime(m.at)}</time>}
        {m.role === "assistant" && m.model && m.provider !== "openclaw" && <small className="model-tag" title={m.provider ? `${m.provider}/${m.model}` : m.model}>{replyModelName(m.provider, m.model, model.models)}</small>}
        {m.role === "assistant" && <ListenButton id={m.id || key} text={m.text} />}
        {note.text && <button className="icon-btn sm" onClick={() => void copy(note.text)} aria-label="نسخ الرسالة"><Icon name="copy" size={16} /></button>}
      </div>
    </article>
    );
  };

  // M: the app conversation's model, read from the engine (refreshed after each reply and each change; never polled)
  const model = useBashtModel(bashtOn && basht.gate === "open", !!basht.live);
  const modelLine = model.supported ? modelSummary(model.state, model.models) : "";
  // B04: the model that really executed the last reply, next to the selected one. Unknown stays unknown (nothing is claimed).
  const lastReplyRow = useMemo(() => [...(basht.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.model && m.provider !== "openclaw") ?? null, [basht.messages]);
  const head = useMemo(() => headerModel(model.supported ? model.state : null, model.models, lastReplyRow), [model.supported, model.state, model.models, lastReplyRow]);
  // Perf: the timeline's bubbles are rebuilt only when the messages (or the model names they show) change. A keystroke, a poll of
  // the live reply or a status update reuses the same elements, so React skips every existing bubble (measured, iPhone emulation:
  // 90 → 15 component renders per keystroke with a 50-message page, 465 → 15 with 300). A bubble that reads other state must add it here.
  // engine rows are keyed by their engine id (stable when earlier rows load above them: a reply being played keeps its «إيقاف»);
  // index + time only for a row without an id
  const timeline = useMemo(() => items.map((it) => (it.kind === "local" ? localBubble(mainThread!.id, it.m)
    : it.kind === "pending" ? pendingBubble(it.p) : engineBubble(it.m, it.m.id ? `e-${it.m.id}` : `e-${it.i}-${it.at}`, engineKey, it.i))),
    // engineBubble also reads basht.focusId (the focused search hit), engineKey (whose media it fetches) and the local photo copies
    [items, model.models, basht.focusId, engineKey, localMedia.byRow, localMedia.loadingRows]); // eslint-disable-line react-hooks/exhaustive-deps -- the bubble builders only read stable callbacks besides these

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
        {bashtOn && basht.gate === "open" && (
          <button type="button" className="btn btn-sm" style={{ justifySelf: "start" }} disabled={basht.resetting || !!basht.live}
            onClick={() => { setSheet(false); void startNew(); }}><Icon name="plus" size={16} />محادثة جديدة</button>
        )}
        <h2 className="muted" style={{ fontSize: "var(--fs-sm, .85rem)", margin: "8px 4px 0" }}>الأرشيف المحلي</h2>
        <div className="search"><Icon name="search" size={18} /><input className="input" type="search" aria-label="البحث في المحادثات" placeholder={bashtOn ? "بحث في محادثات باشت والأرشيف" : "بحث في الأرشيف"} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <BashtSearchResults query={search} enabled={bashtOn && basht.gate === "open"} onPick={(h) => { go(h.key === APP_SESSION_KEY ? { kind: "main" } : { kind: "engine", key: h.key }); setJump({ key: h.key, id: h.message_id }); }} />
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
  const liveText = live ? stripMediaMarkers(live.text, { streaming: true }) : ""; // no «MEDIA: /path» marker while it streams
  const claudeLive = streaming && mainThread && streaming.threadId === mainThread.id ? streaming : null;
  const title = view.kind === "main" ? "باشت" : view.kind === "engine" ? others.find((s) => s.key === view.key)?.label ?? "محادثة" : archived?.title ?? "الأرشيف";
  const sub = live ? (live.text ? "يكتب الرد…" : "يفكّر…") : view.kind === "main" ? AGENT_STATE_TEXT[agent].label + (modelLine && agent !== "offline" ? " · " + modelLine : "") : view.kind === "engine" ? "للقراءة فقط" : "أرشيف محلي · للقراءة";

  return (
    <div className="page">
      <h1 className="sr-only">باشت</h1>
      {storageError && <Notice tone="warn" role="alert">{storageError}</Notice>}
      <div className="chat">
        <aside className="chat-side" aria-label="المحادثات">{desktop && list}</aside>
        <section className="chat-main" aria-label="المحادثة الحالية">
          <div className="chat-head">
            {!desktop && <button className="icon-btn mobile-only" onClick={() => setSheet(true)} aria-label="المحادثات والأرشيف" aria-haspopup="dialog"><Icon name="menu" size={21} /></button>}
            <div className="chat-agent">
              <AgentOrb state={agent} size="sm" />
              <span className="grow"><span className="who-name">{title}</span><small role="status">{sub}</small>
</span>
            </div>
            {view.kind !== "archive" && bashtOn && <button className="icon-btn" onClick={() => { refreshHealth(); basht.refresh(); }} aria-label="تحديث المحادثة"><Icon name="repeat" size={20} /></button>}
            {view.kind === "main" && model.supported && <button className="icon-btn" onClick={() => { setModelOpen(true); void model.reload(); }} aria-label="النموذج والقدرات" aria-haspopup="dialog"><Icon name="spark" size={20} /></button>}
            {view.kind === "main" && <button className="icon-btn" onClick={() => { primeVoiceFromGesture(); openVoice(true); }} aria-label="محادثة صوتية بالتناوب مع باشت — يبدأ الاستماع فورًا" title="محادثة صوتية: يبدأ الاستماع فورًا (أو اضغط مطولًا على زر باشت في الأسفل)"><Icon name="wave" size={21} /></button>}
          </div>

          {view.kind === "main" && !live && head.executed && (
            <div className="model-exec" role="note" data-differs={head.differs ? "true" : undefined}
              title={head.differs ? `نُفّذ آخر رد بنموذج ${head.executed} بدلًا من المحدَّد ${head.selected}${head.reason ? ` (${head.reason})` : ""}` : `نفّذ آخر رد: ${head.executed}`}>
              {head.differs ? <>↪ نُفّذ بنموذج آخر: <bdi>{head.executed}</bdi>{head.selected ? <> بدلًا من <bdi>{head.selected}</bdi></> : null}{head.reason ? ` · ${head.reason}` : ""}</> : <>آخر رد نفّذه: <bdi>{head.executed}</bdi></>}
            </div>
          )}
          {view.kind === "main" && bashtOn && basht.gate === "locked" && auth && !auth.owner_auth && (
            <form className="card card-pad stack" onSubmit={unlock} style={{ marginBlockEnd: 8, gap: 10 }}>
              <div className="row"><BrandMark size="sm" /><strong>افتح جلسة باشت</strong></div>
              <small className="muted">محادثة باشت بصلاحيات المالك: أدخل رمز وصول المالك مرة واحدة على هذا الجهاز.</small>
              <div className="row"><input className="input" type="password" autoComplete="current-password" aria-label="رمز وصول المالك" placeholder="رمز وصول المالك" value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-primary" type="submit">فتح</button></div>
            </form>
          )}
          {view.kind === "main" && bashtOn && basht.gate !== "locked" && !engineUp && status.server !== "checking" && (
            <Notice tone="warn" role="status">باشت غير متصل الآن. لن تُرسل الرسائل حتى يعود الاتصال؛ الأوامر السريعة تعمل على جهازك.</Notice>
          )}
          {view.kind === "main" && !bashtOn && !claudeOn && status.server !== "checking" && (
            <Notice tone="info" role="status">لم يُفعَّل محرك باشت على الخادم بعد. الأوامر السريعة تعمل على جهازك، ولن تُرسل الرسائل الأخرى.</Notice>
          )}

          <div className="chat-log" ref={log} onScroll={onLogScroll} role="log" aria-live="polite" aria-label="رسائل المحادثة">
            {view.kind !== "archive" && bashtOn && basht.windowed && <WindowBanner onBack={basht.backToLatest} />}
            {view.kind !== "archive" && bashtOn && basht.hasEarlier && basht.messages !== null && <EarlierButton onClick={() => void basht.loadEarlier()} busy={basht.loadingOlder} />}
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
                {timeline}
                {live && (
                  <>
                    <article className="bubble user">{parseVoiceNote(live.prompt).voice && <span className="voice-tag"><Icon name="mic" size={13} />رسالة صوتية</span>}{parseVoiceNote(live.prompt).text}<LiveImages images={live.images} onOpen={(its, i) => setViewer({ items: its, index: i })} /></article>
                    <article className="bubble assistant streaming" aria-busy="true">
                      <span className="who"><BrandMark size="xs" />باشت</span>
                      {liveText ? <MessageBody text={liveText} /> : <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
                      <RunSteps steps={live.steps} />
                    </article>
                  </>
                )}
                {bashtOn && basht.gate === "open" && <ApprovalInlineCard active={!!live} />}
                {claudeLive && (
                  <article className="bubble assistant streaming" aria-busy="true">
                    <span className="who"><BrandMark size="xs" />باشت</span>
                    {claudeLive.text ? <MessageBody text={claudeLive.text} /> : <span className="muted"><span className="typing" aria-hidden="true"><i /><i /><i /></span> باشت يفكّر…</span>}
                  </article>
                )}
              </>
            )}
            {view.kind === "engine" && (basht.messages === null ? <ListSkeleton rows={3} h={48} />
              : basht.messages.length ? basht.messages.map((m, i) => engineBubble(m, `r-${i}-${m.at}`, view.key)) : <Empty icon="chat" title="لا رسائل في هذه المحادثة" />)}
            {view.kind === "archive" && (archived ? archived.messages.map((m) => localBubble(archived.id, m)) : <Empty icon="archive" title="المحادثة غير موجودة" />)}
            {away && <button type="button" className="chat-jump" aria-live="off" onClick={toBottom}><span aria-hidden="true">↓</span>أحدث الرسائل</button>}
          </div>

          {view.kind === "main" ? (
            <div className="composer">
              <input ref={picker} type="file" multiple hidden aria-label="إضافة مرفقات من الجهاز" onChange={(e) => void addFiles(e.target.files)} />
              {bashtOn && basht.failedTurn && !live && <RetryBar text={basht.failedTurn.text} images={basht.failedTurn.images} disabled={busy || !ready} onRetry={() => void basht.retry()} />}
              <ComposerImages images={pics.images} preparing={pics.preparing} onRemove={pics.remove} submitting={pics.submitting}
                modelReads={modelReadsImages(model.state?.model.id, model.models)} modelName={model.state?.model.id ? replyModelName(null, model.state.model.id, model.models) : ""} />
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
                {noteMode
                  ? <button className={"icon-btn bordered mic-btn " + (recorder.recording ? "recording" : "")} data-kind="engine" disabled={noteBusy || recorder.phase === "starting" || (!recorder.recording && !!live)} aria-pressed={recorder.recording}
                      aria-label={recorder.recording ? "إنهاء التسجيل وإرسال الرسالة الصوتية" : "تسجيل رسالة صوتية لباشت (يُفرَّغ في محرك باشت)"} title="رسالة صوتية لباشت — تفريغ في محرك باشت"
                      onClick={() => (recorder.recording ? recorder.stop() : void recordNote())}><Icon name={recorder.recording ? "stop" : "mic"} size={20} /><span className="mic-kind" aria-hidden="true">باشت</span></button>
                  : <button className={"icon-btn bordered mic-btn " + (dictation.listening ? "recording" : "")} data-kind="dictation" disabled={!dictation.supported} aria-pressed={dictation.listening}
                      aria-label={dictation.listening ? "إيقاف إملاء المتصفح" : "بدء إملاء المتصفح (ليس تفريغ باشت)"} title={dictation.supported ? "إملاء المتصفح — يكتب كلامك في المربع لتراجعه" : "التعرف الصوتي غير مدعوم في هذا المتصفح"}
                      onClick={() => (dictation.listening ? dictation.stop() : dictation.start(draft, setDraft))}><Icon name={dictation.listening ? "stop" : "mic"} size={20} /><span className="mic-kind" aria-hidden="true">إملاء</span></button>}
                {live || claudeLive
                  ? <button className="icon-btn send-btn stop-btn" onClick={() => (live ? void basht.stop() : abortRef.current?.abort())} aria-label="إيقاف الرد" title="إيقاف الرد"><Icon name="stop" size={20} /></button>
                  : <button className="icon-btn send-btn" onClick={() => void send()} disabled={busy || pics.preparing || (!draft.trim() && !attachments.length && !pics.images.length)} aria-label="إرسال"><Icon name="send" size={20} style={{ transform: "scaleX(-1)" }} /></button>}
              </div>
              {(recorder.phase !== "idle" || noteBusy) && (
                <div className="voice-note-bar" role="status">
                  <span className="rec-dot" data-busy={noteBusy || recorder.starting ? "true" : undefined} aria-hidden="true" />
                  <span className="grow">{noteBusy ? "يُفرَّغ تسجيلك في محرك باشت ثم يُرسل…" : recorder.starting ? "يفتح الميكروفون… (لم يبدأ التسجيل بعد)"
                    : <>يسجّل رسالة صوتية لباشت <bdi className="num">{clock(recorder.elapsed)}</bdi> / 3:00 · أوقف التسجيل ليُفرَّغ في محرك باشت ويُرسل</>}</span>
                  {recorder.phase !== "idle" && <button type="button" className="btn btn-sm" onClick={recorder.cancel} aria-label="إلغاء التسجيل">إلغاء</button>}
                </div>
              )}
              {dictation.listening && <small role="status" style={{ color: "var(--ai-ink)" }}>إملاء المتصفح يستمع الآن (ليس تفريغ باشت)… تحدّث بالعربية ثم راجع النص قبل الإرسال.</small>}
              {(notice || pics.error || basht.error || dictation.error || recorder.error) && <small role="alert" style={{ color: "var(--danger)" }}>{notice || pics.error || basht.error || dictation.error || recorder.error}</small>}
              <small className="composer-note">محادثتك مع باشت: منفصلة عن واتساب، بذاكرة باشت المشتركة وصلاحيات المالك، والموافقات الحساسة في مساراتها. الصور تُرسل إلى باشت مضغوطة وبلا بيانات الموقع؛ المستندات تبقى على هذا الجهاز (إرسالها قريبًا).</small>
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

      <Modal open={modelOpen} onClose={() => setModelOpen(false)} label="النموذج والقدرات" variant="sheet">
        <ModelPanel models={model.models} state={model.state} busy={model.busy} error={model.error}
          onApply={(c) => { void model.apply(c).then((e) => { if (!e) toast("تم التطبيق على محادثة باشت"); }); }} onClose={() => setModelOpen(false)} />
      </Modal>

      <Modal open={voice} onClose={closeVoice} label="محادثة صوتية مع باشت" variant="voice">
        <VoicePanel live={liveVoice} autostart={voiceAuto} onClose={closeVoice}
          onUse={(t) => { closeVoice(); setView({ kind: "main" }); setDraft(t); requestAnimationFrame(() => input.current?.focus()); }} />
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
      <MediaViewer items={viewer?.items ?? []} index={viewer?.index ?? null} onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))} onClose={() => setViewer(null)} />
      <ReminderDialog open={!!offer} onClose={() => setOffer(null)} seed={offer?.draft} clarification={offer?.clarification} notes={offer?.notes} />
    </div>
  );
}
