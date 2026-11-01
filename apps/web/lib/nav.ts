import type { IconName } from "@/components/icon";

export type NavItem = { href: string; label: string; icon: IconName; hint: string };
export const NAV: NavItem[] = [
  { href: "/", label: "الرئيسية", icon: "home", hint: "نظرة عامة على مساحة عملك" },
  { href: "/chat", label: "المحادثات", icon: "chat", hint: "محادثاتك وملاحظاتك والأوامر السريعة" },
  { href: "/tasks", label: "المهام", icon: "tasks", hint: "أولوياتك ومواعيد الاستحقاق" },
  { href: "/files", label: "الملفات", icon: "files", hint: "مكتبة ملفاتك على هذا الجهاز" },
  { href: "/reminders", label: "التذكيرات", icon: "clock", hint: "تذكيراتك المجدولة والمتكررة" },
  { href: "/notifications", label: "الإشعارات", icon: "bell", hint: "صندوق التنبيهات التي وصلتك" },
  { href: "/calls", label: "المكالمات", icon: "calls", hint: "المحادثة الصوتية واختبار الميكروفون" },
  { href: "/integrations", label: "التكاملات", icon: "integrations", hint: "الخدمات المخطط ربطها وصلاحياتها" },
  { href: "/settings", label: "الإعدادات", icon: "settings", hint: "المظهر والصلاحيات والبيانات" },
];
/** Primary tabs on phones; everything else is under "المزيد". */
export const TABS: NavItem[] = [
  NAV[0], NAV[1], NAV[2], NAV[3],
  { href: "/more", label: "المزيد", icon: "more", hint: "التذكيرات والإشعارات والتكاملات والإعدادات" },
];
export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
export const titleFor = (pathname: string) =>
  [...NAV, TABS[4]].find((n) => isActive(pathname, n.href))?.label ?? "مساعد صفوان";
