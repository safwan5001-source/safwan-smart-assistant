import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Owner gate for the chat browser feature.
 *
 * There is no account system on this branch yet (login arrives with the passkey work, B2), so the existing "user" boundary cannot be
 * reused. Until then the feature is OFF unless the owner sets BROWSER_CHAT_ACCESS_CODE (32+ chars) on the WEB service. The owner types it
 * once; the server answers with a signed, HttpOnly, SameSite=Strict cookie that expires in 8 hours. The code itself is never stored by the
 * client, never in a NEXT_PUBLIC_* variable, never in the bundle. Rotating the code invalidates every cookie. This is a deliberate stop-gap:
 * when real sessions exist, `verifyCookie` is the single place to replace.
 */
export type Env = Record<string, string | undefined>;
export const MIN_CODE_CHARS = 32;
/** Rejects "aaaa…", repeated phrases and keyboard runs: generate with `openssl rand -base64 36`. The cookie MAC key is derived from this code. */
export const MIN_DISTINCT_CHARS = 14;
export const COOKIE_NAME = "safwan_bc";
export const COOKIE_PATH = "/api/browser";
export const COOKIE_TTL_S = 8 * 3600;

export type Gate = { key: Buffer; code: Buffer };

export function readGate(env: Env = process.env): Gate | null {
  const code = env.BROWSER_CHAT_ACCESS_CODE;
  if (!code || Buffer.byteLength(code, "utf8") < MIN_CODE_CHARS || new Set(code).size < MIN_DISTINCT_CHARS) return null; // length alone says nothing about randomness
  // Domain-separated key: the access code is never used directly as an HMAC key, and no other feature can mint these cookies.
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), Buffer.from("safwan-browser-chat"), Buffer.from("cookie-v1"), 32));
  return { key, code: Buffer.from(code, "utf8") };
}

const mac = (gate: Gate, payload: string) => createHmac("sha256", gate.key).update(payload).digest("base64url");

/** Constant-time comparison that does not leak the length of the real code through timing. */
export function codeMatches(gate: Gate, supplied: unknown): boolean {
  if (typeof supplied !== "string" || supplied.length > 256) return false;
  const a = createHmac("sha256", gate.key).update("code:" + supplied).digest();
  const b = createHmac("sha256", gate.key).update("code:" + gate.code.toString("utf8")).digest();
  return timingSafeEqual(a, b);
}

export function issueCookieValue(gate: Gate, nowMs: number): string {
  const exp = Math.floor(nowMs / 1000) + COOKIE_TTL_S;
  const payload = `v1.${exp}`;
  return `${payload}.${mac(gate, payload)}`;
}

export function verifyCookieValue(gate: Gate, value: string | undefined, nowMs: number): boolean {
  if (!value || value.length > 200) return false;
  const m = /^(v1\.([0-9]{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const expected = Buffer.from(mac(gate, m[1])), given = Buffer.from(m[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const exp = Number(m[2]);
  return exp > Math.floor(nowMs / 1000) && exp <= Math.floor(nowMs / 1000) + COOKIE_TTL_S + 60;
}

export function readCookie(req: Request, name = COOKIE_NAME): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function setCookieHeader(value: string, secure: boolean, maxAge = COOKIE_TTL_S): string {
  return `${COOKIE_NAME}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
