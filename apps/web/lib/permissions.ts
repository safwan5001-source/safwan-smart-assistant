/** Client-side policy. Must stay identical to services/api/app/permissions.py —
 *  both are tested against shared/permission-matrix.json. */
export type PermissionMode = "review" | "execute" | "approve";
export type Risk = "read" | "write" | "sensitive";
export type Verdict = "allow" | "require_approval" | "deny";

const POLICY: Record<PermissionMode, Record<Risk, Verdict>> = {
  review: { read: "allow", write: "deny", sensitive: "deny" },
  execute: { read: "allow", write: "allow", sensitive: "require_approval" },
  approve: { read: "allow", write: "require_approval", sensitive: "require_approval" },
};

export const evaluate = (mode: PermissionMode, risk: Risk): Verdict => POLICY[mode][risk];

export const MODES: PermissionMode[] = ["review", "execute", "approve"];
export const RISKS: Risk[] = ["read", "write", "sensitive"];

export const MODE_LABEL: Record<PermissionMode, { title: string; hint: string }> = {
  review: { title: "مراجعة فقط", hint: "قراءة وتحليل دون أي تعديل." },
  execute: { title: "مراجعة وتنفيذ", hint: "تنفيذ داخل النطاق المفوَّض؛ العمليات الحساسة تحتاج موافقة." },
  approve: { title: "تنفيذ بموافقة", hint: "يجهّز المساعد العمل ثم ينتظر اعتمادك قبل الحفظ أو الإرسال." },
};
export const RISK_LABEL: Record<Risk, string> = { read: "قراءة", write: "تنفيذ", sensitive: "حساس" };
export const VERDICT_LABEL: Record<Verdict, string> = { allow: "مسموح", require_approval: "يتطلب موافقة", deny: "مرفوض" };
