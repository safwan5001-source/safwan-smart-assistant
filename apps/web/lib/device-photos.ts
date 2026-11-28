/**
 * «صور هذا الجهاز» (settings): the saved copies of the photos the owner sent. Pure logic over the manager, so the flow is testable:
 * read the current owner's usage, and clear it after a confirmation with an HONEST result — "cleared" is said only when the wipe
 * really succeeded and nothing is left in this owner's scope. Only the current owner's scope is touched (sign-out wipes them all).
 */
import type { AttachmentUsage } from "./attachment-store";

export type DevicePhotosView = { status: "noowner" | "ready" | "unreadable"; count: number; bytes: number };
export const DEVICE_PHOTOS_TEXT = {
  title: "صور هذا الجهاز",
  explain: "هذه نسخ من الصور التي أرسلتها إلى باشت، تُحفظ على هذا الجهاز فقط وتُستخدم لتبقى صورك ظاهرة في المحادثة. مسحها لا يحذف شيئًا من باشت أو من الخادم؛ وإن كانت الصورة متاحة هناك فستظهر من الخادم.",
  none: "لا توجد نسخ محفوظة على هذا الجهاز.",
  noOwner: "يتعذّر عرض النسخ المحفوظة الآن؛ يظهر الحجم بعد التحقق من الدخول.",
  unreadable: "تعذّرت قراءة حجم النسخ المحفوظة على هذا الجهاز الآن.",
  button: "مسح نسخ الصور على هذا الجهاز",
  confirmTitle: "مسح نسخ الصور على هذا الجهاز؟",
  confirmMessage: "تُحذف النسخ المحفوظة هنا لصورك المرسلة. لا يُحذف شيء من باشت. قد تظهر رسالة الصورة بلا صورة هنا إن لم تكن متاحة على الخادم.",
  confirmLabel: "مسح النسخ",
  done: "مُسحت نسخ الصور من هذا الجهاز.",
  failed: "تعذّر مسح نسخ الصور بالكامل؛ بقي بعضها على هذا الجهاز. أعد المحاولة، أو امسح بيانات الموقع من إعدادات المتصفح.",
} as const;

export type PhotosManager = { usage(): Promise<AttachmentUsage | null>; clear(): Promise<boolean> };

/** The current owner's saved copies: count (messages with photos) and bytes. `noowner` = the owner is not known (nothing is read). */
export async function readDevicePhotos(mgr: PhotosManager, ownerKnown: boolean): Promise<DevicePhotosView> {
  if (!ownerKnown) return { status: "noowner", count: 0, bytes: 0 };
  const u = await mgr.usage().catch(() => null);
  return u ? { status: "ready", count: u.count, bytes: u.bytes } : { status: "unreadable", count: 0, bytes: 0 };
}

export type ClearOutcome = { cleared: boolean; cancelled: boolean; message: string; view: DevicePhotosView };
/** Confirm → clear this owner's scope → re-read. `cleared` only if the wipe reported success AND nothing is left when re-read. */
export async function clearDevicePhotos(a: { mgr: PhotosManager; ownerKnown: boolean; confirm: () => Promise<boolean> }): Promise<ClearOutcome> {
  const before = await readDevicePhotos(a.mgr, a.ownerKnown);
  if (!(await a.confirm())) return { cleared: false, cancelled: true, message: "", view: before };
  let ok = false;
  try { ok = await a.mgr.clear(); } catch { ok = false; }
  const view = await readDevicePhotos(a.mgr, a.ownerKnown);
  const leftover = view.status === "ready" && view.count > 0;
  const cleared = ok && !leftover;
  return { cleared, cancelled: false, message: cleared ? DEVICE_PHOTOS_TEXT.done : DEVICE_PHOTOS_TEXT.failed, view };
}
