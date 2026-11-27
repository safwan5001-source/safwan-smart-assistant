import "server-only";
/**
 * /api/basht/approvals* and /api/basht/push — B3 approvals and the B4 push link, behind the SAME owner door as the rest of /api/basht
 * (owner session / BASHT cookie, same-origin writes, the door's read/write limiters). Called by server/basht-chat.ts after those
 * checks passed; it never runs on its own.
 *
 *   GET  approvals           -> pending approvals (fixed fields) + whether the engine's live link is up (honest "unavailable" state)
 *   GET  approvals/history   -> the last 20 decided approvals
 *   POST approvals/decide    -> { id, decision: "allow-once" | "deny" } — nothing else; the owner pressed a button, never the app
 *   GET  push / POST push    -> is this push device linked to BASHT alerts / link or unlink it. The device proves itself with its
 *                               notify bearer token; the owner proves themself with the session. Only then may it receive BASHT pushes.
 */
import { authenticate } from "./notify/auth";
import { getRuntime, isReady, type Runtime } from "./notify/runtime";

type Relay = (apiPath: string, method: "GET" | "POST", body?: unknown, pick?: (j: Record<string, unknown>) => unknown, timeoutMs?: number) => Promise<Response>;
type Ctx = { relay: Relay; readJson: (req: Request) => Promise<Record<string, unknown> | undefined>; runtime?: () => Runtime };

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const err = (code: string, status: number) => json({ error: code }, status);

export const DECISIONS = ["allow-once", "deny"] as const;
export const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KINDS = new Set(["exec", "plugin", "system-agent"]);
const SESSIONS = new Set(["app", "main", "whatsapp", "cron", "other", "unknown"]);
/** The decide refusals the browser may see (a fixed list). */
const DECIDE_CODES = new Set(["bad_id", "bad_decision", "not_found", "rejected", "link_down"]);

const s = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export type PendingApproval = {
  id: string; kind: string; summary: string | null; title: string | null; session: string; isApp: boolean; warning: string | null;
  createdAt: number | null; expiresAt: number | null; decisions: string[];
};
export function pendingView(a: unknown): PendingApproval | null {
  const r = a as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || !APPROVAL_ID.test(r.id) || !KINDS.has(String(r.kind))) return null;
  return { id: r.id, kind: String(r.kind), summary: s(r.summary, 300), title: s(r.title, 120), session: SESSIONS.has(String(r.session)) ? String(r.session) : "unknown",
    isApp: r.is_app === true, warning: s(r.warning, 200), createdAt: n(r.created_at), expiresAt: n(r.expires_at),
    decisions: (Array.isArray(r.decisions) ? r.decisions : []).filter((d): d is string => (DECISIONS as readonly string[]).includes(d as string)) };
}
export function decidedView(a: unknown) {
  const r = a as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || !APPROVAL_ID.test(r.id)) return null;
  return { id: r.id, kind: KINDS.has(String(r.kind)) ? String(r.kind) : null, summary: s(r.summary, 300), status: s(r.status, 20),
    decision: ["allow-once", "allow-always", "deny"].includes(String(r.decision)) ? String(r.decision) : null, reason: s(r.reason, 40),
    session: SESSIONS.has(String(r.session)) ? String(r.session) : "unknown", by: ["app", "system", "other"].includes(String(r.by)) ? String(r.by) : null,
    createdAt: n(r.created_at), resolvedAt: n(r.resolved_at) };
}

/** Returns a Response for the routes it owns, or null to let the door answer 404. */
export async function handleBashtLive(req: Request, route: string, ctx: Ctx): Promise<Response | null> {
  if (req.method === "GET" && route === "approvals") {
    return ctx.relay("/internal/v1/basht/approvals", "GET", undefined, (j) => ({
      available: j.available === true,
      link: (j.link as { state?: unknown } | undefined)?.state === "up" ? "up" : "down",
      approvals: (Array.isArray(j.approvals) ? j.approvals : []).map(pendingView).filter(Boolean),
    }));
  }
  if (req.method === "GET" && route === "approvals/history") {
    return ctx.relay("/internal/v1/basht/approvals/history", "POST", { limit: 20 }, (j) => ({
      available: j.available === true, items: (Array.isArray(j.items) ? j.items : []).map(decidedView).filter(Boolean),
    }));
  }
  if (req.method === "POST" && route === "approvals/decide") {
    const data = await ctx.readJson(req);
    const id = data?.id, decision = data?.decision;
    if (typeof id !== "string" || !APPROVAL_ID.test(id)) return err("bad_id", 400);
    if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) return err("bad_decision", 400);
    // refusals come back as the API's fixed codes (DECIDE_CODES, mapped by the door's relay), never as upstream text
    return ctx.relay("/internal/v1/basht/approvals/decide", "POST", { id, decision }, (j) => ({ applied: j.applied === true, approval: decidedView(j.approval) }), 20_000);
  }
  if (route === "push" && (req.method === "GET" || req.method === "POST")) {
    const rt = (ctx.runtime ?? getRuntime)();
    if (!isReady(rt)) return err("push_unconfigured", 503);
    const dev = await authenticate(req, rt.store!);
    if (!dev) return err("unauthorized_device", 401);
    if (req.method === "GET") return json({ enabled: dev.bashtAlerts === true && !!dev.subscription, subscribed: !!dev.subscription });
    const data = await ctx.readJson(req);
    if (typeof data?.enabled !== "boolean") return err("bad_request", 400);
    if (data.enabled && !dev.subscription) return err("push_not_enabled", 409);
    await rt.store!.setBashtAlerts(dev.id, data.enabled);
    return json({ enabled: data.enabled });
  }
  return null;
}

export { DECIDE_CODES };
