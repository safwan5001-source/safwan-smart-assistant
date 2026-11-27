"use client";
/**
 * The live conversation with BASHT (the engine) inside the app's single chat — BASHT Core C2 + C4, used by features/chat/chat-screen.
 *
 * - Writes go only to the app's own engine session (`app:owner`); the owner's other engine conversations are read-only.
 * - A turn runs on the server: this hook polls its text, survives leaving the screen (module-scope run) and never runs two pollers.
 * - Nothing here ever pretends a message reached BASHT: `send` resolves only after the engine accepted the turn.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bashtClient, BashtError, bashtErrorText, type BashtMessage, type BashtSession } from "@/lib/basht-client";
import { setAgentPhase } from "@/lib/agent-activity";

export const APP_SESSION_KEY = "agent:main:app:owner";
const POLL_MS = 1200;

// The run in flight survives client-side navigation (module scope, never persisted). Only ONE polling loop may exist:
// each new loop (or leaving the conversation / the screen) bumps the generation and the older loop exits.
let activeRun: { id: string; prompt: string; at: number } | null = null;
let pollGen = 0;

export type BashtGate = "checking" | "disabled" | "locked" | "open";
export type BashtLive = { prompt: string; text: string; at: number };
const errText = (e: unknown) => (e instanceof BashtError ? e.message : bashtErrorText("unavailable"));

/** `enabled` = the server says the BASHT chat is configured (/api/health features.basht_chat). `key` = engine conversation on screen. */
export function useBashtConversation(enabled: boolean, key: string | null) {
  const [gate, setGate] = useState<BashtGate>("checking");
  const [sessions, setSessions] = useState<BashtSession[]>([]);
  const [messages, setMessages] = useState<BashtMessage[] | null>(null);
  const [live, setLive] = useState<BashtLive | null>(null);
  const [error, setError] = useState("");
  const keyRef = useRef(key);
  keyRef.current = key;
  const loadGen = useRef(0);

  // Only the latest load for the conversation still on screen may write: a slower, older response is dropped.
  const load = useCallback(async (k: string, keepError = false) => {
    const gen = ++loadGen.current;
    const current = () => gen === loadGen.current && keyRef.current === k;
    try {
      const [list, msgs] = await Promise.all([bashtClient.sessions(), bashtClient.history(k)]);
      if (!current()) return;
      setSessions(list); setMessages(msgs);
      if (!keepError) setError("");
    } catch (e) {
      if (!current()) return;
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      setMessages((m) => m ?? []); setError(errText(e));
    }
  }, []);

  const poll = useCallback(async (run: { id: string; prompt: string; at: number }) => {
    const gen = ++pollGen;
    const mine = () => gen === pollGen && activeRun?.id === run.id;
    setLive({ prompt: run.prompt, text: "", at: run.at });
    // the finished turn belongs to the App session: refresh it only if that is still the conversation on screen
    // the live bubble stays until the refreshed history is on screen, so the reply never blinks out in between
    const finish = async () => { if (keyRef.current === APP_SESSION_KEY) await load(APP_SESSION_KEY, true); setLive(null); };
    let first = true;
    while (mine()) {
      try {
        const r = await bashtClient.run(run.id);
        if (!mine()) return;
        if (first && r.text) { first = false; setAgentPhase("responding"); }
        setLive({ prompt: run.prompt, text: r.text, at: run.at });
        if (r.status !== "running") {
          activeRun = null;
          setAgentPhase(r.status === "done" ? "replied" : r.status === "stopped" ? "stopped" : "reply_failed");
          if (r.status === "error") setError("تعذّر إكمال الرد من باشت. أعد المحاولة.");
          if (r.status === "stopped") setError("أُوقف الرد.");
          await finish();
          return;
        }
      } catch (e) {
        if (!mine()) return;
        if (e instanceof BashtError && e.code === "not_found") { activeRun = null; await finish(); return; }
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
    setMessages(null);
    void load(key);
    if (activeRun && key === APP_SESSION_KEY) void poll(activeRun);
    else setLive(null);
    return () => { pollGen++; }; // leaving the App conversation or the screen stops this consumer; the turn keeps running server-side
  }, [gate, key, load, poll]);

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

  /** Starts one owner turn. Throws BashtError (Arabic message) if the engine did not accept it — the caller keeps the draft. */
  const send = useCallback(async (text: string) => {
    try {
      const id = await bashtClient.send(text);
      setError("");
      setAgentPhase("thinking");
      activeRun = { id, prompt: text, at: Date.now() };
      void poll(activeRun);
    } catch (e) {
      if (e instanceof BashtError && e.code === "unauthorized") setGate("locked");
      throw e instanceof BashtError ? e : new BashtError("unavailable");
    }
  }, [poll]);

  const stop = useCallback(async () => { if (activeRun) { try { await bashtClient.stop(activeRun.id); } catch (e) { setError(errText(e)); } } }, []);
  const refresh = useCallback(() => { if (keyRef.current) void load(keyRef.current); }, [load]);

  return { gate, sessions, messages, live, error, unlock, recheck, send, stop, refresh };
}
