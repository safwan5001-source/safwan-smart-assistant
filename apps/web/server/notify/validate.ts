import "server-only";
import { parseReminders, REMINDER_LIMITS, type Reminder } from "@/lib/reminders";
import type { PushSub } from "./types";

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Hosts of the real browser push services. The server will POST only to these (SSRF defence). */
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com", ".push.microsoft.com"];
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com", "android.googleapis.com"]);

export type EndpointPolicy = { extraHosts: string[]; production: boolean };
export function isAllowedEndpoint(raw: string, policy: EndpointPolicy): boolean {
  if (raw.length > 1000) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:" && u.port === "" || (u.protocol === "https:" && u.port === "443")) {
    if (PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
    if (policy.extraHosts.includes(host) && !isPrivateHost(host)) return true;
    return false;
  }
  // plain http to loopback is accepted only outside production and only when explicitly listed (local mock push service)
  if (!policy.production && u.protocol === "http:" && (host === "127.0.0.1" || host === "localhost") && policy.extraHosts.includes(host)) return true;
  return false;
}
function isPrivateHost(h: string): boolean {
  return h === "localhost" || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h === "::1" || h.endsWith(".internal") || h.endsWith(".local");
}

export function parseSubscription(v: unknown, policy: EndpointPolicy): PushSub | null {
  const o = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!o || typeof o.endpoint !== "string" || !o.keys) return null;
  const { p256dh, auth } = o.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!B64URL.test(p256dh) || p256dh.length !== 87 || !B64URL.test(auth) || auth.length !== 22) return null;
  if (!isAllowedEndpoint(o.endpoint, policy)) return null;
  return { endpoint: o.endpoint, keys: { p256dh, auth } };
}

/** A full sync carries up to REMINDER_LIMITS.perDevice reminders (title ≤200 + notes ≤2000 chars, multi-byte in Arabic): 5 MiB is a safe bound. */
export const SYNC_MAX_BYTES = 5 * 1024 * 1024;
export type SyncBody = { reminders: Reminder[]; deleted: string[] };
export function parseSyncBody(v: unknown): SyncBody | null {
  const o = v as { reminders?: unknown; deleted?: unknown } | null;
  if (!o || !Array.isArray(o.reminders) || o.reminders.length > REMINDER_LIMITS.perDevice) return null;
  const reminders = parseReminders(o.reminders);
  const deleted = Array.isArray(o.deleted) ? o.deleted.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80).slice(0, 500) : [];
  return { reminders, deleted };
}

/** Reads a JSON body with a hard byte cap and a JSON content type. Returns undefined on any violation. */
export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown | undefined> {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) return undefined;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
