/**
 * Where the HQ's data comes from — the single seam for "BASHT Core Integration" (docs/hq/BASHT-CORE-INTEGRATION.md).
 *
 * Step C1 (live): ONE read-only signal, BASHT's own status. The API probes the engine's EXISTING public `GET /healthz` on the
 * server (services/api/app/basht_core.py) and reports it in `/api/health` → `features.basht`. The HQ never fetches anything
 * itself: the page wrapper (features/basht-core/hq-live.tsx) passes the state in as a prop. Everything else in the HQ — the 13
 * specialists, statuses, numbers and approvals — stays the local simulation; the integration does not need real agents.
 */
export const CORE_STATES = ["unconfigured", "connected", "starting", "offline"] as const;
export type CoreState = (typeof CORE_STATES)[number];
/** `checking` = the status has not arrived yet (or the app server is unreachable). */
export type CoreView = CoreState | "checking";

/** Accepts only a known state; anything else reads as offline (fail closed). A missing value means the API has no engine configured. */
export function parseCoreState(v: unknown): CoreState {
  if (v === undefined || v === null) return "unconfigured";
  return (CORE_STATES as readonly unknown[]).includes(v) ? (v as CoreState) : "offline";
}

/** True only when the engine answered "ready" — the one case the HQ may present BASHT as live. */
export const coreLive = (c: CoreView) => c === "connected";

export const CORE_LINK_AR: Readonly<Record<CoreView, string>> = {
  unconfigured: "غير مربوط بعد — المقر يعمل بالمحاكاة",
  checking: "جارٍ فحص محرك باشت…",
  connected: "متصل بمحرك باشت",
  starting: "محرك باشت قيد التشغيل",
  offline: "تعذّر الوصول إلى محرك باشت",
};
