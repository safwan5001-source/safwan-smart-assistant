import type { IconName } from "@/components/icon";
import { BRAND } from "./brand";

export type NavItem = { href: string; label: string; icon: IconName; hint: string };
export const NAV: NavItem[] = [
  { href: "/", label: "الرئيسية", icon: "home", hint: "مركز قيادة باشت: ما ينتظرك وما أُنجز وحالة الاتصال" },
  { href: "/chat", label: "المحادثات", icon: "chat", hint: "تحدّث مع باشت، والملاحظات والأوامر السريعة" },
  { href: "/tasks", label: "المهام", icon: "tasks", hint: "أولوياتك ومواعيد الاستحقاق" },
  { href: "/files", label: "الملفات", icon: "files", hint: "مكتبة ملفاتك على هذا الجهاز" },
  { href: "/reminders", label: "التذكيرات", icon: "clock", hint: "تذكيراتك المجدولة والمتكررة" },
  { href: "/notifications", label: "الإشعارات", icon: "bell", hint: "صندوق التنبيهات التي وصلتك" },
  { href: "/calls", label: "الصوت", icon: "wave", hint: "الجلسة الصوتية مع باشت واختبار الإملاء" },
  { href: "/integrations", label: "التكاملات", icon: "integrations", hint: "الخدمات المخطط ربطها وصلاحياتها" },
  { href: "/settings", label: "الإعدادات", icon: "settings", hint: "المظهر والصلاحيات والبيانات" },
];
/** Primary tabs on phones (chat sits in the middle, under the thumb); everything else is under "المزيد". */
export const TABS: NavItem[] = [
  NAV[0], NAV[2], NAV[1], NAV[3],
  { href: "/more", label: "المزيد", icon: "more", hint: "التذكيرات والإشعارات والتكاملات والإعدادات" },
];
export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
export const titleFor = (pathname: string) =>
  [...NAV, TABS[4]].find((n) => isActive(pathname, n.href))?.label ?? BRAND.nameAr;
