/** B1: «يستخدم أداة: …» — what a BASHT tool is called in the chat. Names come from the engine (ids only, never arguments). */
const LABELS: Record<string, string> = {
  read: "قراءة ملف", write: "كتابة ملف", edit: "تعديل ملف", apply_patch: "تعديل ملفات", ls: "عرض مجلد", exec: "تشغيل أمر", process: "متابعة عملية",
  web_search: "بحث في الويب", web_fetch: "قراءة صفحة ويب", browser: "المتصفح", computer: "التحكم بالحاسوب", image: "تحليل صورة",
  image_generate: "إنشاء صورة", pdf: "قراءة PDF", tts: "تحويل نص إلى صوت", message: "إرسال رسالة", cron: "المهام المجدولة",
  memory_search: "البحث في الذاكرة", memory_get: "قراءة الذاكرة", sessions_list: "المحادثات", sessions_history: "سجل محادثة",
  sessions_send: "مراسلة جلسة", sessions_spawn: "تشغيل وكيل فرعي", session_status: "حالة الجلسة", sessions: "إعدادات الجلسة",
  canvas: "اللوحة", nodes: "الأجهزة", gateway: "البوابة", agents_list: "الوكلاء",
};

/** Arabic label for a tool id; an unknown tool is shown by its id (already restricted to [A-Za-z0-9_.:-] by the bridge). */
export function toolLabel(tool: string): string {
  const t = String(tool ?? "").trim();
  if (LABELS[t]) return LABELS[t];
  if (t.startsWith("mcp__") || t.includes("__")) return t.split("__").filter(Boolean).slice(-1)[0] ?? t;
  return t || "أداة";
}
