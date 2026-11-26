/**
 * BASHT HQ — the 14 characters of the virtual headquarters.
 * These are VISUAL / FUNCTIONAL definitions only. None of them is a real agent: nothing here talks to OpenClaw, the API or any
 * external system. Names and roles follow the owner-approved brief (HQ-01 decision 7) — do not change them without approval.
 */

export const AGENT_IDS = [
  "BASHT", "MIZAN", "RAWAJ", "MIMAR", "MASAR", "NASAQ", "MIYAR",
  "FURAS", "BASIRA", "RAFID", "SANAD", "WISAL", "HASEEN", "KAFAAT",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** How a character is drawn. BASHT is the official robot mascot; everyone else is a distinct human character. */
export type Look =
  | { kind: "robot" }
  | {
      kind: "human";
      /** Outfit family; the asset generator turns it into geometry. */
      attire: "thobe" | "abaya";
      /** Head covering: shemagh (red check) / ghutra (white) for thobe, hijab colour family for abaya. */
      head: "shemagh" | "ghutra" | "hijab";
      /** Base colours (sRGB hex) used by the generator and by the greybox stand-in. */
      outfit: string;
      accent: string;
      skin: string;
      /** Body proportions so no two characters share a silhouette. */
      height: number; // metres
      build: "slim" | "regular" | "broad";
      extras: ReadonlyArray<"glasses" | "beard" | "moustache" | "bisht" | "watch" | "headset" | "lanyard" | "tablet">;
    };

export type Agent = {
  id: AgentId;
  nameAr: string;
  role: string;
  /** Three short lines shown on the agent card. Descriptive only — no claim of real capability. */
  duties: readonly [string, string, string];
  /** Accent used in the office (prop colour, nameplate). */
  tint: string;
  look: Look;
};

const human = (attire: "thobe" | "abaya", head: "shemagh" | "ghutra" | "hijab", outfit: string, accent: string, skin: string,
  height: number, build: "slim" | "regular" | "broad", extras: Extract<Look, { kind: "human" }>["extras"] = []): Look =>
  ({ kind: "human", attire, head, outfit, accent, skin, height, build, extras });

export const ROSTER: readonly Agent[] = [
  { id: "BASHT", nameAr: "باشت", role: "المدير التنفيذي", tint: "#d4a017", look: { kind: "robot" },
    duties: ["يوزّع المهام على الإدارات ويتابع تقدّمها", "يجمع النتائج ويرفعها للمالك للاعتماد", "يدير الاجتماعات ويحدد الأولويات"] },
  { id: "MIZAN", nameAr: "ميزان", role: "المالية والمحاسبة", tint: "#15803d",
    look: human("thobe", "ghutra", "#f4f1ea", "#1f6f4a", "#c99a6e", 1.76, "regular", ["glasses", "beard"]),
    duties: ["مراجعة الفواتير والقيود", "متابعة التدفقات النقدية", "إعداد الملخصات المالية"] },
  { id: "RAWAJ", nameAr: "رواج", role: "التسويق والإعلانات", tint: "#db2777",
    look: human("abaya", "hijab", "#2b1f3a", "#c026d3", "#d7a982", 1.64, "slim", ["tablet"]),
    duties: ["تخطيط الحملات والمحتوى", "متابعة أداء الإعلانات", "تحليل الجمهور والسوق"] },
  { id: "MIMAR", nameAr: "معمار", role: "التقنية والتطوير", tint: "#2563eb",
    look: human("thobe", "shemagh", "#e9edf2", "#1d4ed8", "#b98660", 1.81, "slim", ["headset", "moustache"]),
    duties: ["تطوير الأنظمة والتكاملات", "مراجعة البنية التقنية", "متابعة جودة الكود"] },
  { id: "MASAR", nameAr: "مسار", role: "العمليات والنقليات", tint: "#ea580c",
    look: human("thobe", "shemagh", "#ede6d8", "#c2410c", "#a8764f", 1.79, "broad", ["beard", "watch"]),
    duties: ["جدولة الأسطول والرحلات", "متابعة التشغيل الميداني", "تحسين مسارات النقل"] },
  { id: "NASAQ", nameAr: "نسق", role: "الإدارة والتنظيم", tint: "#7c3aed",
    look: human("abaya", "hijab", "#1c1a2b", "#6d28d9", "#e0b48f", 1.62, "regular", ["glasses"]),
    duties: ["تنظيم الإجراءات والسياسات", "متابعة المواعيد والمراسلات", "ترتيب الملفات الإدارية"] },
  { id: "MIYAR", nameAr: "معيار", role: "الرقابة والجودة", tint: "#0891b2",
    look: human("thobe", "ghutra", "#f7f7f4", "#0e7490", "#c48d63", 1.73, "regular", ["glasses", "moustache"]),
    duties: ["مراجعة جودة المخرجات", "التحقق من الالتزام بالإجراءات", "رصد المخاطر التشغيلية"] },
  { id: "FURAS", nameAr: "فرص", role: "تطوير الأعمال والمبيعات", tint: "#ca8a04",
    look: human("thobe", "ghutra", "#efe9dc", "#a16207", "#b07a52", 1.84, "broad", ["bisht", "beard"]),
    duties: ["البحث عن فرص وعملاء جدد", "إعداد العروض والتسعير", "متابعة الصفقات"] },
  { id: "BASIRA", nameAr: "بصيرة", role: "ذكاء الأعمال وتحليل البيانات", tint: "#0d9488",
    look: human("thobe", "shemagh", "#e6ebee", "#0f766e", "#cf9d73", 1.70, "slim", ["glasses", "beard"]),
    duties: ["بناء لوحات المؤشرات", "تحليل الاتجاهات والأداء", "إعداد التقارير التحليلية"] },
  { id: "RAFID", nameAr: "رافد", role: "المشتريات والإمداد", tint: "#65a30d",
    look: human("abaya", "hijab", "#3a2a1f", "#4d7c0f", "#c08a62", 1.67, "regular", ["lanyard"]),
    duties: ["طلبات الشراء والموردين", "متابعة المخزون والتوريد", "مقارنة العروض والأسعار"] },
  { id: "SANAD", nameAr: "سند", role: "الشؤون القانونية", tint: "#475569",
    look: human("thobe", "ghutra", "#f2efe8", "#334155", "#ba8a64", 1.78, "regular", ["bisht", "glasses", "beard"]),
    duties: ["مراجعة العقود والاتفاقيات", "متابعة الامتثال النظامي", "تقديم الرأي القانوني"] },
  { id: "WISAL", nameAr: "وصال", role: "علاقات العملاء", tint: "#e11d48",
    look: human("abaya", "hijab", "#2a1d2e", "#be123c", "#d9aa86", 1.66, "slim", ["headset"]),
    duties: ["متابعة طلبات العملاء", "قياس رضا العملاء", "تنسيق الردود والشكاوى"] },
  { id: "HASEEN", nameAr: "حصين", role: "الأمن السيبراني", tint: "#dc2626",
    look: human("thobe", "shemagh", "#dfe3e8", "#991b1b", "#a77450", 1.82, "broad", ["moustache", "watch"]),
    duties: ["مراقبة الحماية والصلاحيات", "مراجعة الثغرات والتحديثات", "إدارة الاستجابة للحوادث"] },
  { id: "KAFAAT", nameAr: "كفاءات", role: "الموارد البشرية", tint: "#9333ea",
    look: human("abaya", "hijab", "#241b33", "#a855f7", "#c99872", 1.60, "regular", ["glasses", "lanyard"]),
    duties: ["التوظيف والتهيئة", "تقييم الأداء والتطوير", "سياسات الموظفين"] },
];

export const AGENTS: Readonly<Record<AgentId, Agent>> = Object.fromEntries(ROSTER.map((a) => [a.id, a])) as Record<AgentId, Agent>;
export const isAgentId = (v: string): v is AgentId => (AGENT_IDS as readonly string[]).includes(v);
