import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowser } from "./setup";
import { detectCaps, disablePush, enablePush, eraseRemoteDevice, getPushState, mergeReminders, pushUnavailableReason, sendTestPush, syncReminders, urlBase64ToUint8Array } from "@/lib/push-client";
import { prefsStore, pushDeviceStore, remindersStore, tombstonesStore } from "@/lib/stores";
import { handleNotify } from "@/server/notify/api";
import { dispatchTick } from "@/server/notify/dispatch";
import { runCommand } from "@/lib/commands";
import { fire } from "@/lib/reminders";
import { fakeSender, makeRuntime, makeSubscription, mkReminder, riyadh, vapid } from "./notify-helpers";

const UA = {
  iosTab: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ios16_0: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
};
const fakeWin = (o: { ua: string; standalone?: boolean; push?: boolean; perm?: NotificationPermission; platform?: string; touch?: number }) => ({
  navigator: { userAgent: o.ua, platform: o.platform ?? "iPhone", maxTouchPoints: o.touch ?? 5, standalone: o.standalone, serviceWorker: {} },
  ...(o.push === false ? {} : { PushManager: class {} }), Notification: { permission: o.perm ?? "default" },
  matchMedia: () => ({ matches: false }), isSecureContext: true,
}) as unknown as Window & typeof globalThis;

describe("capability detection (iPhone rules)", () => {
  it("iPhone in a normal Safari tab → must install to Home Screen first", () => {
    const c = detectCaps(fakeWin({ ua: UA.iosTab, push: false }));
    expect(c).toMatchObject({ ios: true, standalone: false, needsInstall: true });
    expect(pushUnavailableReason(c)).toBe("needs_install");
  });
  it("installed iPhone web app (iOS 17.4) → available; display-mode standalone also counts", () => {
    expect(pushUnavailableReason(detectCaps(fakeWin({ ua: UA.iosTab, standalone: true })))).toBeNull();
    const w = fakeWin({ ua: UA.iosTab }); (w as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: true });
    expect(detectCaps(w).standalone).toBe(true);
  });
  it("iOS older than 16.4 → unsupported (no silent failure)", () => {
    expect(pushUnavailableReason(detectCaps(fakeWin({ ua: UA.ios16_0, standalone: true })))).toBe("unsupported");
  });
  it("iPadOS reporting a Mac UA is still detected as iOS; desktop Chrome is fine", () => {
    expect(detectCaps(fakeWin({ ua: UA.desktop, platform: "MacIntel", touch: 5 })).ios).toBe(true);
    expect(pushUnavailableReason(detectCaps(fakeWin({ ua: UA.desktop, platform: "Linux", touch: 0 })))).toBeNull();
  });
  it("insecure context or no service worker → unsupported", () => {
    const w = fakeWin({ ua: UA.desktop, platform: "Linux", touch: 0 }); (w as unknown as { isSecureContext: boolean }).isSecureContext = false;
    expect(pushUnavailableReason(detectCaps(w))).toBe("unsupported");
  });
});

