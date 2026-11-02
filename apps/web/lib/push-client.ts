/**
 * Browser side of Web Push. Honest about iOS:
 *  - iPhone/iPad (iOS/iPadOS 16.4+) deliver Web Push ONLY to a web app added to the Home Screen ("تثبيت التطبيق")
 *    and only after the user grants permission from a tap inside that installed app.
 *  - there is no way to ask permission from a normal Safari tab; we report "needs_install" instead of failing silently.
 *  - the OS decides the alert sound for web push; custom tones play only while the app is open.
 */
import { pushDeviceStore, prefsStore, remindersStore, tombstonesStore, type PushDevice } from "./stores";
import { toServerPrefs } from "./notify-prefs";
import { parseReminders, type Reminder } from "./reminders";

export type PushState = "unsupported" | "needs_install" | "unconfigured" | "off" | "denied" | "on" | "error";
export type Caps = {
  secure: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean;
  permission: NotificationPermission | "unsupported"; ios: boolean; iosVersionOk: boolean; standalone: boolean; needsInstall: boolean;
};

type NavLike = Partial<Navigator> & { standalone?: boolean; maxTouchPoints?: number };
export function detectCaps(w: Window & typeof globalThis = window): Caps {
  const nav = w.navigator as NavLike;
  const ua = nav.userAgent ?? "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  const m = /OS (\d+)[_.](\d+)/.exec(ua);
  const iosVersionOk = !ios || !m || +m[1] > 16 || (+m[1] === 16 && +m[2] >= 4);
  const standalone = nav.standalone === true || (typeof w.matchMedia === "function" && w.matchMedia("(display-mode: standalone)").matches);
  const serviceWorker = "serviceWorker" in nav, pushManager = "PushManager" in w, notification = "Notification" in w;
  return {
    secure: w.isSecureContext !== false, serviceWorker, pushManager, notification,
    permission: notification ? w.Notification.permission : "unsupported", ios, iosVersionOk, standalone,
    needsInstall: ios && iosVersionOk && !standalone,
  };
}
export function pushUnavailableReason(c: Caps): PushState | null {
  if (!c.secure || !c.serviceWorker) return "unsupported";
  if (c.ios && !c.iosVersionOk) return "unsupported";
  if (c.needsInstall) return "needs_install";            // iOS exposes PushManager only inside the installed web app
  if (!c.pushManager || !c.notification) return "unsupported";
  return null;
}

export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Last-writer-wins by revision. Equal revision keeps the local copy. Tombstoned ids are never resurrected. */
export function mergeReminders(local: Reminder[], remote: Reminder[], tombstones: string[] = []): Reminder[] {
  const dead = new Set(tombstones);
  const byId = new Map(local.map((r) => [r.id, r]));
  for (const r of remote) {
    if (dead.has(r.id)) continue;
    const cur = byId.get(r.id);
    if (!cur || r.rev > cur.rev) byId.set(r.id, r);
  }
  return [...byId.values()];
}

// ── HTTP ───────────────────────────────────────────────────────────────────
type Api = { ok: boolean; status: number; json: Record<string, unknown> | null };
async function api(method: string, path: string, body?: unknown, device?: PushDevice, timeoutMs = 10_000): Promise<Api> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/notify${path}`, {
      method, signal: ctl.signal, cache: "no-store",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(device ? { Authorization: `Bearer ${device.deviceId}.${device.token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: Api["json"] = null; try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json };
  } catch { return { ok: false, status: 0, json: null }; } finally { clearTimeout(t); }
}

export type ServerConfig = { push: boolean; publicKey: string | null; store: string };
export async function fetchConfig(): Promise<ServerConfig | null> {
  const r = await api("GET", "/config");
  return r.ok && r.json ? (r.json as unknown as ServerConfig) : null;
}

async function ensureDevice(): Promise<PushDevice> {
  const cur = pushDeviceStore.getSnapshot();
  if (cur) return cur;
  const r = await api("POST", "/devices");
  if (!r.ok || !r.json || typeof r.json.deviceId !== "string" || typeof r.json.token !== "string") return null;
  const d: PushDevice = { deviceId: r.json.deviceId, token: r.json.token, subscribed: false, registeredAt: Date.now() };
  pushDeviceStore.set(d);
  return d;
}
const setSubscribed = (v: boolean) => pushDeviceStore.set((d) => (d ? { ...d, subscribed: v } : d));

async function swReady(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return reg;
}

export async function getPushState(): Promise<PushState> {
  const caps = detectCaps();
  const blocked = pushUnavailableReason(caps);
  if (blocked) return blocked;
  const cfg = await fetchConfig();
  if (!cfg || !cfg.push) return "unconfigured";
  if (caps.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    return sub && pushDeviceStore.getSnapshot()?.subscribed ? "on" : "off";
  } catch { return "error"; }
}

