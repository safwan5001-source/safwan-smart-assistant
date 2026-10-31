import type { Risk } from "./permissions";

export type IntegrationStatus = "planned" | "not_configured" | "configured_unverified" | "connected";
export type IntegrationDef = {
  id: string; name: string; category: string; description: string;
  scopes: { title: string; risk: Risk }[]; status: IntegrationStatus;
};

export const STATUS_LABEL: Record<IntegrationStatus, { label: string; hint: string }> = {
  planned: { label: "قيد التخطيط", hint: "لا يوجد موصل برمجي لهذه الخدمة بعد." },
  not_configured: { label: "غير مهيأ", hint: "الموصل موجود لكن بيانات الاعتماد غير مضافة على الخادم." },
  configured_unverified: { label: "غير موثّق", hint: "بيانات الاعتماد موجودة ولم يُتحقق من عملها." },
  connected: { label: "متصل", hint: "نجح فحص حي للاتصال." },
};

export const CATEGORY_LABEL: Record<string, string> = {
  development: "التطوير", hosting: "الاستضافة", email: "البريد", files: "الملفات",
  scheduling: "الجدولة", accounting: "المحاسبة", automation: "الأتمتة",
};

/** Static mirror of services/api/app/integrations/catalog.py. Every status is "planned": the public API
 *  exposes no integration state (protected endpoints are locked in production), so the UI claims nothing more. */
const R: Risk = "read", W: Risk = "write", S: Risk = "sensitive";
export const INTEGRATIONS: IntegrationDef[] = [
  { id: "github", name: "GitHub", category: "development", description: "المستودعات وطلبات الدمج والتحقق من البناء.", status: "planned", scopes: [{ title: "قراءة طلبات الدمج", risk: R }, { title: "دمج طلب", risk: S }] },
  { id: "vercel", name: "Vercel", category: "hosting", description: "متابعة النشر والبيئات.", status: "planned", scopes: [{ title: "قراءة عمليات النشر", risk: R }, { title: "إنشاء نشر", risk: S }] },
  { id: "railway", name: "Railway", category: "hosting", description: "خدمات التطبيق وقواعد البيانات.", status: "planned", scopes: [{ title: "قراءة الخدمات", risk: R }] },
  { id: "gmail", name: "Gmail", category: "email", description: "قراءة الرسائل ومتابعة العمل.", status: "planned", scopes: [{ title: "قراءة البريد", risk: R }, { title: "إرسال بريد", risk: S }] },
  { id: "google_drive", name: "Google Drive", category: "files", description: "الوصول إلى المستندات والملفات السحابية.", status: "planned", scopes: [{ title: "قراءة الملفات", risk: R }, { title: "حفظ الملفات", risk: W }] },
  { id: "google_calendar", name: "Google Calendar", category: "scheduling", description: "المواعيد والتنبيهات.", status: "planned", scopes: [{ title: "قراءة المواعيد", risk: R }, { title: "إنشاء مواعيد", risk: W }] },
  { id: "daftra", name: "دفترة", category: "accounting", description: "إدخال الفواتير والتحقق من مراجعها عبر الواجهة.", status: "planned", scopes: [{ title: "قراءة الفواتير", risk: R }, { title: "إنشاء فاتورة", risk: W }] },
  { id: "windows_worker", name: "Windows السحابي", category: "automation", description: "تنفيذ المهام على الكمبيوتر السحابي بالشاشة والماوس.", status: "planned", scopes: [{ title: "التقاط الشاشة", risk: R }, { title: "التحكم بالإدخال", risk: W }] },
];