describe("pure helpers", () => {
  it("VAPID key base64url → 65-byte uncompressed P-256 point", () => {
    const k = urlBase64ToUint8Array(vapid.publicKey);
    expect(k.length).toBe(65); expect(k[0]).toBe(4);
  });
  it("mergeReminders: higher rev wins, equal keeps local, tombstones are never resurrected, remote-only is adopted", () => {
    const a = mkReminder({}, 0, "a"), b = mkReminder({}, 0, "b");
    const out = mergeReminders([a, { ...b, title: "local", rev: 2 }], [{ ...a, title: "remote", rev: a.rev + 1 }, { ...b, title: "remote-old", rev: 2 }, mkReminder({}, 0, "c"), mkReminder({}, 0, "dead")], ["dead"]);
    expect(out.find((r) => r.id === "a")!.title).toBe("remote");
    expect(out.find((r) => r.id === "b")!.title).toBe("local");
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("client ⇄ server flow (real handlers, in-process transport, fake browser push APIs)", () => {
  const NOW = riyadh(2026, 11, 2, 2, 0);
  let now = NOW;
  let rt: ReturnType<typeof makeRuntime>; let sender: ReturnType<typeof fakeSender>;
  let perm: NotificationPermission; let sub: ReturnType<typeof makeSubscription>["sub"]; let unsubscribed: number; let subscribeCalls: number; let existing: unknown;
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const stub = (k: string, v: unknown) => { saved[k] ??= Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };

  beforeEach(() => {
    installBrowser(); now = NOW; sender = fakeSender(); rt = makeRuntime({ send: sender.send, now: () => now });
    sub = makeSubscription().sub; unsubscribed = 0; subscribeCalls = 0; existing = null; perm = "default";
    for (const s of [remindersStore, tombstonesStore, pushDeviceStore, prefsStore]) s.reset();
    const subscription = () => ({ endpoint: sub.endpoint, toJSON: () => sub, options: { applicationServerKey: urlBase64ToUint8Array(vapid.publicKey).buffer }, unsubscribe: async () => { unsubscribed++; existing = null; return true; } });
    const pushManager = { getSubscription: async () => existing, subscribe: async () => { subscribeCalls++; existing = subscription(); return existing; } };
    stub("navigator", { userAgent: UA.desktop, platform: "Linux", maxTouchPoints: 0, serviceWorker: { register: async () => ({ pushManager }), ready: Promise.resolve({}), getRegistration: async () => ({ pushManager }) } });
    stub("Notification", { get permission() { return perm; }, requestPermission: async () => { if (perm !== "denied") perm = "granted"; return perm; } });
    stub("PushManager", class {});
    (g.window as Record<string, unknown>).navigator = g.navigator; (g.window as Record<string, unknown>).PushManager = g.PushManager; (g.window as Record<string, unknown>).Notification = g.Notification;
    (g.window as Record<string, unknown>).matchMedia = () => ({ matches: false }); (g.window as Record<string, unknown>).isSecureContext = true;
    stub("fetch", async (url: string, init: RequestInit = {}) => handleNotify(new Request(`http://localhost${url}`, init), url.replace("/api/notify", "").split("/").filter(Boolean), rt));
  });
  afterEach(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete g[k]; } vi.restoreAllMocks(); });

  it("enable → permission → subscribe → register device → server holds the subscription", async () => {
    expect(await getPushState()).toBe("off");
    expect(await enablePush()).toBe("on");
    expect(perm).toBe("granted"); expect(subscribeCalls).toBe(1);
    const d = pushDeviceStore.getSnapshot()!;
    expect(d.subscribed).toBe(true);
    expect((await rt.store!.getDevice(d.deviceId))!.subscription).toEqual(sub);
    expect(await getPushState()).toBe("on");
    expect(await enablePush()).toBe("on"); // idempotent: re-uses the browser subscription
    expect(subscribeCalls).toBe(1);
  });
  it("permission denied is reported, nothing is registered", async () => {
    perm = "denied";
    expect(await getPushState()).toBe("denied");
    expect(await enablePush()).toBe("denied");
    expect(pushDeviceStore.getSnapshot()).toBeNull();
  });
  it("server without VAPID keys → 'unconfigured', never pretends", async () => {
    rt = makeRuntime({ env: { VAPID_PUBLIC_KEY: "" } });
    expect(await getPushState()).toBe("unconfigured");
    expect(await enablePush()).toBe("unconfigured");
  });
  it("reminders sync up; a push fired on the server is adopted by the client (no double alert); deletes propagate", async () => {
    await enablePush();
    const d = pushDeviceStore.getSnapshot()!;
    const r = mkReminder({}, NOW, "flow1");
    remindersStore.set([r]);
    expect(await syncReminders()).toBe(true);
    expect(await rt.store!.listReminders(d.deviceId)).toHaveLength(1);
    // app is "closed": the server fires at the due time
    now = r.dueAt + 1000;
    expect(await dispatchTick(rt.store!, rt.send!, now)).toMatchObject({ fired: 1, sent: 1 });
    expect(sender.sent).toHaveLength(1);
    // app reopens and syncs: it adopts the already-fired state so the local engine will not alert again
    await syncReminders();
    const local = remindersStore.getSnapshot()[0];
    expect(local.status).toBe("fired");
    expect(fire(local, now).fired).toEqual([]);
    // delete locally → tombstone → server forgets
    await runCommand("reminders.remove", { id: "flow1" });
    expect(tombstonesStore.getSnapshot()).toContain("flow1");
    await syncReminders();
    expect(tombstonesStore.getSnapshot()).toEqual([]);
    expect(await rt.store!.listReminders(d.deviceId)).toEqual([]);
    expect(remindersStore.getSnapshot()).toEqual([]); // not resurrected
  });
  it("a failed sync keeps tombstones for the next attempt", async () => {
    await enablePush();
    tombstonesStore.set(["gone1"]);
    const real = g.fetch as typeof fetch;
    stub("fetch", async () => { throw new Error("offline"); });
    expect(await syncReminders()).toBe(false);
    expect(tombstonesStore.getSnapshot()).toEqual(["gone1"]);
    stub("fetch", real);
    expect(await syncReminders()).toBe(true);
    expect(tombstonesStore.getSnapshot()).toEqual([]);
  });
  it("server forgot the device (401) → local credentials dropped, no crash; can re-enable", async () => {
    await enablePush();
    await rt.store!.deleteDevice(pushDeviceStore.getSnapshot()!.deviceId);
    expect(await syncReminders()).toBe(false);
    expect(pushDeviceStore.getSnapshot()).toBeNull();
    expect(await enablePush()).toBe("on");
    expect(pushDeviceStore.getSnapshot()!.subscribed).toBe(true);
  });
  it("test push: sent / expired / not enabled", async () => {
    expect(await sendTestPush()).toBe("not_enabled");
    await enablePush();
    expect(await sendTestPush()).toBe("sent");
    sender = fakeSender(() => 410); rt = makeRuntime({ send: sender.send, now: () => now, store: rt.store! });
    expect(await sendTestPush()).toBe("expired");
    expect(pushDeviceStore.getSnapshot()!.subscribed).toBe(false);
  });
  it("disable removes browser + server subscription and server-side reminders", async () => {
    await enablePush();
    const d = pushDeviceStore.getSnapshot()!;
    remindersStore.set([mkReminder({}, NOW, "dis1")]); await syncReminders();
    expect(await disablePush()).toBe("off");
    expect(unsubscribed).toBeGreaterThan(0);
    expect((await rt.store!.getDevice(d.deviceId))!.subscription).toBeNull();
    expect(await rt.store!.listReminders(d.deviceId)).toEqual([]);
    expect(remindersStore.getSnapshot()).toHaveLength(1); // local data untouched
  });
  it("«مسح كل البيانات» erases the server copy too and reports it", async () => {
    await enablePush();
    const d = pushDeviceStore.getSnapshot()!;
    remindersStore.set([mkReminder({}, NOW, "wipe1")]); await syncReminders();
    const res = await runCommand("data.erase_all", {}, { approved: true });
    expect(res).toMatchObject({ status: "executed", data: { serverErased: true } });
    expect(await rt.store!.getDevice(d.deviceId)).toBeNull();
    expect(pushDeviceStore.getSnapshot()).toBeNull(); expect(remindersStore.getSnapshot()).toEqual([]);
  });
  it("erase reports failure honestly when the server is unreachable (and keeps credentials to retry)", async () => {
    await enablePush();
    stub("fetch", async () => { throw new Error("offline"); });
    expect(await eraseRemoteDevice()).toBe(false);
    expect(pushDeviceStore.getSnapshot()).not.toBeNull();
  });
});
