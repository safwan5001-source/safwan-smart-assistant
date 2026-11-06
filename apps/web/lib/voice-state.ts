/**
 * Microphone/dictation state for the voice screen. Deliberately a separate vocabulary from the agent state
 * (lib/agent-activity.ts): listening to the user is not BASHT thinking, replying or being connected to Claude.
 */
export type VoiceState = "unsupported" | "ready" | "listening" | "error";

export function voiceState(d: { supported: boolean; listening: boolean; error: string }): VoiceState {
  if (!d.supported) return "unsupported";
  if (d.listening) return "listening";
  return d.error ? "error" : "ready";
}

export const VOICE_TEXT: Record<VoiceState, { title: string; sub: string }> = {
  unsupported: { title: "الإملاء غير مدعوم هنا", sub: "هذا المتصفح لا يوفّر التعرف على الكلام. استخدم Safari محدّثًا أو إملاء لوحة المفاتيح." },
  ready: { title: "الميكروفون جاهز", sub: "اضغط الميكروفون وتحدّث بالعربية، ثم راجع النص وأرسله لباشت." },
  listening: { title: "يُسجَّل كلامك…", sub: "هذا تفريغ صوتي فقط؛ باشت لا يرد بعد. اضغط الزر مرة أخرى للإيقاف." },
  error: { title: "توقّف الإملاء", sub: "راجع الرسالة أدناه ثم حاول مرة أخرى." },
};