/** Must be called from a user gesture (tap). */
export async function enablePush(): Promise<PushState> {
  if (pushDeviceStore.getSnapshot()?.erasePending && !(await eraseRemoteDevice())) return "error"; // finish the pending wipe first
  const caps = detectCaps();
  const blocked = pushUnavailableReason(caps);
  if (blocked) return blocked;
  // permission first: iOS only shows the prompt while the tap's user-activation is still valid
  if (caps.permission === "denied") return "denied"; // blocked in Settings: the browser will not prompt again
  const perm = caps.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "off";
  const cfg = await fetchConfig();
  if (!cfg || !cfg.push || !cfg.publicKey) return "unconfigured";
  try {
    const reg = await swReady();
    const key = urlBase64ToUint8Array(cfg.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (cur && (cur.length !== key.length || cur.some((b, i) => b !== key[i]))) { await sub.unsubscribe(); sub = null; } // VAPID key rotated
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    let device = await ensureDevice();
    if (!device) return "error";
    let r = await api("PUT", "/devices/me/subscription", { subscription: sub.toJSON(), prefs: toServerPrefs(prefsStore.getSnapshot()) }, device);
    if (r.status === 401) { pushDeviceStore.reset(); device = await ensureDevice(); r = await api("PUT", "/devices/me/subscription", { subscription: sub.toJSON(), prefs: toServerPrefs(prefsStore.getSnapshot()) }, device); }
    if (!r.ok) return "error";
    setSubscribed(true);
    void syncReminders();
    return "on";
  } catch { return "error"; }
}

export async function disablePush(): Promise<PushState> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch { /* nothing to unsubscribe */ }
  const device = pushDeviceStore.getSnapshot();
  if (device) await api("DELETE", "/devices/me/subscription", undefined, device);
  setSubscribed(false);
  return "off";
}

/** Full erase: server rows (device, reminders, deliveries), browser subscription and local credentials. Returns true when nothing remains. */
export async function eraseRemoteDevice(): Promise<boolean> {
  epoch++; clearRetry();
  const device = pushDeviceStore.getSnapshot();
  let ok = true;
  if (device) {
    const r = await api("DELETE", "/devices/me", undefined, device);
    ok = r.ok || r.status === 401 || r.status === 404; // already gone counts
  }
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration("/");
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    }
  } catch { /* ignore */ }
  if (ok) pushDeviceStore.reset();
  // server unreachable: keep the credentials ONLY so the deletion can be retried (runtime retries on focus/online); stop all syncing meanwhile
  else pushDeviceStore.set((d) => (d ? { ...d, subscribed: false, erasePending: true } : d));
  return ok;
}

export type TestResult = "sent" | "not_enabled" | "expired" | "failed" | "rate_limited";
export async function sendTestPush(): Promise<TestResult> {
  const device = pushDeviceStore.getSnapshot();
  if (!device?.subscribed) return "not_enabled";
  const r = await api("POST", "/devices/me/test", undefined, device, 15_000);
  if (r.ok) return "sent";
  if (r.status === 429) return "rate_limited";
  if (r.status === 409) return "not_enabled";
  if (r.json?.subscriptionExpired) { setSubscribed(false); return "expired"; }
  return "failed";
}

let epoch = 0; // bumped by every wipe: responses of syncs started before it are discarded
/** A sync that failed for a TRANSIENT reason (network, 429, 5xx) is retried with a bounded exponential backoff until it succeeds, so a
 *  saved edit/deletion can never stay unapplied on the push server (where the old notification would still fire). */
export const syncRetry = { baseMs: 5_000, maxMs: 300_000 };
let retryMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
function clearRetry() { clearTimeout(retryTimer); retryTimer = undefined; retryMs = 0; }
function armRetry() {
  retryMs = Math.min(retryMs ? retryMs * 3 : syncRetry.baseMs, syncRetry.maxMs);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void syncReminders(), retryMs);
  (retryTimer as { unref?: () => void }).unref?.();
}
let inflight: Promise<boolean> | null = null;
/** Serialised: a call made while another sync is running waits for it, then runs with the freshest data. */
export async function syncReminders(): Promise<boolean> {
  while (inflight) await inflight;
  inflight = doSync().finally(() => { inflight = null; });
  return inflight;
}
async function doSync(): Promise<boolean> {
  const device = pushDeviceStore.getSnapshot();
  if (!device?.subscribed || device.erasePending) { clearRetry(); return false; } // never re-import server rows of a device whose erasure is pending
  const sentTombs = tombstonesStore.getSnapshot();
  const ep = epoch, did = device.deviceId;
  const r = await api("PUT", "/reminders/sync", { reminders: remindersStore.getSnapshot(), deleted: sentTombs, prefs: toServerPrefs(prefsStore.getSnapshot()) }, device);
  if (ep !== epoch || pushDeviceStore.getSnapshot()?.deviceId !== did) return false; // a wipe/re-registration happened meanwhile: never import this stale answer
  if (r.status === 401) { clearRetry(); pushDeviceStore.reset(); return false; }   // server forgot us (erased / expired)
  if (r.status === 409) { clearRetry(); setSubscribed(false); return false; }      // subscription removed server-side
  if (r.status === 0 || r.status === 429 || r.status >= 500) { armRetry(); return false; } // transient: try again later
  if (!r.ok || !r.json) { clearRetry(); return false; }                            // permanent (400/413…): retrying cannot help
  clearRetry();
  const remote = parseReminders(r.json.reminders);
  // Only write when the merge really changed something: store writes notify subscribers, and the runtime re-syncs on every write,
  // so an unconditional set() would make an idle device ping the server forever.
  const local = remindersStore.getSnapshot();
  const merged = mergeReminders(local, remote, tombstonesStore.getSnapshot());
  if (merged.length !== local.length || merged.some((x, i) => x !== local[i])) remindersStore.set(merged);
  if (sentTombs.length) tombstonesStore.set((t) => t.filter((id) => !sentTombs.includes(id)));
  return true;
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
export const scheduleSync = (ms = 800) => { clearTimeout(syncTimer); syncTimer = setTimeout(() => void syncReminders(), ms); };
let prefsTimer: ReturnType<typeof setTimeout> | undefined;
export function schedulePrefsSync(ms = 800) {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const d = pushDeviceStore.getSnapshot();
    if (d?.subscribed) void api("PUT", "/devices/me/prefs", { prefs: toServerPrefs(prefsStore.getSnapshot()) }, d);
  }, ms);
}
