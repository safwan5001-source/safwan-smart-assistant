"use client";
/**
 * «استمع» on one BASHT reply: that reply spoken in BASHT's own voice (the engine's agent tts config). Self-contained: it reads the
 * ONE shared player and the engine's voice availability itself (useSyncExternalStore), so it stays correct inside a memoized
 * timeline and needs nothing from the conversation screen but the reply's id and text. One playback at a time, app-wide.
 */
import Icon from "@/components/icon";
import { usePlayer, useVoiceAvailability, voicePlayer } from "@/lib/basht-voice";

export default function ListenButton({ id, text }: { id: string; text: string }) {
  const player = usePlayer();
  const avail = useVoiceAvailability();
  if (avail.speak === "no" || !text.trim()) return null; // the engine has no voice: the reply stays text, nothing pretends
  const state = player.id === id ? player.phase : "idle";
  const toggle = () => {
    const p = voicePlayer();
    if (p.getSnapshot().id === id) { p.stop(); return; }
    p.unlock(); // inside the tap: iOS then lets the reply play once its audio has arrived
    void p.play(id, text);
  };
  return (
    <button type="button" className="listen-btn" data-state={state} onClick={toggle} aria-pressed={state !== "idle"}
      aria-label={state === "idle" ? "استمع إلى الرد بصوت باشت" : "إيقاف الاستماع"}>
      {state === "loading" ? <span className="spin" aria-hidden="true" /> : <Icon name={state === "playing" ? "stop" : "volume"} size={15} />}
      <span>{state === "loading" ? "يحضّر الصوت…" : state === "playing" ? "إيقاف" : "استمع"}</span>
    </button>
  );
}
