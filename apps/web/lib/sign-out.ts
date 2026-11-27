/**
 * Signing out of the app also clears what this device keeps for the owner (security review L8): local tasks, local chats, activity,
 * reminders, notices and their delivery log, notification preferences, the push-device credentials (after deleting the device at the
 * push server) and the files kept in this browser. Only non-private display preferences stay: theme, compact mode, the default task
 * mode, voice sound effects and HQ display prefs.
 */
import { activityStore, firedStore, noticesStore, prefsStore, pushDeviceStore, remindersStore, tasksStore, threadsStore, tombstonesStore } from "./stores";
import { eraseRemoteDevice, resumeSync, suspendSync } from "./push-client";
import { clearFiles } from "./files-db";
import { authClient } from "./owner-auth";

export type WipeResult = { filesCleared: boolean; serverErased: boolean };
/** What could not be removed, in Arabic — empty when the wipe was complete. */
export function wipeLeftovers(r: WipeResult): string[] {
  const left: string[] = [];
  if (!r.filesCleared) left.push("الملفات المحفوظة في هذا المتصفح");
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
  // then the push server (it needs the device credentials, so they go last); an unreachable server is reported, never hidden
  const serverErased = await eraseRemoteDevice().catch(() => false);
  if (serverErased) pushDeviceStore.reset(); // otherwise eraseRemoteDevice() kept the credentials (marked erasePending) so the deletion can be retried
  return { filesCleared, serverErased };
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
  return clearPrivateData();
}
