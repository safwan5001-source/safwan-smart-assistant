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
      /** Outfit family (the realistic avatar wears it; the greybox stand-in approximates it). */
      attire: "thobe" | "abaya" | "suit";
      /** Head covering: shemagh (red check) / ghutra (white) with the thobe, hijab (colour = accent), or none. */
      head: "shemagh" | "ghutra" | "hijab" | "none";
      /** Base colours (sRGB hex) used by the generator and by the greybox stand-in. */
      outfit: string;
      accent: string;
      skin: string;
      /** Body proportions so no two characters share a silhouette. */
      height: number; // metres
      build: "slim" | "regular" | "broad";
      /** Accessories of the greybox stand-in only (shown when the 3D files cannot load); the realistic avatar's own
       *  look (beard, glasses …) comes from its model / face. */
      extras: ReadonlyArray<"glasses" | "beard" | "moustache" | "bisht" | "watch" | "headset" | "lanyard" | "tablet">;
      /** Realistic avatar (Microsoft Rocketbox, MIT) the person is built from: Assets/Avatars/<model> — their outfit. */
      model: string;
      /** Optional face: another avatar of the same skeleton whose head replaces the outfit avatar's (tools/hq-assets
       *  build_humans.py composes them; headwear then covers the hair). Every person's face is unique. */
      face?: string;
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

type HumanLook = Extract<Look, { kind: "human" }>;
const human = (attire: HumanLook["attire"], head: HumanLook["head"], outfit: string, accent: string, skin: string,
  height: number, build: HumanLook["build"], extras: HumanLook["extras"], model: string, face?: string): Look =>
  ({ kind: "human", attire, head, outfit, accent, skin, height, build, extras, model, ...(face ? { face } : {}) });

