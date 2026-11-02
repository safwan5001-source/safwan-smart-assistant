import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceRec, NotifyStore } from "./types";

/**
 * Device identity. There is no account system on `main` yet (PR #26), so a device authenticates with a random
 * 256-bit bearer secret issued at registration. Only its SHA-256 is stored; comparison is constant-time.
 * When real auth lands, devices should be bound to a user at registration — the rest of the API stays the same.
 */
export const newDeviceId = () => randomUUID();
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `Authorization: Bearer <deviceId>.<secret>` → the device, or null (never says which part was wrong). */
export async function authenticate(req: Request, store: NotifyStore): Promise<DeviceRec | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(h);
  if (!m || !UUID.test(m[1])) return null;
  const dev = await store.getDevice(m[1]);
  // always hash, even for unknown devices, so timing does not reveal existence
  const given = hashToken(m[2]);
  if (!dev) { safeEqualHex(given, given); return null; }
  return safeEqualHex(given, dev.tokenHash) ? dev : null;
}

export function bearerMatches(req: Request, secret: string | null): boolean {
  if (!secret) return false;
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(h.slice(7)).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
