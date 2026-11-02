import { DEFAULT_TZ, isValidTimeZone } from "./tz";
import { DEFAULT_QUIET, parseQuiet, type QuietHours } from "./quiet-hours";
import { DEFAULT_TONES, parseTones, type SoundCategory, type SoundId } from "./sounds";

/** Per-device notification preferences (stored on this device; the server keeps only the push-relevant subset). */
export type NotifyPrefs = {
  /** play tones for alerts while the app is open (previews in settings always work after a tap) */
  soundEnabled: boolean;
  /** 0..1 — applied to previews and in-app alerts */
  volume: number;
  tones: Record<SoundCategory, SoundId>;
  /** speak reminders aloud (Arabic) while the app is open — opt-in */
  speak: boolean;
  quiet: QuietHours;
  /** show the reminder text on the lock screen. OFF by default: pushes carry a generic text. */
  lockScreenContent: boolean;
  tz: string;
  defaultLeadMinutes: number;
};
export const DEFAULT_PREFS: NotifyPrefs = {
  soundEnabled: true, volume: 0.7, tones: { ...DEFAULT_TONES }, speak: false, quiet: { ...DEFAULT_QUIET },
  lockScreenContent: false, tz: DEFAULT_TZ, defaultLeadMinutes: 0,
};
export function parsePrefs(v: unknown): NotifyPrefs {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const vol = typeof o.volume === "number" && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : DEFAULT_PREFS.volume;
  const lead = typeof o.defaultLeadMinutes === "number" && o.defaultLeadMinutes >= 0 && o.defaultLeadMinutes <= 1440 ? Math.round(o.defaultLeadMinutes) : 0;
  return {
    soundEnabled: o.soundEnabled !== false, volume: vol, tones: parseTones(o.tones), speak: o.speak === true,
    quiet: parseQuiet(o.quiet), lockScreenContent: o.lockScreenContent === true,
    tz: typeof o.tz === "string" && isValidTimeZone(o.tz) ? o.tz : DEFAULT_TZ, defaultLeadMinutes: lead,
  };
}
/** The subset the server needs to decide HOW to deliver a push. */
export type ServerPrefs = Pick<NotifyPrefs, "lockScreenContent" | "quiet" | "tz">;
export const toServerPrefs = (p: NotifyPrefs): ServerPrefs => ({ lockScreenContent: p.lockScreenContent, quiet: p.quiet, tz: p.tz });
export function parseServerPrefs(v: unknown): ServerPrefs {
  const p = parsePrefs(v);
  return { lockScreenContent: p.lockScreenContent, quiet: p.quiet, tz: p.tz };
}