export const ROSTER: readonly Agent[] = [
  { id: "BASHT", nameAr: "باشت", role: "المدير التنفيذي", tint: "#d4a017", look: { kind: "robot" },
    duties: ["يوزّع المهام على الإدارات ويتابع تقدّمها", "يجمع النتائج ويرفعها للمالك للاعتماد", "يدير الاجتماعات ويحدد الأولويات"] },
  { id: "MIZAN", nameAr: "ميزان", role: "المالية والمحاسبة", tint: "#15803d",
    look: human("thobe", "ghutra", "#f4f1ea", "#1f6f4a", "#c99a6e", 1.76, "regular", ["glasses", "beard"], "Adults/Male_Adult_21", "Adults/Male_Adult_15"),
    duties: ["مراجعة الفواتير والقيود", "متابعة التدفقات النقدية", "إعداد الملخصات المالية"] },
  { id: "RAWAJ", nameAr: "رواج", role: "التسويق والإعلانات", tint: "#db2777",
    look: human("suit", "hijab", "#1d1d22", "#7a4a5a", "#7a5238", 1.64, "slim", ["tablet"], "Professions/Business_Female_01"),
    duties: ["تخطيط الحملات والمحتوى", "متابعة أداء الإعلانات", "تحليل الجمهور والسوق"] },
  { id: "MIMAR", nameAr: "معمار", role: "التقنية والتطوير", tint: "#2563eb",
    look: human("suit", "none", "#f2f2f0", "#1d4ed8", "#c9a07e", 1.81, "slim", ["headset", "moustache"], "Professions/Business_Male_06"),
    duties: ["تطوير الأنظمة والتكاملات", "مراجعة البنية التقنية", "متابعة جودة الكود"] },
  { id: "MASAR", nameAr: "مسار", role: "العمليات والنقليات", tint: "#ea580c",
    look: human("thobe", "shemagh", "#eeebe4", "#c2410c", "#a8764f", 1.79, "broad", ["beard", "watch"], "Adults/Male_Adult_19", "Adults/Male_Adult_17"),
    duties: ["جدولة الأسطول والرحلات", "متابعة التشغيل الميداني", "تحسين مسارات النقل"] },
  { id: "NASAQ", nameAr: "نسق", role: "الإدارة والتنظيم", tint: "#7c3aed",
    look: human("suit", "hijab", "#cdbb9c", "#1e2a4a", "#e0b48f", 1.62, "regular", ["glasses"], "Adults/Female_Adult_09"),
    duties: ["تنظيم الإجراءات والسياسات", "متابعة المواعيد والمراسلات", "ترتيب الملفات الإدارية"] },
  { id: "MIYAR", nameAr: "معيار", role: "الرقابة والجودة", tint: "#0891b2",
    look: human("thobe", "ghutra", "#f6f4ee", "#0e7490", "#d2a585", 1.72, "slim", ["moustache"], "Adults/Male_Adult_21", "Adults/Male_Adult_07"),
    duties: ["مراجعة جودة المخرجات", "التحقق من الالتزام بالإجراءات", "رصد المخاطر التشغيلية"] },
  { id: "FURAS", nameAr: "فرص", role: "تطوير الأعمال والمبيعات", tint: "#ca8a04",
    look: human("thobe", "shemagh", "#efe9dc", "#a16207", "#b07a52", 1.84, "broad", ["bisht", "beard"], "Adults/Male_Adult_21"),
    duties: ["البحث عن فرص وعملاء جدد", "إعداد العروض والتسعير", "متابعة الصفقات"] },
  { id: "BASIRA", nameAr: "بصيرة", role: "ذكاء الأعمال وتحليل البيانات", tint: "#0d9488",
    look: human("suit", "none", "#26262c", "#7e22ce", "#6b4630", 1.70, "slim", ["beard"], "Professions/Business_Male_05"),
    duties: ["بناء لوحات المؤشرات", "تحليل الاتجاهات والأداء", "إعداد التقارير التحليلية"] },
  { id: "RAFID", nameAr: "رافد", role: "المشتريات والإمداد", tint: "#65a30d",
    look: human("suit", "hijab", "#2a2a2e", "#d8c8b0", "#e2b896", 1.67, "regular", ["lanyard"], "Professions/Business_Female_04"),
    duties: ["طلبات الشراء والموردين", "متابعة المخزون والتوريد", "مقارنة العروض والأسعار"] },
  { id: "SANAD", nameAr: "سند", role: "الشؤون القانونية", tint: "#475569",
    look: human("thobe", "ghutra", "#ddd6c6", "#334155", "#ba8a64", 1.78, "regular", ["bisht", "glasses", "beard"], "Adults/Male_Adult_19"),
    duties: ["مراجعة العقود والاتفاقيات", "متابعة الامتثال النظامي", "تقديم الرأي القانوني"] },
  { id: "WISAL", nameAr: "وصال", role: "علاقات العملاء", tint: "#e11d48",
    look: human("abaya", "hijab", "#16131c", "#1a171f", "#d9aa86", 1.66, "slim", ["headset"], "Adults/Female_Adult_10"),
    duties: ["متابعة طلبات العملاء", "قياس رضا العملاء", "تنسيق الردود والشكاوى"] },
  { id: "HASEEN", nameAr: "حصين", role: "الأمن السيبراني", tint: "#dc2626",
    look: human("suit", "none", "#1f1f24", "#991b1b", "#e6c2a4", 1.82, "broad", ["watch"], "Professions/Business_Male_03"),
    duties: ["مراقبة الحماية والصلاحيات", "مراجعة الثغرات والتحديثات", "إدارة الاستجابة للحوادث"] },
  { id: "KAFAAT", nameAr: "كفاءات", role: "الموارد البشرية", tint: "#9333ea",
    look: human("abaya", "hijab", "#8a7a45", "#f2f0ea", "#c99872", 1.60, "regular", ["lanyard"], "Adults/Female_Adult_06"),
    duties: ["التوظيف والتهيئة", "تقييم الأداء والتطوير", "سياسات الموظفين"] },
];

export const AGENTS: Readonly<Record<AgentId, Agent>> = Object.fromEntries(ROSTER.map((a) => [a.id, a])) as Record<AgentId, Agent>;
export const isAgentId = (v: string): v is AgentId => (AGENT_IDS as readonly string[]).includes(v);
