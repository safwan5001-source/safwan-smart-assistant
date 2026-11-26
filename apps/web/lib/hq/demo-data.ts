/**
 * BASHT HQ — demonstration content. EVERYTHING in this file is invented for the simulation and is labelled as such in the UI.
 * No real customer, invoice, amount or task appears here, and nothing here is read from or written to the owner's real data
 * (tasks, files, reminders, notifications) or to any server.
 */
import type { AgentId } from "./roster";

/** A value that exists only inside the simulation. The UI must render these with the «محاكاة» marker. */
export type Simulated<T> = { readonly simulated: true; readonly value: T };
export const simulated = <T,>(value: T): Simulated<T> => ({ simulated: true, value });

export type ScenarioId = "fleet" | "marketing" | "finance" | "tech";
export type Scenario = {
  id: ScenarioId;
  label: string;
  goal: string;
  /** Participants; BASHT always leads and always takes the head of the table. */
  team: readonly AgentId[];
  tasks: readonly { agent: AgentId; title: string }[];
  approval: { title: string; impact: string };
  report: { title: string; lines: readonly string[] };
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "fleet", label: "تشغيل أسطول النقل", goal: "خطة تشغيل أسبوعية للأسطول",
    team: ["BASHT", "FURAS", "MASAR", "MIZAN", "MIYAR"],
    tasks: [
      { agent: "FURAS", title: "تجميع طلبات النقل الواردة هذا الأسبوع" },
      { agent: "MASAR", title: "جدولة الرحلات وتوزيعها على المركبات" },
      { agent: "MIZAN", title: "تقدير تكلفة التشغيل للرحلات المقترحة" },
      { agent: "MIYAR", title: "مراجعة الخطة مقابل إجراءات السلامة" },
    ],
    approval: { title: "اعتماد خطة التشغيل الأسبوعية", impact: "لا يُرسَل شيء خارج المحاكاة" },
    report: { title: "ملخص خطة التشغيل (تجريبي)", lines: ["عدد الرحلات المقترحة: رقم توضيحي", "توزيع متوازن على المركبات المتاحة", "لا ملاحظات سلامة مانعة في هذه المحاكاة"] },
  },
  {
    id: "marketing", label: "حملة تسويقية", goal: "خطة حملة لمنتج جديد",
    team: ["BASHT", "RAWAJ", "WISAL", "BASIRA", "MIYAR"],
    tasks: [
      { agent: "RAWAJ", title: "صياغة فكرة الحملة والرسائل الرئيسية" },
      { agent: "WISAL", title: "جمع ملاحظات العملاء المتكررة" },
      { agent: "BASIRA", title: "تحليل الشرائح الأعلى تفاعلًا" },
      { agent: "MIYAR", title: "مراجعة المحتوى مقابل الهوية والسياسات" },
    ],
    approval: { title: "اعتماد مسودة الحملة", impact: "مسودة فقط — لا نشر ولا إنفاق" },
    report: { title: "ملخص الحملة (تجريبي)", lines: ["ثلاث رسائل رئيسية مقترحة", "قناتان ذات أولوية", "ميزانية: غير محددة في المحاكاة"] },
  },
  {
    id: "finance", label: "مراجعة مالية", goal: "مراجعة شهرية للمصروفات",
    team: ["BASHT", "MIZAN", "BASIRA", "MIYAR"],
    tasks: [
      { agent: "MIZAN", title: "مطابقة المصروفات مع الميزانية" },
      { agent: "BASIRA", title: "رصد البنود غير المعتادة" },
      { agent: "MIYAR", title: "التحقق من اكتمال المستندات" },
    ],
    approval: { title: "اعتماد ملخص المراجعة الشهرية", impact: "لا قيود ولا تعديلات على أي نظام محاسبي" },
    report: { title: "ملخص المراجعة (تجريبي)", lines: ["البنود ضمن الحدود في هذه المحاكاة", "بندان للمتابعة (توضيحيان)", "لا أرقام حقيقية في هذا العرض"] },
  },
  {
    id: "tech", label: "تطوير نظام داخلي", goal: "خطة إصدار ميزة جديدة",
    team: ["BASHT", "MIMAR", "HASEEN", "MIYAR"],
    tasks: [
      { agent: "MIMAR", title: "تقدير نطاق الميزة ومراحلها" },
      { agent: "HASEEN", title: "مراجعة المخاطر الأمنية للتصميم" },
      { agent: "MIYAR", title: "وضع معايير القبول والاختبار" },
    ],
    approval: { title: "اعتماد خطة الإصدار", impact: "لا نشر ولا تغيير على أي خادم" },
    report: { title: "ملخص خطة الإصدار (تجريبي)", lines: ["ثلاث مراحل مقترحة", "مراجعة أمنية قبل كل مرحلة", "معايير قبول مكتوبة"] },
  },
];

export const SCENARIO_BY_ID: Readonly<Record<ScenarioId, Scenario>> = Object.fromEntries(SCENARIOS.map((s) => [s.id, s])) as Record<ScenarioId, Scenario>;
