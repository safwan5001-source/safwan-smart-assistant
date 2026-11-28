"use client";
/**
 * «استمع» on one BASHT reply: that reply spoken in BASHT's own voice (the engine's agent tts config). Self-contained: it reads the
 * ONE shared player, the voice the engine offers (learned) and what voice-status says, so it stays correct inside a memoized
 * timeline and needs nothing from the conversation screen but the reply's STABLE id (the engine row id) and text.
 *
 * States (honest, from the player's media events): ready · preparing (fetching the voice) · playing (audio really started) ·
 * error (+ «أعد المحاولة», or «شغّل الصوت» to continue the same audio after a blocked autoplay / OS interruption).
 * A failed /speak is never retried on its own: the provider call may already be billed — the owner decides.
 */
import Icon from "@/components/icon";
import { enterVoiceSession, leaveVoiceSession, type VoiceToken } from "@/lib/audio";
import { usePlayer, useVoiceAvailability, voicePlayer, type PlayerState } from "@/lib/basht-voice";
import { speakGate, voiceStatusStore } from "@/lib/voice-status";
import { useSyncExternalStore } from "react";

export type ListenState = "ready" | "preparing" | "playing" | "error";
export const listenState = (p: PlayerState, id: string): ListenState =>
  p.id !== id ? "ready" : p.phase === "idle" ? "ready" : p.phase;

const LABEL: Record<ListenState, { text: string; aria: string }> = {
  ready: { text: "استمع", aria: "استمع إلى الرد بصوت باشت" },
  preparing: { text: "يجهّز الصوت…", aria: "يجهّز صوت باشت لهذا الرد — اضغط للإلغاء" },
  playing: { text: "إيقاف", aria: "إيقاف صوت باشت" },
  error: { text: "أعد المحاولة", aria: "تعذّر تشغيل صوت باشت — أعد المحاولة" },
};
/** The button's text/label for a state (the resumable error says «شغّل الصوت»: same audio, no new request). */
export function listenLabel(state: ListenState, resumable: boolean): { text: string; aria: string } {
  if (state === "error" && resumable) return { text: "شغّل الصوت", aria: "تابِع تشغيل صوت باشت" };
  return LABEL[state];
}

const SERVER_STATUS = voiceStatusStore.get();
/** The audio-session token of the latest «استمع» tap: given back only by its own owner (a live session that took over keeps its). */
let listenToken: VoiceToken | null = null;
/** Called inside the «استمع» tap; `after` gives the session back when this reply is over (unless someone else owns it by then). */
export function listenSession(enter = enterVoiceSession, leave = leaveVoiceSession) {
  const t = enter("playback");
  listenToken = t;
  return { token: t, after: () => { leave(t); if (listenToken === t) listenToken = null; } };
}
export const stopListenSession = (leave = leaveVoiceSession) => { leave(listenToken); listenToken = null; };
export default function ListenButton({ id, text }: { id: string; text: string }) {
  const player = usePlayer();
  const avail = useVoiceAvailability();
  const status = useSyncExternalStore(voiceStatusStore.subscribe, voiceStatusStore.get, () => SERVER_STATUS).status;
  if (!speakGate(avail, status).show || !text.trim()) return null; // the engine has no voice: the reply stays text, nothing pretends
  const state = listenState(player, id);
  const resumable = state === "error" && player.canResume;
  const tap = () => {
    const p = voicePlayer();
    // inside the tap: the playback audio session and the element unlock, so iOS plays the reply once its audio has arrived
    if (state === "preparing" || state === "playing") { p.stop(); stopListenSession(); return; }
    // when this reply is over (done, failed or stopped), the page's audio session goes back to "auto" — only if this tap still
    // owns it (the live session, or another reply, may have taken it meanwhile: their token wins)
    const { after } = listenSession();
    if (resumable) { void p.resume().then(after); return; }
    p.unlock();
    void p.play(id, text).then(after);
  };
  const l = listenLabel(state, resumable);
  return (
    <span className="listen-wrap">
      <button type="button" className="listen-btn" data-state={state} onClick={tap} aria-pressed={state === "playing" || state === "preparing"}
        aria-label={l.aria} title={state === "error" ? player.error : undefined}>
        {state === "preparing" ? <span className="spin" aria-hidden="true" /> : <Icon name={state === "playing" ? "stop" : state === "error" ? "repeat" : "volume"} size={15} />}
        <span>{l.text}</span>
      </button>
      {state === "error" && <small className="listen-error" role="status">{player.error}</small>}
    </span>
  );
}
