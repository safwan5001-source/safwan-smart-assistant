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

/** Wipe the private local data. Reports (never hides) what could not be cleared. */
export async function clearPrivateData(): Promise<{ filesCleared: boolean; serverErased: boolean }> {
  // push server first (needs the device credentials we are about to wipe); an unreachable server is reported, never hidden
  const serverErased = await eraseRemoteDevice().catch(() => false);
  tasksStore.reset(); threadsStore.reset(); activityStore.reset();
  remindersStore.reset(); noticesStore.reset(); firedStore.reset(); prefsStore.reset(); tombstonesStore.reset();
  if (serverErased) pushDeviceStore.reset(); // otherwise eraseRemoteDevice() kept the credentials (marked erasePending) so the deletion can be retried
  const filesCleared = await clearFiles().then(() => true, () => false);
  return { filesCleared, serverErased };
}

/** Sign out (this device, or every device) and then clear this device's private data. A failed sign-out throws and clears nothing. */
export async function signOut(everywhere = false): Promise<true> {
  await authClient.logout(everywhere);
  await clearPrivateData();
  return true;
}
