import "server-only";
import { createHash } from "node:crypto";
import type { Agent } from "node:https";
import webpush from "web-push";
import type { Fired, ReminderPriority } from "@/lib/reminders";
import { leadLabel } from "@/lib/reminders";
import { formatInZone, TZ_LABEL } from "@/lib/tz";
import type { ServerPrefs } from "@/lib/notify-prefs";
import type { NotifyConfig } from "./config";
import type { NewDelivery, PushSub } from "./types";

export type PushPayload = {
  v: 1; key: string; kind: "reminder" | "test" | "basht"; title: string; body: string; url: string; tag: string;
  priority: ReminderPriority; generic: boolean; reminderId?: string; dueAt?: number; alert?: BashtAlert;
};
/** B4: what BASHT tells the owner while the app is closed. */
export type BashtAlert = "approval" | "reply" | "cron_failed" | "offline" | "online";

/** Generic text is the default so nothing private appears on a locked screen unless the user opted in. */
export const GENERIC_TITLE = "باشت";
export const GENERIC_BODY = "لديك تذكير";
const REMINDER_TTL_S = 3600;
const RETRY_WINDOW_MS = 6 * 3600_000;

export function reminderPayload(f: Fired, prefs: ServerPrefs): PushPayload {
  const rich = prefs.lockScreenContent;
  const when = `${formatInZone(f.dueAt, f.tz)} · ${TZ_LABEL(f.tz)}`;
  const lead = f.minutesBefore > 0 ? `${leadLabel(f.minutesBefore).replace("قبل", "بعد")} · ` : "حان الموعد · ";
  return {
    v: 1, key: f.key, kind: "reminder", reminderId: f.reminderId, dueAt: f.dueAt, priority: f.priority, generic: !rich,
    title: rich ? (f.kind === "snooze" ? "تذكير مؤجَّل: " : "تذكير: ") + f.title : GENERIC_TITLE,
    body: rich ? lead + when : GENERIC_BODY,
    url: `/reminders?focus=${encodeURIComponent(f.reminderId)}`,
    tag: f.key,
  };
}
/**
 * Privacy is decided at SEND time: a push queued while "show text on the lock screen" was on must not leak that text after the user
 * turned it off (and synced) — the stored payload is redacted to the generic wording. The opposite direction is never upgraded.
 */
export function applyPrivacy(payload: string, prefs: ServerPrefs): string {
  if (prefs.lockScreenContent) return payload;
  try {
    const p = JSON.parse(payload) as Partial<PushPayload>;
    if (!p || typeof p !== "object" || p.generic === true) return payload;
    if (p.kind === "basht" && p.alert && p.alert in BASHT_TEXT) return JSON.stringify({ ...p, ...BASHT_TEXT[p.alert], generic: true });
    if (p.kind !== "reminder") return payload;
    return JSON.stringify({ ...p, title: GENERIC_TITLE, body: GENERIC_BODY, generic: true });
  } catch { return payload; }
}
// B4 wording: short Arabic, nothing private on a locked screen by default (no command, no reply text). With the owner's
// "show content on the lock screen" option, an approval shows a short command preview and a failed automation its name.
const BASHT_TEXT: Record<BashtAlert, { title: string; body: string }> = {
  approval: { title: "باشت ينتظر موافقتك", body: "طلب تنفيذ ينتظر موافقتك أو رفضك." },
  reply: { title: GENERIC_TITLE, body: "رد باشت جاهز." },
  cron_failed: { title: GENERIC_TITLE, body: "تعذّر تنفيذ مهمة مجدولة." },
  offline: { title: GENERIC_TITLE, body: "باشت غير متصل منذ أكثر من دقيقتين." },
  online: { title: GENERIC_TITLE, body: "عاد باشت متصلًا." },
};
const BASHT_TAG: Record<BashtAlert, string> = { approval: "", reply: "basht-reply", cron_failed: "basht-cron", offline: "basht-link", online: "basht-link" };
const BASHT_TTL_S: Record<BashtAlert, number> = { approval: 1800, reply: 3600, cron_failed: 6 * 3600, offline: 1800, online: 1800 };
export const bashtTtl = (a: BashtAlert | undefined) => (a ? BASHT_TTL_S[a] : REMINDER_TTL_S);
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function bashtPayload(alert: BashtAlert, key: string, o: { url: string; detail?: string | null }, prefs: ServerPrefs): PushPayload {
  const t = BASHT_TEXT[alert];
  const rich = prefs.lockScreenContent && !!o.detail && (alert === "approval" || alert === "cron_failed");
  return {
    v: 1, key, kind: "basht", alert, title: t.title, url: o.url, tag: BASHT_TAG[alert] || key,
    body: rich ? (alert === "approval" ? `«${clip(o.detail!, 60)}»` : `${t.body.replace(/\.$/, "")}: ${clip(o.detail!, 40)}`) : t.body,
    priority: alert === "approval" ? "high" : "normal", generic: !rich,
  };
}

export function testPayload(key: string): PushPayload {
  return { v: 1, key, kind: "test", title: GENERIC_TITLE, body: "هذا إشعار تجريبي — الإشعارات تعمل على هذا الجهاز.", url: "/settings", tag: key, priority: "normal", generic: true };
}
export function deliveryOf(p: PushPayload, now: number): NewDelivery {
  return { key: p.key, reminderId: p.reminderId ?? null, kind: p.kind, payload: JSON.stringify(p), priority: p.priority, createdAt: now, expiresAt: now + RETRY_WINDOW_MS };
}

export type SendResult = { status: number; error?: string };
export type PushSender = (sub: PushSub, payload: string, o: { ttl: number; urgency: "low" | "normal" | "high"; topic: string }) => Promise<SendResult>;

export const topicOf = (key: string) => createHash("sha256").update(key).digest("base64url").slice(0, 32);
export const urgencyOf = (p: ReminderPriority): "normal" | "high" => (p === "high" || p === "critical" ? "high" : "normal");
export const ttlOf = (kind: "reminder" | "test" | "basht") => (kind === "test" ? 120 : REMINDER_TTL_S);

export function createWebPushSender(cfg: NonNullable<NotifyConfig["push"]>, opts: { agent?: Agent } = {}): PushSender {
  const vapid = { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey };
  return async (sub, payload, o) => {
    try {
      const r = await webpush.sendNotification(sub, payload, { vapidDetails: vapid, TTL: o.ttl, urgency: o.urgency, topic: o.topic, timeout: 10_000, ...(opts.agent ? { agent: opts.agent } : {}) });
      return { status: r.statusCode };
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string; code?: string };
      // never keep the endpoint / body in the error text: only a short machine code
      return { status: typeof err.statusCode === "number" ? err.statusCode : 0, error: String(err.code ?? (err.statusCode ? `http_${err.statusCode}` : "network")).slice(0, 60) };
    }
  };
}
