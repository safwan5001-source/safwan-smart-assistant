import type { IconName } from "@/components/icon";
import { BRAND } from "./brand";
import { HQ_ENABLED } from "./hq/flag";

export type NavItem = { href: string; label: string; icon: IconName; hint: string };
export const HQ_ITEM: NavItem = { href: "/hq", label: "المقر", icon: "hq", hint: "المقر التنفيذي الافتراضي لباشت — محاكاة تجريبية" };
const MORE_ITEM: NavItem = { href: "/more", label: "المزيد", icon: "more", hint: "التذكيرات والإشعارات والتكاملات والإعدادات" };

const BASE_NAV: NavItem[] = [
  { href: "/", label: "الرئيسية", icon: "home", hint: "مركز قيادة باشت: ما ينتظرك وما أُنجز وحالة الاتصال" },
  { href: "/chat", label: "المحادثات", icon: "chat", hint: "محادثتك مع باشت: النص والصوت والأرشيف والأوامر السريعة" },
  { href: "/tasks", label: "المهام", icon: "tasks", hint: "أولوياتك ومواعيد الاستحقاق" },
  { href: "/files", label: "الملفات", icon: "files", hint: "مكتبة ملفاتك على هذا الجهاز" },
  { href: "/reminders", label: "التذكيرات", icon: "clock", hint: "تذكيراتك المجدولة والمتكررة" },
  { href: "/notifications", label: "الإشعارات", icon: "bell", hint: "صندوق التنبيهات التي وصلتك" },
  { href: "/calls", label: "الصوت", icon: "wave", hint: "الجلسة الصوتية داخل محادثة باشت" },
  { href: "/integrations", label: "التكاملات", icon: "integrations", hint: "ما يستطيعه باشت الآن: القنوات والمهارات والأدوات" },
  { href: "/memory", label: "الذاكرة", icon: "archive", hint: "ما يتذكره باشت، بحث وعرض للقراءة فقط" },
  { href: "/settings", label: "الإعدادات", icon: "settings", hint: "المظهر والصلاحيات والبيانات" },
];
/** Sidebar / More list. With the HQ on, it sits right after the chat. */
export const navFor = (hq: boolean): NavItem[] => (hq ? [BASE_NAV[0], BASE_NAV[1], HQ_ITEM, ...BASE_NAV.slice(2)] : BASE_NAV);
/**
 * Primary tabs on phones (BASHT/chat sits in the middle, under the thumb); everything else is under "المزيد".
 * HQ on (owner-approved order): الرئيسية · المهام · باشت · المقر · المزيد — الملفات moves into المزيد (route and data untouched).
 */
export const tabsFor = (hq: boolean): NavItem[] =>
  hq ? [BASE_NAV[0], BASE_NAV[2], BASE_NAV[1], HQ_ITEM, MORE_ITEM] : [BASE_NAV[0], BASE_NAV[2], BASE_NAV[1], BASE_NAV[3], MORE_ITEM];
/** Routes that light up the "المزيد" tab. */
export const morePathsFor = (hq: boolean): string[] =>
  ["/more", "/integrations", "/memory", "/calls", "/settings", "/reminders", "/notifications", ...(hq ? ["/files"] : [])];

export const NAV: NavItem[] = navFor(HQ_ENABLED);
export const TABS: NavItem[] = tabsFor(HQ_ENABLED);
export const MORE_PATHS: string[] = morePathsFor(HQ_ENABLED);
export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
export const titleFor = (pathname: string) =>
  [...NAV, MORE_ITEM].find((n) => isActive(pathname, n.href))?.label ?? BRAND.nameAr;
