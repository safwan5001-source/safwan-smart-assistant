import { createECDH, randomBytes } from "node:crypto";
import type { Reminder, ReminderInput } from "@/lib/reminders";
import { createReminder } from "@/lib/reminders";
import { readNotifyConfig } from "@/server/notify/config";
import { createMemoryStore } from "@/server/notify/memory-store";
import { buildRuntime, type Runtime } from "@/server/notify/runtime";
import type { NotifyStore, PushSub } from "@/server/notify/types";
import type { PushSender } from "@/server/notify/push";
import { handleNotify } from "@/server/notify/api";
import { generateVAPIDKeys } from "web-push";

export const riyadh = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 3, mi);

/** A REAL P-256 subscription (so web-push can genuinely encrypt for it). */
export function makeSubscription(endpoint = "https://web.push.apple.com/QZ1") {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  return { sub, ecdh, auth };
}

export const vapid = generateVAPIDKeys();
export const testEnv = (over: Record<string, string> = {}) => ({
  NODE_ENV: "test", VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:ops@example.com",
  NOTIFY_DISPATCH_SECRET: "s".repeat(32), ...over,
});

export type Sent = { endpoint: string; payload: string; opts: Parameters<PushSender>[2] };
export function fakeSender(script: (n: number, s: Sent) => number | { status: number; error?: string } = () => 201) {
  const sent: Sent[] = [];
  const send: PushSender = async (sub, payload, opts) => {
    const s = { endpoint: sub.endpoint, payload, opts }; sent.push(s);
    const r = script(sent.length, s);
    return typeof r === "number" ? { status: r } : r;
  };
  return { sent, send };
}

export function makeRuntime(opts: { store?: NotifyStore; send?: PushSender; env?: Record<string, string>; now?: () => number } = {}): Runtime {
  return buildRuntime(readNotifyConfig(testEnv(opts.env)), { store: opts.store ?? createMemoryStore(), send: opts.send ?? (async () => ({ status: 201 })), now: opts.now });
}

let n = 0;
export const mkReminder = (over: Partial<ReminderInput> = {}, now = riyadh(2026, 11, 2, 2, 0), id = `r${++n}`): Reminder =>
  createReminder({ title: "مراجعة الفواتير", time: "09:00", date: "2026-11-03", ...over }, now, id);

export const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/api/notify", { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export async function registerDevice(rt: Runtime, sub?: PushSub, prefs: unknown = {}) {
  const res = await handleNotify(req("POST"), ["devices"], rt);
  const { deviceId, token } = (await res.json()) as { deviceId: string; token: string };
  const auth = { Authorization: `Bearer ${deviceId}.${token}` };
  if (sub) await handleNotify(req("PUT", { subscription: sub, prefs }, auth), ["devices", "me", "subscription"], rt);
  return { deviceId, token, auth };
}
