"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "./icon";
import { useDialogs } from "./dialogs";
import { startReminderEngine, runDueReminders } from "@/lib/reminder-engine";
import { audioPlayer } from "@/lib/audio";
import { SOUND_IDS } from "@/lib/sounds";
import { safeHref, type NoticePriority } from "@/lib/notifications";
import { remindersStore, prefsStore, pushDeviceStore } from "@/lib/stores";
import { detectCaps, enablePush, eraseRemoteDevice, schedulePrefsSync, scheduleSync, syncReminders } from "@/lib/push-client";
import { runCommand } from "@/lib/commands";
import type { AlertOutcome } from "@/lib/alerts";

type Banner = { id: string; title: string; body?: string; priority: NoticePriority; reminderId?: string; href?: string };

/**
 * Mounted once in the root layout. Owns everything that must keep running while the app is open:
 * the reminder engine, in-app alert banners, the service-worker bridge and background sync with the push server.
 */
export default function NotificationRuntime() {
  const router = useRouter();
  const { toast } = useDialogs();
  const [banners, setBanners] = useState<Banner[]>([]);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (id: string) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setBanners((b) => b.filter((x) => x.id !== id));
  };

  // 1) foreground reminder engine + tone preloading
  useEffect(() => {
    audioPlayer().preload([...SOUND_IDS]);
    return startReminderEngine();
  }, []);

  // 2) in-app banners for every delivered alert
  useEffect(() => {
    const onAlert = (e: Event) => {
      const o = (e as CustomEvent<AlertOutcome>).detail;
      if (o.sound === "blocked") setSoundBlocked(true);
      if (o.sound === "played") setSoundBlocked(false);
      const n = o.notice;
      if (!n) return;
      const b: Banner = { id: n.id, title: n.title, priority: n.priority, ...(n.body ? { body: n.body } : {}), ...(n.reminderId ? { reminderId: n.reminderId } : {}), ...(n.href ? { href: n.href } : {}) };
      setBanners((old) => [b, ...old.filter((x) => x.id !== b.id)].slice(0, 3));
      if (n.priority !== "critical") timers.current.set(n.id, setTimeout(() => dismiss(n.id), 14_000)); // critical stays until acted on
    };
    window.addEventListener("safwan:alert", onAlert);
    const live = timers.current;
    return () => { window.removeEventListener("safwan:alert", onAlert); live.forEach(clearTimeout); live.clear(); };
  }, []);

  // 3) service worker bridge + push resubscription + sync
  useEffect(() => {
    const caps = detectCaps();
    const swOk = caps.serviceWorker && caps.secure;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "safwan:push") { void runDueReminders(Date.now()); void syncReminders(); }
      else if (d.type === "safwan:navigate" && typeof d.url === "string") { const h = safeHref(d.url); if (h) router.push(h); }
      else if (d.type === "safwan:resubscribe" && caps.notification && Notification.permission === "granted") void enablePush();
    };
    if (swOk) navigator.serviceWorker.addEventListener("message", onMsg);
    const refresh = async () => {
      if (pushDeviceStore.getSnapshot()?.erasePending) { void eraseRemoteDevice(); return; } // retry a wipe that could not reach the server
      if (!pushDeviceStore.getSnapshot()?.subscribed) return;
      if (caps.notification && Notification.permission === "granted" && swOk) {
        // keep the worker current and re-create a subscription the OS dropped (permission is already granted ⇒ no prompt)
        try {
          const reg = await navigator.serviceWorker.getRegistration("/");
          if (!reg || !(await reg.pushManager.getSubscription())) { await enablePush(); return; }
          void reg.update();
        } catch { /* offline */ }
      }
      void syncReminders();
    };
    void refresh();
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    const u1 = remindersStore.subscribe(() => scheduleSync());
    let lastPrefs = JSON.stringify([prefsStore.getSnapshot().lockScreenContent, prefsStore.getSnapshot().quiet, prefsStore.getSnapshot().tz]);
    const u2 = prefsStore.subscribe(() => {
      const p = prefsStore.getSnapshot(); const k = JSON.stringify([p.lockScreenContent, p.quiet, p.tz]);
      if (k !== lastPrefs) { lastPrefs = k; schedulePrefsSync(); }
    });
    return () => {
      if (swOk) navigator.serviceWorker.removeEventListener("message", onMsg);
      document.removeEventListener("visibilitychange", onVis); window.removeEventListener("online", onVis); u1(); u2();
    };
  }, [router]);

  const act = async (b: Banner, kind: "snooze" | "done") => {
    if (!b.reminderId) return;
    const res = kind === "snooze" ? await runCommand("reminders.snooze", { id: b.reminderId, minutes: 10 }) : await runCommand("reminders.complete", { id: b.reminderId });
    if (res.status === "executed") { toast(kind === "snooze" ? "تم التأجيل 10 دقائق" : "تم إكمال التذكير"); dismiss(b.id); }
    else toast("تعذر تنفيذ الإجراء", "error");
  };
  const enableSound = async () => {
    const r = await audioPlayer().play("success-tone", { volume: prefsStore.getSnapshot().volume });
    if (r === "played") { setSoundBlocked(false); toast("تم تفعيل الصوت"); }
  };

  if (!banners.length && !soundBlocked) return null;
  return (
    <div className="alert-stack" aria-label="تنبيهات">
      {soundBlocked && (
        <div className="alert-banner sound" role="status">
          <Icon name="volume" size={20} />
          <div className="alert-text"><strong>الصوت متوقف حتى تلمس الشاشة</strong><small>تمنع المتصفحات تشغيل الصوت قبل أول تفاعل منك.</small></div>
          <button className="btn btn-sm btn-primary" onClick={() => void enableSound()}>تفعيل الصوت</button>
        </div>
      )}
      {banners.map((b) => (
        <div key={b.id} className={"alert-banner " + b.priority} role={b.priority === "critical" ? "alert" : "status"}>
          <Icon name="bell" size={20} />
          <div className="alert-text"><strong>{b.title}</strong>{b.body && <small>{b.body}</small>}
            <span className="alert-actions">
              {b.reminderId && <button className="btn btn-sm" onClick={() => void act(b, "done")}>تم</button>}
              {b.reminderId && <button className="btn btn-sm" onClick={() => void act(b, "snooze")}>أجّل ١٠ د</button>}
              {b.href && <button className="btn btn-sm btn-ghost" onClick={() => { router.push(b.href!); dismiss(b.id); }}>عرض</button>}
            </span>
          </div>
          <button className="icon-btn sm" onClick={() => dismiss(b.id)} aria-label="إغلاق التنبيه"><Icon name="close" size={18} /></button>
        </div>
      ))}
    </div>
  );
}
