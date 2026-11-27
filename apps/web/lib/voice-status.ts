"use client";
/**
 * What the engine SAYS about BASHT's voice (GET /api/basht/voice-status), fetched once when the conversation opens and refreshed
 * on focus at most every 60 s. It complements what the app LEARNS from real calls (the availability store in lib/basht-voice):
 *  - "mismatch" / "unconfigured": «استمع» and the live voice are hidden, with the reason said in the voice sheet;
 *  - "ready" / "degraded" / "unknown": shown — a real failure (POST speak) then updates the availability store.
 */
import { useEffect, useSyncExternalStore } from "react";
import { bashtClient, DURABLE_VOICE_REASONS, UNKNOWN_VOICE_STATUS, voiceReasonText, type VoiceReason, type VoiceStatus } from "./basht-client";

export const VOICE_STATUS_MIN_MS = 60_000;
export type VoiceStatusState = { status: VoiceStatus; at: number };

export function createVoiceStatusStore(deps: { fetch: () => Promise<VoiceStatus>; now?: () => number; minIntervalMs?: number }) {
  const now = deps.now ?? Date.now;
  const minMs = deps.minIntervalMs ?? VOICE_STATUS_MIN_MS;
  let state: VoiceStatusState = { status: UNKNOWN_VOICE_STATUS, at: 0 };
  let inflight: Promise<VoiceStatus> | null = null;
  let fetched = false;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    /** Fetches unless a fetch is in flight or the last one is younger than 60 s (`force` skips the age check). Never throws. */
    refresh({ force = false }: { force?: boolean } = {}): Promise<VoiceStatus> {
      if (inflight) return inflight;
      if (!force && fetched && now() - state.at < minMs) return Promise.resolve(state.status);
      inflight = (async () => {
        let s: VoiceStatus;
        try { s = await deps.fetch(); } catch { s = { ...UNKNOWN_VOICE_STATUS }; }
        state = { status: s, at: now() }; fetched = true;
        subs.forEach((f) => f());
        return s;
      })().finally(() => { inflight = null; });
      return inflight;
    },
    reset() { state = { status: UNKNOWN_VOICE_STATUS, at: 0 }; inflight = null; fetched = false; subs.forEach((f) => f()); },
  };
}
export type VoiceStatusStore = ReturnType<typeof createVoiceStatusStore>;
export const voiceStatusStore: VoiceStatusStore = createVoiceStatusStore({ fetch: () => bashtClient.voiceStatus() });

const SERVER: VoiceStatusState = { status: UNKNOWN_VOICE_STATUS, at: 0 };
/** The engine's voice status; fetched on mount and on focus (throttled) while `enabled` (an open BASHT conversation). */
export function useVoiceStatus(enabled: boolean, store: VoiceStatusStore = voiceStatusStore): VoiceStatus {
  useEffect(() => {
    if (!enabled) return;
    void store.refresh();
    const again = () => { if (document.visibilityState !== "hidden") void store.refresh(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [enabled, store]);
  return useSyncExternalStore(store.subscribe, () => store.get(), () => SERVER).status;
}

/** Whether BASHT's engine voice (speak) may be offered, and the honest note to show when it may not. */
export type SpeakGate = { show: boolean; note: string };
const STATE_TEXT: Partial<Record<VoiceStatus["speak"], string>> = {
  mismatch: "صوت باشت موقوف: المحرك المتصل لا يطابق هوية باشت المعتمدة في التطبيق.",
  unconfigured: "لم يُضبط صوت باشت (النطق) في المحرك بعد.",
};
export function speakGate(learned: { speak: "unknown" | "yes" | "no"; reason?: VoiceReason | "" }, status: VoiceStatus): SpeakGate {
  if (status.speak === "mismatch" || status.speak === "unconfigured") {
    return { show: false, note: voiceReasonText(status.reason) || STATE_TEXT[status.speak] || "" };
  }
  if (learned.speak === "no") return { show: false, note: voiceReasonText(learned.reason) || "صوت باشت غير مفعّل في المحرك الآن." };
  return { show: true, note: status.speak === "degraded" ? voiceReasonText(status.reason) || "صوت باشت يعمل بشكل متقطع الآن؛ قد يتعذّر النطق." : "" };
}
/** A voice failure that will not fix itself on retry (configuration): remembered as "no" so «استمع» hides. */
export const isDurableVoiceFailure = (reason: VoiceReason | undefined) => !reason || DURABLE_VOICE_REASONS.includes(reason);
