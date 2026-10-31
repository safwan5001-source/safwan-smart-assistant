import "server-only";
import { callBackend, type CallOptions } from "./backend";

export type HealthBody = {
  status: "ok" | "degraded";
  web: "ok";
  backend: "ok" | "unconfigured" | "unreachable" | "rejected" | "unavailable" | "invalid_response";
  version?: string;
  features?: { assistant: boolean; connected_integrations: number; task_execution: boolean };
};

const isFeatures = (v: unknown): v is NonNullable<HealthBody["features"]> => {
  const f = v as Record<string, unknown> | null;
  return !!f && typeof f === "object" && typeof f.assistant === "boolean" && typeof f.task_execution === "boolean" &&
    typeof f.connected_integrations === "number" && Number.isInteger(f.connected_integrations);
};

/** Public, minimal status. It never reveals URLs, secrets, status codes or error text — only a coarse reason. */
export async function buildHealth(opts: Partial<CallOptions> = {}): Promise<{ status: 200 | 503; body: HealthBody }> {
  const r = await callBackend({ path: "/internal/v1/ping", ...opts });
  if (r.kind === "ok") {
    const j = r.json as { status?: unknown; version?: unknown; features?: unknown } | null;
    if (r.status === 200 && j?.status === "ok" && isFeatures(j.features)) {
      return { status: 200, body: { status: "ok", web: "ok", backend: "ok", version: typeof j.version === "string" ? j.version.slice(0, 32) : undefined, features: j.features } };
    }
    return { status: 503, body: { status: "degraded", web: "ok", backend: "invalid_response" } };
  }
  return { status: 503, body: { status: "degraded", web: "ok", backend: r.kind } };
}
