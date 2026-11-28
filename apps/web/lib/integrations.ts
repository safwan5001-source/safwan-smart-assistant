import type { Risk } from "./permissions";

/**
 * REFERENCE ONLY — not rendered anywhere (R11). It used to feed a list in which every service read «قيد التخطيط», a claim nobody
 * could check. The integrations screen now shows only what the engine reports (features/integrations/basht-capabilities.tsx), and
 * this catalogue carries NO status at all: it keeps the brand layer (lib/integration-brands.ts) and the scope wording in one place.
 */
export type IntegrationDef = {
  id: string; name: string; category: string; description: string;
  scopes: { title: string; risk: Risk }[];
};

export const CATEGORY_LABEL: Record<string, string> = {
  development: "التطوير", hosting: "الاستضافة", email: "البريد", files: "الملفات",
  scheduling: "الجدولة", accounting: "المحاسبة", automation: "الأتمتة",
};

const R: Risk = "read", W: Risk = "write", S: Risk = "sensitive";
export const INTEGRATIONS: IntegrationDef[] = [
  { id: "github", name: "GitHub", category: "development", description: "المستودعات وطلبات الدمج والتحقق من البناء.", scopes: [{ title: "قراءة طلبات الدمج", risk: R }, { title: "دمج طلب", risk: S }] },
  { id: "vercel", name: "Vercel", category: "hosting", description: "متابعة النشر والبيئات.", scopes: [{ title: "قراءة عمليات النشر", risk: R }, { title: "إنشاء نشر", risk: S }] },
  { id: "railway", name: "Railway", category: "hosting", description: "خدمات التطبيق وقواعد البيانات.", scopes: [{ title: "قراءة الخدمات", risk: R }] },
  { id: "gmail", name: "Gmail", category: "email", description: "قراءة الرسائل ومتابعة العمل.", scopes: [{ title: "قراءة البريد", risk: R }, { title: "إرسال بريد", risk: S }] },
  { id: "google_drive", name: "Google Drive", category: "files", description: "الوصول إلى المستندات والملفات السحابية.", scopes: [{ title: "قراءة الملفات", risk: R }, { title: "حفظ الملفات", risk: W }] },
  { id: "google_calendar", name: "Google Calendar", category: "scheduling", description: "المواعيد والتنبيهات.", scopes: [{ title: "قراءة المواعيد", risk: R }, { title: "إنشاء مواعيد", risk: W }] },
  { id: "daftra", name: "دفترة", category: "accounting", description: "إدخال الفواتير والتحقق من مراجعها عبر الواجهة.", scopes: [{ title: "قراءة الفواتير", risk: R }, { title: "إنشاء فاتورة", risk: W }] },
  { id: "windows_worker", name: "Windows السحابي", category: "automation", description: "تنفيذ المهام على الكمبيوتر السحابي بالشاشة والماوس.", scopes: [{ title: "التقاط الشاشة", risk: R }, { title: "التحكم بالإدخال", risk: W }] },
];
