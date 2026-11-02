/** The four original tones (synthesised by scripts/generate-sounds.py — no third-party audio). */
export type SoundId = "notification-soft" | "reminder-bell" | "critical-alert" | "success-tone";
export type SoundCategory = "notification" | "reminder" | "critical" | "success";

export type SoundDef = { id: SoundId; name: string; arabic: string; hint: string; file: string };
export const SOUNDS: SoundDef[] = [
  { id: "notification-soft", name: "Notification Soft", arabic: "إشعار هادئ", hint: "نغمة ناعمة للإشعارات العامة", file: "/sounds/notification-soft.mp3" },
  { id: "reminder-bell", name: "Reminder Bell", arabic: "جرس التذكير", hint: "جرس واضح للتذكيرات", file: "/sounds/reminder-bell.mp3" },
  { id: "critical-alert", name: "Critical Alert", arabic: "تنبيه حرج", hint: "تحذير للأحداث المهمة", file: "/sounds/critical-alert.mp3" },
  { id: "success-tone", name: "Success Tone", arabic: "نغمة النجاح", hint: "صوت قصير لإنجاز المهام", file: "/sounds/success-tone.mp3" },
];
export const SOUND_IDS = SOUNDS.map((s) => s.id);
export const isSoundId = (v: unknown): v is SoundId => typeof v === "string" && (SOUND_IDS as string[]).includes(v);
export const soundDef = (id: SoundId): SoundDef => SOUNDS.find((s) => s.id === id)!;

export const CATEGORIES: { id: SoundCategory; label: string; hint: string }[] = [
  { id: "notification", label: "الإشعارات العامة", hint: "إشعارات النظام والمساعد" },
  { id: "reminder", label: "التذكيرات", hint: "عند حلول موعد تذكير" },
  { id: "critical", label: "التنبيهات الحرجة", hint: "تذكيرات بأولوية حرجة وتنبيهات الأمان" },
  { id: "success", label: "إنجاز المهام", hint: "عند إكمال مهمة أو تذكير" },
];
export const DEFAULT_TONES: Record<SoundCategory, SoundId> = {
  notification: "notification-soft", reminder: "reminder-bell", critical: "critical-alert", success: "success-tone",
};
export function parseTones(v: unknown): Record<SoundCategory, SoundId> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_TONES };
  for (const c of CATEGORIES) if (isSoundId(o[c.id])) out[c.id] = o[c.id] as SoundId;
  return out;
}
