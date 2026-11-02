import "server-only";
/**
 * Interactive "lab" scopes for the BFF: `host/prefix/` entries from BROWSER_INTERACTIVE_SCOPES (same value as on the API and the worker).
 * Empty or any invalid entry => interactive control is OFF here (fail closed). The API and the worker validate again on their own.
 */
import type { Env } from "../backend";

const SCOPE = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(\/(?:[A-Za-z0-9._~-]{1,40}\/){1,6})$/;
const INTERNAL_TLD = /\.(internal|local|localhost|localdomain|lan|home|corp|intranet)$/;
export type Scope = { host: string; prefix: string };

export function readScopes(env: Env): Scope[] {
  const out: Scope[] = [];
  for (const raw of (env.BROWSER_INTERACTIVE_SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = SCOPE.exec(raw);
    if (!m || INTERNAL_TLD.test(m[1]) || raw.includes("..") || raw.length > 120) return [];
    out.push({ host: m[1], prefix: m[2] });
  }
  return out;
}

const READ_ONLY_TARGET = /^https:\/\/example\.com(?:\/[A-Za-z0-9._~/-]{0,120})?$/;
const READ_ONLY_RESULT = /^https:\/\/example\.com\/[\x21-\x7e]{0,300}$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Start page / `navigate` target: the look-only host, or a page INSIDE a scope. Regex over the raw string (no URL parser). */
export function sessionTargetOk(url: unknown, scopes: Scope[]): url is string {
  if (typeof url !== "string" || url.length > 200 || url.split("/").includes("..")) return false;
  return READ_ONLY_TARGET.test(url) || scopes.some((s) => new RegExp(`^https://${esc(s.host)}${esc(s.prefix)}[A-Za-z0-9._~/-]{0,100}$`).test(url));
}
/** Any URL the worker reports (current page, form destination): inside a scope (or the look-only host), visible ASCII only. */
export function sessionResultOk(url: unknown, scopes: Scope[]): url is string {
  if (typeof url !== "string") return false;
  return READ_ONLY_RESULT.test(url) || scopes.some((s) => new RegExp(`^https://${esc(s.host)}${esc(s.prefix)}[\\x21-\\x7e]{0,250}$`).test(url));
}
export const sessionStartUrl = (scopes: Scope[]): string | null => (scopes[0] ? `https://${scopes[0].host}${scopes[0].prefix}index.html` : null);
