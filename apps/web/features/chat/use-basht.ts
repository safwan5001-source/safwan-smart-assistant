"use client";
/**
 * The live conversation with BASHT (the engine) inside the app's single chat — BASHT Core C2 + C4, used by features/chat/chat-screen.
 *
 * - Writes go only to the app's own engine session (`app:owner`); the owner's other engine conversations are read-only.
 * - A turn runs on the server: this hook polls its text, survives leaving the screen (module-scope run) and never runs two pollers.
 * - Nothing here ever pretends a message reached BASHT: `send` resolves only after the engine accepted the turn.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bashtClient, BashtError, bashtErrorText, isDefiniteRefusal, type BashtMessage, type BashtSession, type BashtStep } from "@/lib/basht-client";
import type { PreparedImage } from "@/lib/image-prep";
import { turnPreviews } from "@/lib/composer-photos";
import { localAttachments, sendWithLocalCopy, toStoredImage } from "@/lib/local-attachments";
import { turnOutcome } from "@/lib/turn-outcome";
import { reloadCurrentView } from "@/lib/history-reload";

const urlsOf = (t: { images: PreparedImage[] } | null) => (t ? t.images.map((i) => i.previewUrl) : []);
import { setAgentPhase } from "@/lib/agent-activity";

export const APP_SESSION_KEY = "agent:main:app:owner";
const POLL_MS = 1200;

// The run in flight survives client-side navigation (module scope, never persisted). Only ONE polling loop may exist:
// each new loop (or leaving the conversation / the screen) bumps the generation and the older loop exits.
type ActiveRun = { id: string; prompt: string; at: number; images?: LiveImage[] };
let activeRun: ActiveRun | null = null;
let pollGen = 0;
/** Who waits for a turn to end (the live voice session speaks the reply): resolved by the poller with the final text. */
export type RunEnd = { status: "done" | "error" | "stopped" | "lost"; text: string };
const waiters = new Map<string, (r: RunEnd) => void>();
const ended = new Map<string, RunEnd>(); // a turn that ended before anyone waited for it (last few only)
const settle = (id: string, r: RunEnd) => {
  const w = waiters.get(id);
  if (w) { waiters.delete(id); w(r); return; }
  ended.set(id, r); while (ended.size > 5) ended.delete(ended.keys().next().value!);
};
/** B1 Retry: the last owner turn that failed or was stopped (text + its photos, in memory only). */
let lastTurn: { text: string; images: PreparedImage[]; clientMsgId?: string } | null = null;

export type BashtGate = "checking" | "disabled" | "locked" | "open";
/** `blob`: the same bytes that were sent (the viewer shares/downloads them without fetching a blob: URL). */
export type LiveImage = { name: string; previewUrl: string; blob?: Blob };
export type BashtLive = { prompt: string; text: string; at: number; images?: LiveImage[]; steps?: BashtStep[]; runId?: string };
/** Where older rows come from: an `earlier` cursor (also across «محادثة جديدة») or the engine's offset paging. */
type Older = { before: string } | { offset: number } | null;
const olderOf = (p: { earlier: string | null; hasMore: boolean; nextOffset: number | null }): Older =>
  p.earlier ? { before: p.earlier } : p.hasMore && p.nextOffset !== null ? { offset: p.nextOffset } : null;
/** An older page may land only while the cursor it was requested with is still the view's cursor (same value). */
export const sameOlder = (a: Older, b: Older) => JSON.stringify(a) === JSON.stringify(b);
const rowKey = (m: BashtMessage) => m.id ?? `${m.role}:${m.at}:${m.text.slice(0, 40)}`;
export const mergeRows = (a: BashtMessage[], b: BashtMessage[]) => {
  const seen = new Set<string>(); const out: BashtMessage[] = [];
  for (const m of [...a, ...b]) { const k = rowKey(m); if (seen.has(k)) continue; seen.add(k); out.push(m); }
  return out;
};
/**
 * After a refresh, the newest page moved forward (a turn added rows): rows of the previous newest page that are no longer in it
 * sit between the earlier rows already paged in and the new page — keep them there, so nothing loaded disappears. Without
 * earlier rows paged in, the page's own cursor still reaches them, so nothing is kept.
 */
