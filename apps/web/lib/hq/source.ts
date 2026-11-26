/**
 * Where the HQ's data comes from — the single seam for the future "BASHT Core Integration" phase (docs/hq/BASHT-CORE-INTEGRATION.md).
 *
 * Today: the local simulation only. Nothing here connects to anything.
 * Later (after owner approval), step 1 adds ONE read-only signal: BASHT's own status, taken from the engine's EXISTING public
 * health endpoint (openclaw-railway-template, `GET /healthz` → `{ ok, gateway }`, src/server.js:634) by the API's existing
 * integrations layer on the server — never from the browser, with no change to OpenClaw. The 13 specialists stay visual-only
 * until real agents exist; the integration does not need them.
 */
export type HqSource = "simulation" | "core";
/** Flip only when step 1 of the integration is approved and implemented server-side. */
export const HQ_SOURCE: HqSource = "simulation";

/** The engine's existing health payload, as served today. */
export type CoreHealth = { ok: boolean; gateway: string };
export type CoreLink = "connected" | "starting" | "offline";

/** Maps the engine's health to the one state the HQ will show for BASHT. Anything unexpected reads as offline (fail closed). */
export function coreLink(h: CoreHealth | null | undefined): CoreLink {
  if (!h || h.ok !== true) return "offline";
  if (h.gateway === "ready") return "connected";
  if (h.gateway === "starting") return "starting";
  return "offline";
}

export const CORE_LINK_AR: Readonly<Record<CoreLink | "simulation", string>> = {
  simulation: "غير مربوط بعد — المقر يعمل بالمحاكاة",
  connected: "متصل بمحرك باشت",
  starting: "محرك باشت قيد التشغيل",
  offline: "تعذّر الوصول إلى محرك باشت",
};
