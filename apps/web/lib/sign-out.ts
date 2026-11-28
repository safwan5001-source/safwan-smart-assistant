/**
 * Signing out of the app also clears what this device keeps for the owner (security review L8): local tasks, local chats, activity,
 * reminders, notices and their delivery log, notification preferences, the push-device credentials (after deleting the device at the
 * push server) the files kept in this browser and the device copies of photos sent to BASHT. Only non-private display preferences stay: theme, compact mode, the default task
 * mode, voice sound effects and HQ display prefs.
 */
import { activityStore, firedStore, noticesStore, prefsStore, pushDeviceStore, remindersStore, tasksStore, threadsStore, tombstonesStore } from "./stores";
import { eraseRemoteDevice, resumeSync, suspendSync } from "./push-client";
import { clearFiles } from "./files-db";
import { localAttachments } from "./local-attachments";
import { setOwnerScope } from "./owner-scope";
import { authClient } from "./owner-auth";

/** `attachmentsCleared`: the device-local copies of the photos sent to BASHT (lib/attachment-store). */
/** IndexedDB can hang (a blocked connection, storage pressure): signing out must not wait for it forever. A wipe that did not finish
 *  in time is reported as NOT cleared (never as done). */
export const ATTACHMENT_WIPE_MS = 3000;
const withTimeout = (p: Promise<boolean>, ms: number): Promise<boolean> => new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(false); });
});
export type WipeResult = { filesCleared: boolean; serverErased: boolean; attachmentsCleared?: boolean };
/** «مسح كل البيانات المحلية» (settings): what to tell the owner. Never "done" while anything stayed: the same leftover list as sign-out. */
export function eraseSummary(r: WipeResult): { ok: boolean; text: string } {
  const left = wipeLeftovers(r);
  if (!left.length) return { ok: true, text: "تم مسح البيانات المحلية وبيانات الإشعارات على الخادم" };
  const serverOnly = r.filesCleared && r.attachmentsCleared !== false && !r.serverErased;
  if (serverOnly) return { ok: false, text: "تم مسح البيانات المحلية، لكن تعذر الوصول إلى خادم الإشعارات لحذف نسخته. أعد المحاولة لاحقاً." };
  return { ok: false, text: `مُسحت المهام والمحادثات، لكن تعذّر حذف: ${left.join("، ")}. يمكنك مسح بيانات الموقع من إعدادات المتصفح.` };
}
/** What could not be removed, in Arabic — empty when the wipe was complete. */
export function wipeLeftovers(r: WipeResult): string[] {
  const left: string[] = [];
  if (!r.filesCleared) left.push("الملفات المحفوظة في هذا المتصفح");
  if (r.attachmentsCleared === false) left.push("نسخ الصور المرسلة إلى باشت على هذا الجهاز");
  if (!r.serverErased) left.push("تسجيل هذا الجهاز لدى خادم الإشعارات (يُعاد حذفه تلقائيًا عند الاتصال)");
  return left;
}

/** Wipe the private local data. Reports (never hides) what could not be cleared. */
export async function clearPrivateData(): Promise<WipeResult> {
  suspendSync(); // a reminder sync in flight must not repopulate the stores cleared below
  try { return await wipe(); } finally { resumeSync(); }
}
async function wipe(): Promise<WipeResult> {
  // local stores first and synchronously: nothing (a slow network, a closed tab) can leave them behind
  tasksStore.reset(); threadsStore.reset(); activityStore.reset();
  remindersStore.reset(); noticesStore.reset(); firedStore.reset(); prefsStore.reset(); tombstonesStore.reset();
  const filesCleared = await clearFiles().then(() => true, () => false);
  // the photos sent to BASHT are kept on this device too, per owner (a cache only the owner clears: this is that explicit moment): every scope goes
  const attachmentsCleared = await withTimeout(localAttachments().clearAll(), ATTACHMENT_WIPE_MS);
  // then the push server (it needs the device credentials, so they go last); an unreachable server is reported, never hidden
  const serverErased = await eraseRemoteDevice().catch(() => false);
  if (serverErased) pushDeviceStore.reset(); // otherwise eraseRemoteDevice() kept the credentials (marked erasePending) so the deletion can be retried
  return { filesCleared, serverErased, attachmentsCleared };
}

/**
 * The owner's session ended on this device (sign-out, or ending this device's own session): wipe the private data AND forget which
 * owner this was, so nothing scoped is read or written until the next sign-in. Settings' «erase all local data» deliberately does NOT
 * use this: it wipes every scope's data but the owner stays signed in, so their scope stays known and new photos persist at once.
 */
export async function endOwnerOnDevice(): Promise<WipeResult> {
  const r = await clearPrivateData();
  setOwnerScope(null);
  return r;
}

/** Set while this page is signing out on purpose: the login gate must not redirect mid-wipe (or over the "what stayed" notice).
 * The page leaves for the login page itself when it is done. */
let leaving = false;
export const isLeaving = () => leaving;
export const markLeaving = () => { leaving = true; };

/** Sign out (this device, or every device) and then clear this device's private data. A failed sign-out throws and clears nothing.
 * Returns what the wipe managed, so the caller can tell the owner when something stayed on the device. */
export async function signOut(everywhere = false): Promise<WipeResult> {
  leaving = true; // before the cookie goes: a gate check landing during the wipe must not unload the page
  try { await authClient.logout(everywhere); } catch (e) { leaving = false; throw e; }
  return endOwnerOnDevice();
}