/**
 * Earlier rows after loading the newest page. From a search window (turn completion, refresh, «العودة إلى الأحدث») the
 * anchored state is reset entirely — the window and its earlier pages belong to another place in the conversation — and only
 * the newest page is shown (its own cursor reaches everything older). From the newest page, rows that slid off are kept.
 */
export function rowsAfterLoad(windowed: boolean, olderRows: BashtMessage[], prevLatest: BashtMessage[] | null, nextLatest: BashtMessage[]):
  { olderRows: BashtMessage[]; leftWindow: boolean } {
  if (windowed) return { olderRows: olderRows.length ? [] : olderRows, leftWindow: true };
  return { olderRows: reconcileOlder(olderRows, prevLatest, nextLatest), leftWindow: false };
}

export function reconcileOlder(olderRows: BashtMessage[], prevLatest: BashtMessage[] | null, nextLatest: BashtMessage[]): BashtMessage[] {
  if (!olderRows.length || !prevLatest?.length) return olderRows;
  const next = new Set(nextLatest.map(rowKey));
  const dropped = prevLatest.filter((m) => !next.has(rowKey(m)));
  return dropped.length ? mergeRows(olderRows, dropped) : olderRows;
}
const errText = (e: unknown) => (e instanceof BashtError ? e.message : bashtErrorText("unavailable"));

