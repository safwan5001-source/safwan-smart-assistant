/**
 * Signing out of the app also clears what this device keeps for the owner (security review L8): local tasks, local chats, activity,
 * reminders, notices and their delivery log, notification preferences, the push-device credentials (after deleting the device at the
 * push server) and the files kept in this browser. Only non-private display preferences stay: theme, compact mode, the default task
 * mode, voice sound effects and HQ display prefs.
 */
import { activityStore, firedStore, noticesStore, prefsStore, pushDeviceStore, remindersStore, tasksStore, threadsStore, tombstonesStore } from "./stores";
import { eraseRemoteDevice } from "./push-client";
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
  // push server first (needs the device credentials we are about to wipe); an unreachable server is reported, never hidden
  const serverErased = await eraseRemoteDevice().catch(() => false);
  tasksStore.reset(); threadsStore.reset(); activityStore.reset();
  remindersStore.reset(); noticesStore.reset(); firedStore.reset(); prefsStore.reset(); tombstonesStore.reset();
  if (serverErased) pushDeviceStore.reset(); // otherwise eraseRemoteDevice() kept the credentials (marked erasePending) so the deletion can be retried
  const filesCleared = await clearFiles().then(() => true, () => false);
  return { filesCleared, serverErased };
}

/** Sign out (this device, or every device) and then clear this device's private data. A failed sign-out throws and clears nothing.
 * Returns what the wipe managed, so the caller can tell the owner when something stayed on the device. */
export async function signOut(everywhere = false): Promise<WipeResult> {
  await authClient.logout(everywhere);
  return clearPrivateData();
}
