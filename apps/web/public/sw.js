/*
 * باشت | BASHT — service worker (Web Push + notification clicks only).
 *
 * Deliberately NOT a caching/offline worker: it never intercepts fetches, so it cannot serve stale app code.
 * iOS rules this file respects:
 *  - every push MUST end in showNotification (Safari revokes subscriptions that receive "silent" pushes);
 *  - notification actions/sound/vibration are not honoured by iOS Web Push — the system chooses the sound.
 * Payload shape: see server/notify/push.ts (PushPayload). Anything malformed degrades to a generic notification.
 */
const ICON = "/icons/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function readPayload(event) {
  try {
    const p = event.data ? event.data.json() : null;
    if (!p || typeof p !== "object") return null;
    const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    return {
      key: str(p.key, 200), kind: p.kind === "test" ? "test" : "reminder", title: str(p.title, 200), body: str(p.body, 500),
      url: str(p.url, 200), priority: ["low", "normal", "high", "critical"].includes(p.priority) ? p.priority : "normal",
      reminderId: str(p.reminderId, 80), tag: str(p.tag, 200),
    };
  } catch {
    return null;
  }
}

/** Only same-origin paths may be opened from a notification. */
function safeUrl(raw) {
  try {
    const u = new URL(raw || "/", self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  const p = readPayload(event) || { key: "", kind: "reminder", title: "باشت", body: "لديك إشعار", url: "/", priority: "normal", reminderId: "", tag: "" };
  const options = {
    body: p.body || "لديك إشعار",
    tag: p.tag || p.key || undefined, // same tag ⇒ the system replaces instead of stacking duplicates
    icon: ICON, badge: ICON, lang: "ar", dir: "rtl", renotify: false, silent: false,
    requireInteraction: p.priority === "critical", // ignored on iOS; honoured on desktop/Android
    timestamp: Date.now(),
    data: { url: safeUrl(p.url), key: p.key, reminderId: p.reminderId, kind: p.kind },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(p.title || "باشت", options);
    // wake open windows so the in-app engine can add the full-content inbox item (idempotent by key)
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "safwan:push", key: p.key, kind: p.kind, reminderId: p.reminderId });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = safeUrl(data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      try { await w.focus(); } catch { /* iOS may refuse focus() */ }
      w.postMessage({ type: "safwan:navigate", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The push service rotated our subscription: tell the app to re-subscribe + sync (it needs a window to do so).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "safwan:resubscribe" });
  })());
});