/** `enabled` = the server says the BASHT chat is configured (/api/health features.basht_chat). `key` = engine conversation on screen. */
export function useBashtConversation(enabled: boolean, key: string | null) {
  const [gate, setGate] = useState<BashtGate>("checking");
  const [sessions, setSessions] = useState<BashtSession[]>([]);
  const [messages, setMessages] = useState<BashtMessage[] | null>(null);
  const [live, setLive] = useState<BashtLive | null>(null);
  const [error, setError] = useState("");
  // B1: rows paged in above the newest page (kept across refreshes), where the next older page comes from, a search-hit window
  const [olderRows, setOlderRows] = useState<BashtMessage[]>([]);
  const [older, setOlderState] = useState<Older>(null);
  const olderRef = useRef<Older>(null); // the cursor now in force, for responses that arrive later
  const setOlder = useCallback((o: Older) => { olderRef.current = o; setOlderState(o); }, []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // every deliberate focus request (a search pick, an earlier page) gets its own number: picking the same hit again scrolls again
  const [focusReq, setFocusReq] = useState(0);
  const requestFocus = useCallback((id: string) => { setFocusId(id); setFocusReq((n) => n + 1); }, []);
  const [windowed, setWindowed] = useState(false);
  const [failedTurn, setFailedTurn] = useState<{ text: string; images: number } | null>(lastTurn ? { text: lastTurn.text, images: lastTurn.images.length } : null);
  const [resetting, setResetting] = useState(false);
  const olderRowsRef = useRef<BashtMessage[]>([]);
  olderRowsRef.current = olderRows;
  const messagesRef = useRef<BashtMessage[] | null>(null);
  messagesRef.current = messages;
  const keyRef = useRef(key);
  keyRef.current = key;
  const loadGen = useRef(0);
  const jumpGen = useRef(0); // the latest search-hit pick: an earlier pick's window never lands after it
  // B1: which history VIEW is on screen. Opening a conversation, «العودة إلى الأحدث» / refresh, «محادثة جديدة» and a search
  // window each start a new view; an older page requested for an abandoned view is dropped when it arrives.
  const viewGen = useRef(0);
  const windowedRef = useRef(false); // a search window (not the newest page) is on screen
  const windowAnchor = useRef<string | null>(null); // …and the message it was opened around

  // Only the latest load for the conversation still on screen may write: a slower, older response is dropped.
  const load = useCallback(async (k: string, keepError = false) => {
    const gen = ++loadGen.current;
    const current = () => gen === loadGen.current && keyRef.current === k;
    try {
      const [list, page] = await Promise.all([bashtClient.sessions(), bashtClient.historyPage(k)]);
      if (!current()) return;
      const next = rowsAfterLoad(windowedRef.current, olderRowsRef.current, messagesRef.current, page.messages);
      if (next.leftWindow) { windowedRef.current = false; viewGen.current++; setFocusId(null); }
      if (next.leftWindow) windowAnchor.current = null; // the window (and what it was opened around) is gone
      if (next.olderRows !== olderRowsRef.current) { olderRowsRef.current = next.olderRows; setOlderRows(next.olderRows); }
      setSessions(list); setMessages(page.messages); setWindowed(false);
      // older rows already paged in stay above; the cursor continues from them, else from this page
      if (!olderRowsRef.current.length) setOlder(olderOf(page));
      if (!keepError) setError("");
    } catch (e) {
      if (!current()) return;
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      setMessages((m) => m ?? []); setError(errText(e));
    }
  }, [setOlder]);

  const poll = useCallback(async (run: ActiveRun) => {
    const gen = ++pollGen;
    const mine = () => gen === pollGen && activeRun?.id === run.id;
    setLive({ prompt: run.prompt, text: "", at: run.at, images: run.images, runId: run.id });
    // the finished turn belongs to the App session: refresh it only if that is still the conversation on screen
    // the live bubble stays until the refreshed history is on screen, so the reply never blinks out in between
    const finish = async () => { if (keyRef.current === APP_SESSION_KEY) await load(APP_SESSION_KEY, true); setLive(null); };
    let first = true;
    while (mine()) {
      try {
        const r = await bashtClient.run(run.id);
        if (!mine()) return;
        if (first && r.text) { first = false; setAgentPhase("responding"); }
        setLive({ prompt: run.prompt, text: r.text, at: run.at, images: run.images, steps: r.steps ?? [], runId: run.id });
        if (r.status !== "running") {
          activeRun = null;
          // a finished turn needs its photo previews no more (its bubble is replaced by the engine's copy below); a failed or
          // stopped one keeps them for «إعادة المحاولة»; a rate limit keeps nothing (a resend would only hit the limit again)
          const out = turnOutcome(r, lastTurn);
          const finished = out.finished;
          lastTurn = out.nextLastTurn;
          setFailedTurn(out.failed ? { text: out.failed.text, images: out.failed.images.length } : null);
          localAttachments().markDone(run.id, r.status === "done" ? "done" : r.status === "stopped" ? "stopped" : "error"); // how the turn ended decides what a text match may do
          settle(run.id, { status: r.status, text: out.endText });
          setAgentPhase(r.status === "done" ? "replied" : r.status === "stopped" ? "stopped" : "reply_failed");
          if (out.error) setError(out.error);
          await finish();
          if (finished) turnPreviews.release(urlsOf(finished));
          return;
        }
      } catch (e) {
        if (!mine()) return;
        if (e instanceof BashtError && e.code === "not_found") { activeRun = null; settle(run.id, { status: "lost", text: "" }); await finish(); return; }
        // session expired / code rotated: back to the unlock form; activeRun is kept, so the reply resumes after unlocking
        if (e instanceof BashtError && e.code === "unauthorized") { setLive(null); setGate("locked"); return; }
        setError(errText(e));
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) { setGate("disabled"); return; }
    let alive = true;
    void bashtClient.status().then((s) => { if (alive) setGate(!s.enabled ? "disabled" : s.authenticated ? "open" : "locked"); });
    return () => { alive = false; };
  }, [enabled]);

  useEffect(() => {
    if (gate !== "open" || !key) return;
    messagesRef.current = null; olderRowsRef.current = []; windowAnchor.current = null; // a new conversation on screen: nothing to reconcile with
    viewGen.current++;
    windowedRef.current = false;
    setMessages(null); setOlderRows([]); setOlder(null); setFocusId(null); setWindowed(false);
    void load(key);
    if (activeRun && key === APP_SESSION_KEY) void poll(activeRun);
    else setLive(null);
    return () => { pollGen++; }; // leaving the App conversation or the screen stops this consumer; the turn keeps running server-side
  }, [gate, key, load, poll, setOlder]);

  /** After the unified owner sign-in (A1): the session cookie is set, so the gate is re-read from the server — never assumed. */
  const recheck = useCallback(async () => {
    const s = await bashtClient.status();
    setGate(!s.enabled ? "disabled" : s.authenticated ? "open" : "locked");
    if (s.authenticated) setError("");
  }, []);

  const unlock = useCallback(async (code: string) => {
    const ok = await bashtClient.unlock(code);
    if (ok) { setError(""); setGate("open"); }
    return ok;
  }, []);

  /** Starts one owner turn and returns its run id. Throws BashtError (Arabic message) if the engine did not accept it — the caller
   *  keeps the draft. B2: `images` (already downscaled, EXIF-free) ride on the same turn. */
  const send = useCallback(async (text: string, images: PreparedImage[] = [], opts: { supersedes?: string | null } = {}) => {
    // R5: the photos stay on this device too (IndexedDB; memory-only where that is unavailable) so the message keeps its picture
    // after the history reloads (lib/local-attachments: registered before the request, forgotten if the engine refuses the turn).
    const stored = images.map(toStoredImage);
    let clientMsgId: string | undefined;
    try {
      let id: string;
      if (images.length) {
        const sent = await sendWithLocalCopy(localAttachments(), { text, images: stored, supersedes: opts.supersedes, isRefusal: isDefiniteRefusal,
          post: () => bashtClient.sendMedia(text, images.map((i) => ({ mime: i.mime, data: i.data }))) });
        id = sent.runId; clientMsgId = sent.clientMsgId;
      } else id = await bashtClient.send(text);
      setError(""); setFailedTurn(null); setFocusId(null);
      setAgentPhase("thinking");
      const prev = lastTurn;
      lastTurn = { text, images, clientMsgId };
      turnPreviews.adopt(urlsOf(lastTurn));
      if (prev) turnPreviews.release(urlsOf(prev), urlsOf(lastTurn)); // a newer turn replaced it (a retry keeps the same photos)
      activeRun = { id, prompt: text, at: Date.now(), images: images.map((i, k) => ({ name: i.name, previewUrl: i.previewUrl, blob: stored[k]?.blob })) };
      void poll(activeRun);
      return id;
    } catch (e) {
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      throw e instanceof BashtError ? e : new BashtError("unavailable");
    }
  }, [poll]);

  /** Resolves when that turn has ended (its final text), as the poller sees it. Gives up after the engine's own turn limit. */
  const waitRun = useCallback((id: string) => new Promise<RunEnd>((resolve) => {
    const done = ended.get(id);
    if (done) { ended.delete(id); resolve(done); return; }
    const t = setTimeout(() => settle(id, { status: "lost", text: "" }), 15 * 60_000);
    waiters.set(id, (r) => { clearTimeout(t); resolve(r); });
  }), []);

  const stop = useCallback(async () => { if (activeRun) { try { await bashtClient.stop(activeRun.id); } catch (e) { setError(errText(e)); } } }, []);
  // the old cursor goes too: «عرض الرسائل السابقة» waits for the refreshed page's own cursor (a request on the discarded one
  // would land rows before a gap that paging can never fill)
  const refresh = useCallback(() => { if (keyRef.current) { viewGen.current++; olderRowsRef.current = []; setOlderRows([]); setOlder(null); setFocusId(null); void load(keyRef.current); } }, [load, setOlder]);

  /** B1 Retry: re-sends the last failed/stopped owner turn through the same send path (same text, same photos). */
  const retry = useCallback(async () => {
    const t = lastTurn;
    if (!t || activeRun) return;
    try { await send(t.text, t.images, { supersedes: t.clientMsgId }); } catch (e) { setError(errText(e)); }
  }, [send]);

  /** B1 «محادثة جديدة»: the engine starts a fresh context for the app conversation; every earlier message stays readable. */
  const newConversation = useCallback(async (): Promise<string | null> => {
    if (activeRun) return bashtErrorText("busy");
    setResetting(true);
    try {
      await bashtClient.newConversation();
      turnPreviews.release(urlsOf(lastTurn)); lastTurn = null; setFailedTurn(null);
      // only the app conversation was reset: another conversation on screen keeps its history, earlier rows and cursor
      if (keyRef.current === APP_SESSION_KEY) {
        viewGen.current++; olderRowsRef.current = []; setOlderRows([]); setOlder(null); setFocusId(null);
        await load(APP_SESSION_KEY);
      }
      return null;
    } catch (e) {
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      return errText(e);
    } finally { setResetting(false); }
  }, [load, setOlder]);

  /** B1: the next older page (offset paging, then across «محادثة جديدة»); keeps the reading position on the first old row. */
  const loadEarlier = useCallback(async () => {
    const k = keyRef.current;
    if (!k || !older || loadingOlder) return;
    const view = viewGen.current;
    const cursor = older;
    setLoadingOlder(true);
    try {
      const page = await bashtClient.historyPage(k, cursor);
      // the view it belonged to was left meanwhile, or its cursor was replaced (a refresh, a newer page): dropped
      if (keyRef.current !== k || view !== viewGen.current || !sameOlder(cursor, olderRef.current)) return;
      // the first row drawn with an anchor (a «محادثة جديدة» divider has none: after a reset the newest page starts with one)
      const firstShown = [...olderRows, ...(messages ?? [])].find((m) => m.id && m.kind !== "reset")?.id ?? null;
      setOlderRows((o) => mergeRows(page.messages, o));
      setOlder(olderOf(page));
      if (firstShown) requestFocus(firstShown);
    } catch (e) { setError(errText(e)); } finally { setLoadingOlder(false); }
  }, [older, loadingOlder, olderRows, messages, setOlder, requestFocus]);

  /** B1 search hit: the message itself if it is on screen, else a window around it (read-only until «العودة إلى الأحدث»). */
  const jumpTo = useCallback(async (messageId: string) => {
    const k = keyRef.current;
    if (!k) return;
    const pick = ++jumpGen.current; // a hit picked later (even one already on screen) supersedes this one
    if ([...olderRows, ...(messages ?? [])].some((m) => m.id === messageId)) { requestFocus(messageId); return; }
    const gen = ++loadGen.current; // a plain load still in flight for this conversation must not replace the window
    viewGen.current++; // nor may an older page requested for the previous view land in this window
    try {
      const page = await bashtClient.historyPage(k, { around: messageId });
      if (keyRef.current !== k || gen !== loadGen.current || pick !== jumpGen.current) return;
      viewGen.current++; // an older page requested while this window loaded belongs to the previous view: it is dropped
      olderRowsRef.current = []; windowedRef.current = true; windowAnchor.current = messageId;
      setMessages(page.messages); setOlderRows([]); setOlder(olderOf(page)); setWindowed(true); requestFocus(messageId);
    } catch (e) { setError(errText(e)); }
  }, [olderRows, messages, setOlder, requestFocus]);
  /** A picture's «إعادة المحاولة»: re-reads what is on screen. In a search window that is the window itself (media refreshed in place;
   *  the window, its focus and the paged-in rows stay); on the newest page, the ordinary load (what is paged in is kept). */
  const reload = useCallback(async () => {
    const k = keyRef.current;
    if (!k) return;
    const inWindow = windowedRef.current && !!windowAnchor.current;
    const gen = inWindow ? ++loadGen.current : loadGen.current; // a window refresh supersedes an older load in flight (the newest-page load takes its own turn)
    const view = viewGen.current;
    try {
      const out = await reloadCurrentView({ windowed: windowedRef.current, anchor: windowAnchor.current, loadLatest: () => load(k, true),
        fetchAround: (id) => bashtClient.historyPage(k, { around: id }) });
      if (out.kind === "window" && keyRef.current === k && gen === loadGen.current && view === viewGen.current && windowedRef.current) setMessages(out.messages);
    } catch (e) { if (keyRef.current === k) setError(errText(e)); }
  }, [load]);
  const backToLatest = useCallback(() => { setFocusId(null); refresh(); }, [refresh]);

  // one array per real change of the history: a new array on every render would re-run the screen's scroll effect (e.g. on each
  // keystroke) and pull the owner back to the focused message while reading elsewhere
  const shown = useMemo(() => (messages === null ? null : olderRows.length ? mergeRows(olderRows, messages) : messages), [olderRows, messages]);
  return { gate, sessions, messages: shown, live, error, unlock, recheck, send, waitRun, stop, refresh,
    retry, failedTurn, newConversation, resetting, loadEarlier, hasEarlier: older !== null, loadingOlder, jumpTo, focusId, focusReq, setFocusId, windowed, backToLatest, reload };
}
