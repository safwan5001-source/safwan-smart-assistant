import "server-only";
import { callBackend, type CallOptions, type Env } from "./backend";
import { CORE_STATES, type CoreState } from "@/lib/hq/source";

export type HealthBody = {
  status: "ok" | "degraded";
  web: "ok";
  backend: "ok" | "unconfigured" | "unreachable" | "rejected" | "unavailable" | "invalid_response";
  version?: string;
  /** `assistant` and `connected_integrations` are LEGACY (R11): a configured direct-provider key and a count of the old catalogue.
   *  Neither is a readiness signal and no badge is drawn from them; BASHT's readiness is `basht` plus the engine's own /status. */
  features?: { assistant: boolean; connected_integrations: number; task_execution: boolean; basht?: CoreState; basht_chat?: boolean };
};

/** Rebuilds the features from known fields only, so nothing unexpected from the backend is ever echoed publicly. */
function readFeatures(v: unknown): HealthBody["features"] | null {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f !== "object" || typeof f.assistant !== "boolean" || typeof f.task_execution !== "boolean" ||
    typeof f.connected_integrations !== "number" || !Number.isInteger(f.connected_integrations)) return null;
  const out: NonNullable<HealthBody["features"]> = { assistant: f.assistant, connected_integrations: f.connected_integrations, task_execution: f.task_execution };
  // BASHT engine state (C1): optional for older APIs; an unknown value reads as offline (fail closed)
  if (typeof f.basht_chat === "boolean") out.basht_chat = f.basht_chat; // C2/C4: the app can chat with BASHT
  if (f.basht !== undefined) out.basht = (CORE_STATES as readonly unknown[]).includes(f.basht) ? (f.basht as CoreState) : "offline";
  return out;
}

/** Public, minimal status. It never reveals URLs, secrets, status codes or error text — only a coarse reason. */
export async function buildHealth(opts: Partial<CallOptions> = {}): Promise<{ status: 200 | 503; body: HealthBody }> {
  const r = await callBackend({ path: "/internal/v1/ping", ...opts });
  if (r.kind === "ok") {
    const j = r.json as { status?: unknown; version?: unknown; features?: unknown } | null;
    const features = readFeatures(j?.features);
    if (r.status === 200 && j?.status === "ok" && features) {
      return { status: 200, body: { status: "ok", web: "ok", backend: "ok", version: typeof j.version === "string" ? j.version.slice(0, 32) : undefined, features } };
    }
    return { status: 503, body: { status: "degraded", web: "ok", backend: "invalid_response" } };
  }
  return { status: 503, body: { status: "degraded", web: "ok", backend: r.kind } };
}

type Health = Awaited<ReturnType<typeof buildHealth>>;
export const DEFAULT_HEALTH_CACHE_MS = 5_000;
/** `HEALTH_CACHE_MS` (0 disables the cache; clamped to 60 s; anything unparseable falls back to the default). */
export function healthCacheMs(env: Env = process.env): number {
  const raw = env.HEALTH_CACHE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEALTH_CACHE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 60_000) : DEFAULT_HEALTH_CACHE_MS;
}
let last: { at: number; value: Health } | null = null;
let inflight: Promise<Health> | null = null;

/**
 * What the PUBLIC route serves. `/api/health` is unauthenticated, and every real probe costs the backend a signature check,
 * a PostgreSQL connection and a nonce row. Without this, anyone could turn it into a write/connection amplifier against the
 * database (and Railway's default `max_connections` is 100). Result: at most ONE backend call per cache window (default 5 s) per web
 * instance, concurrent requests share the in-flight probe, and a failing backend is not hammered either.
 */
export function cachedHealth(now: () => number = Date.now, probe: () => Promise<Health> = () => buildHealth()): Promise<Health> {
  if (last && now() - last.at < healthCacheMs()) return Promise.resolve(last.value);
  if (inflight) return inflight;
  const started = now();
  inflight = probe()
    .then((value) => { last = { at: started, value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Test seam only. */
export function resetHealthCache(): void { last = null; inflight = null; }
