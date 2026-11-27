import "server-only";
/**
 * /api/basht/{automations,usage,memory,capabilities} — B5–B7: BASHT's scheduled tasks, usage, memory (read-only) and what BASHT
 * can do now. Called by handleBashtChat AFTER its owner gate, same-origin check and rate limits (server/basht-chat.ts), so this
 * file only maps routes to fixed API paths, validates inputs and passes a fixed list of refusal codes.
 *
 *   GET  automations                 GET  automations/<id>/runs      POST automations/<id>/run     POST automations/<id>/enabled
 *   GET  usage                       GET  memory/status              GET  memory/search?q=&page=    GET  memory/item?ref=&part=
 *   GET  memory/file?name=&part=     GET  capabilities
 */
import type { callBackend as realCallBackend } from "./backend";
import type { Env } from "./assistant-chat-gate";

type Deps = { env: Env; callBackend: typeof realCallBackend };
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const err = (code: string, status: number) => json({ error: code }, status);

/** Refusals the browser may see as they are (never upstream text). */
export const CONTROL_CODES = new Set(["control_unavailable", "system_job", "rejected", "bad_request"]);
/** Engine job ids are UUIDs; the API path alphabet is lower-case (server/backend.ts), so anything else is not addressable here. */
export const JOB = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const REF = /^[0-9a-f]{24}$/;
const FILES = new Set(["MEMORY.md", "USER.md"]);
const API_ERRORS: Record<number, [number, string]> = { 400: [400, "bad_request"], 404: [404, "not_found"], 409: [409, "busy"], 422: [400, "bad_request"], 429: [429, "rate_limited"], 503: [503, "unavailable"] };
/** Capabilities can take several engine CLI calls on a cold cache; the two switches queue one at a time. */
const SLOW_MS = 45_000;

async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
  if ((req.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") return undefined;
  const text = await req.text().catch(() => "");
  if (text.length > 1024) return undefined;
  try { const v = JSON.parse(text || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}
const part = (v: string | null) => (v === null ? 0 : /^\d$/.test(v) ? Number(v) : null);

/** Returns a Response for a control route, or null when `route` is not one (the caller continues with its own routes). */
export async function handleBashtControl(req: Request, route: string, deps: Deps): Promise<Response | null> {
  const relay = async (apiPath: string, method: "GET" | "POST", body?: unknown, timeoutMs = 20_000) => {
    const r = await deps.callBackend({ path: apiPath, method, body, env: deps.env, timeoutMs, maxBytes: 512 * 1024 });
    if (r.kind !== "ok") return err("unavailable", 503);
    if (r.status !== 200) {
      const code = (r.json as { detail?: { code?: unknown } } | null)?.detail?.code;
      if (r.status === 400 && typeof code === "string" && CONTROL_CODES.has(code)) return err(code, 400);
      const m = API_ERRORS[r.status]; return m ? err(m[1], m[0]) : err("unavailable", 502);
    }
    return json(r.json ?? {});
  };
  const u = new URL(req.url);
  const q = (k: string) => u.searchParams.get(k);

  if (req.method === "GET" && route === "automations") return relay("/internal/v1/basht/automations", "GET");
  const job = /^automations\/([^/]+)\/(runs|run|enabled)$/.exec(route);
  if (job) {
    if (!JOB.test(job[1])) return err("not_found", 404);
    if (req.method === "GET" && job[2] === "runs") return relay(`/internal/v1/basht/automations/${job[1]}/runs`, "GET");
    if (req.method === "POST" && job[2] === "run") return relay(`/internal/v1/basht/automations/${job[1]}/run`, "POST", {}, SLOW_MS);
    if (req.method === "POST" && job[2] === "enabled") {
      const enabled = (await readBody(req))?.enabled;
      if (typeof enabled !== "boolean") return err("bad_request", 400);
      return relay(`/internal/v1/basht/automations/${job[1]}/enabled`, "POST", { enabled }, SLOW_MS);
    }
    return err("not_found", 404);
  }
  if (req.method !== "GET") return null;
  if (route === "usage") return relay("/internal/v1/basht/usage", "GET");
  if (route === "capabilities") return relay("/internal/v1/basht/capabilities", "GET", undefined, SLOW_MS);
  if (route === "memory/status") return relay("/internal/v1/basht/memory/status", "GET");
  if (route === "memory/search") {
    const text = (q("q") ?? "").trim(), page = part(q("page"));
    if (!text || text.length > 200 || page === null || page > 2) return err("bad_request", 400);
    return relay("/internal/v1/basht/memory/search", "POST", { q: text, page });
  }
  if (route === "memory/item") {
    const ref = q("ref") ?? "", p = part(q("part"));
    if (!REF.test(ref) || p === null) return err("bad_request", 400);
    return relay("/internal/v1/basht/memory/item", "POST", { ref, part: p });
  }
  if (route === "memory/file") {
    const name = q("name") ?? "", p = part(q("part"));
    if (!FILES.has(name) || p === null) return err("bad_request", 400);
    return relay("/internal/v1/basht/memory/file", "POST", { name, part: p });
  }
  return null;
}
