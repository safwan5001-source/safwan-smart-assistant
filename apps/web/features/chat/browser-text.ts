import type { Fail } from "@/lib/browser-client";

/** One Arabic sentence per failure code, shared by the read-only card and the interactive session card. Never upstream text. */
export const FAIL_TEXT: Record<Fail, string> = {
  disabled: "التصفح السحابي غير مفعّل على الخادم.", unauthorized: "الرمز غير صحيح أو انتهت صلاحية الدخول.", rate_limited: "محاولات كثيرة؛ انتظر قليلاً ثم أعد المحاولة.",
  busy: "هناك مهمة تصفح أخرى قيد التنفيذ. انتظر انتهاءها أو أوقفها.", not_found: "انتهت صلاحية هذه المهمة على الخادم.", url_not_allowed: "العنوان غير مسموح في هذه التجربة.",
  unavailable: "الخدمة غير متاحة الآن.", network: "تعذر الاتصال بالخادم.",
  interactive_disabled: "التحكم التفاعلي غير مفعّل على الخادم؛ يفعّله المالك بتحديد صفحة المختبر.", bad_request: "تعذر فهم الأمر؛ راجع الصيغة.",
  action_in_progress: "هناك خطوة قيد التنفيذ؛ انتظر انتهاءها.", limit_reached: "بلغت الجلسة الحد الأقصى لعدد الخطوات.", not_ready: "الجلسة لم تجهز بعد؛ انتظر لحظة.",
  session_ended: "انتهت الجلسة.", not_interactive: "هذه المهمة ليست جلسة تفاعلية.", no_pending_approval: "لا توجد خطوة تنتظر الموافقة الآن.", conflict: "تعذر تنفيذ الطلب في حالة الجلسة الحالية.",
};
