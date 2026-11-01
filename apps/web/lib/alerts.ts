/**
 * Foreground alert delivery: ONE place that turns "something happened" into inbox item + tone + speech + in-app banner.
 *  - Idempotent: the same `key` never alerts twice on a device (firedStore), even across reloads / tabs / push+foreground races.
 *  - Honest about preferences: sound off → silent; quiet hours → no sound / speech (item still lands in the inbox);
 *    autoplay blocked → reported as "blocked" so the UI can show a "tap to enable sound" prompt.
 */
import { audioPlayer, type AudioPlayer, type PlayResult } from "./audio";
import { createSpeaker, type SpeakResult } from "./speak";
import { insertNotice, type Notice, type NoticePriority, type NoticeType } from "./notifications";
import { shouldHold } from "./quiet-hours";
import { FIRED_LIMIT, firedStore, noticesStore, prefsStore } from "./stores";
import { DEFAULT_TONES, type SoundCategory } from "./sounds";

export type AlertInput = {
  key: string; type: NoticeType; priority: NoticePriority; title: string; body?: string; href?: string; reminderId?: string;
  category: SoundCategory;
  /** text to read aloud when spoken alerts are enabled */
  spoken?: string;
};
export type AlertOutcome = {
  duplicate: boolean;
  notice: Notice | null;
  sound: PlayResult | "off" | "quiet" | "duplicate";
  speech: SpeakResult | "off" | "quiet" | "duplicate" | "hidden";
};
export type AlertDeps = {
  now?: () => number;
  audio?: Pick<AudioPlayer, "play">;
  speak?: Pick<ReturnType<typeof createSpeaker>, "speak">;
  visible?: () => boolean;
  emit?: (o: AlertOutcome) => void;
  uid?: () => string;
};

const FIRED_TTL = 21 * 24 * 3600_000;

/** Categories: critical wins, then success, otherwise reminders vs. general notifications. */
export const categoryFor = (type: NoticeType, priority: NoticePriority): SoundCategory =>
  priority === "critical" || type === "security" ? "critical" : type === "reminder" ? "reminder" : "notification";

export async function deliverAlert(input: AlertInput, deps: AlertDeps = {}): Promise<AlertOutcome> {
  const now = (deps.now ?? Date.now)();
  const emit = deps.emit ?? ((o) => { if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") window.dispatchEvent(new CustomEvent("safwan:alert", { detail: o })); });
  const dup = firedStore.getSnapshot().some((f) => f.key === input.key);
  if (dup) return { duplicate: true, notice: null, sound: "duplicate", speech: "duplicate" };
  firedStore.set((old) => [{ key: input.key, ts: now }, ...old.filter((f) => now - f.ts < FIRED_TTL)].slice(0, FIRED_LIMIT));

  const notice: Notice = {
    id: (deps.uid ?? (() => crypto.randomUUID()))(), key: input.key, type: input.type, priority: input.priority,
    title: input.title, created: now, read: false,
  };
  if (input.body) notice.body = input.body;
  if (input.href) notice.href = input.href;
  if (input.reminderId) notice.reminderId = input.reminderId;
  let inserted = false;
  noticesStore.set((old) => { const r = insertNotice(old, notice); inserted = r.inserted; return r.list; });

  const prefs = prefsStore.getSnapshot();
  const held = shouldHold(now, prefs.quiet, prefs.tz, input.priority);
  let sound: AlertOutcome["sound"] = "off", speech: AlertOutcome["speech"] = "off";
  if (held) { sound = "quiet"; speech = "quiet"; }
  else {
    if (prefs.soundEnabled) {
      sound = await (deps.audio ?? audioPlayer()).play(prefs.tones[input.category] ?? DEFAULT_TONES[input.category], { volume: prefs.volume });
    }
    if (prefs.speak && input.spoken) {
      const visible = deps.visible ? deps.visible() : typeof document === "undefined" || document.visibilityState === "visible";
      speech = visible ? await (deps.speak ?? createSpeaker()).speak(input.spoken, { volume: prefs.volume }) : "hidden";
    }
  }
  const outcome: AlertOutcome = { duplicate: false, notice: inserted ? notice : null, sound, speech };
  emit(outcome);
  return outcome;
}
