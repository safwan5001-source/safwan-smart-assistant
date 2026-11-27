import "server-only";
/**
 * B4 — BASHT → push. Runs inside the existing notify dispatch loop (same tick, same advisory lock, same deliveries table, same
 * quiet hours / privacy / retries / 404-410 cleanup). No second push system and no engine web push.
 *
 *   tick ─► API /internal/v1/basht/events {after} ─► engine bridge ring (src/gateway-link.js)
 *        ─► one delivery per linked device (kind "basht", key per event/approval: idempotent) ─► dispatchTick sends it
 *
 * What becomes a push (Arabic, concise, generic on the lock screen unless the owner opted in):
 *   approval needed (high, deep link to it) · BASHT replied while the app was not watching (/chat) · an automation failed ·
 *   BASHT offline for more than 2 minutes, then back online.
 * Only devices the OWNER linked (/api/basht/push, owner session) receive these. Nothing happens without VAPID keys + a store
 * (the loop does not start) or without a configured API (the feed is "unconfigured": no request, no offline alert).
 * The cursor (last event id, ring epoch, offline state) is kept in notify.cursors, so a restart neither repeats nor floods.
 */
import type { NotifyStore } from "./types";
import { bashtPayload, deliveryOf, type BashtAlert } from "./push";

export const CURSOR = "basht-events";
export const OFFLINE_AFTER_MS = 2 * 60_000;
/** Older records are not pushed (after downtime the backlog is shown in the app, not as a burst of notifications). */
export const STALE_MS = 15 * 60_000;
const DEVICES = 50;
/** One poll reads at most this many pages (the engine ring holds 500 records; a page is up to 100–200). */
export const MAX_PAGES = 10;
const pageEnd = (r: Extract<FeedResult, { kind: "ok" }>, after: number) =>
  r.nextAfter ?? r.events.reduce((m, e) => Math.max(m, e.id), after);

export type FeedEvent = {
  id: number; type: string; at: number | null;
  approval?: { id: string; kind: string | null; summary: string | null; expires_at: number | null; is_app?: boolean };
  approval_id?: string; seen?: boolean; name?: string | null; status?: string | null;
};
export type FeedResult =
  | { kind: "ok"; available: boolean; events: FeedEvent[]; epoch: string | null; latest: number | null; linkUp: boolean;
      /** the cursor for the next page (covers records the API dropped as malformed) and whether more records follow */
      nextAfter?: number | null; more?: boolean }
  | { kind: "offline" }
  | { kind: "unconfigured" };
export type Feed = (after: number) => Promise<FeedResult>;

type Cursor = { after: number; epoch: string | null; offlineSince: number | null; offlineNotified: boolean };
const parseCursor = (raw: string | null): Cursor | null => {
  try {
    const c = raw ? JSON.parse(raw) : null;
    if (!c || typeof c !== "object" || !Number.isSafeInteger(c.after) || c.after < 0) return null;
    return { after: c.after, epoch: typeof c.epoch === "string" ? c.epoch : null, offlineSince: Number.isSafeInteger(c.offlineSince) ? c.offlineSince : null,
      offlineNotified: c.offlineNotified === true };
  } catch { return null; }
};

export type BashtReport = { polled: boolean; events: number; queued: number; cancelled: number; offline: boolean; skipped?: string };

type Alert = { alert: BashtAlert; key: string; url: string; detail?: string | null; expiresAt?: number };
const approvalUrl = (id: string) => `/notifications?tab=approvals&focus=${encodeURIComponent(id)}`;

/** One feed record → the push it deserves (or none). Pure. */
export function alertFor(e: FeedEvent, now: number): Alert | null {
  if (e.type === "approval.requested" && e.approval?.id) {
    const exp = e.approval.expires_at;
    if (exp !== null && exp !== undefined && exp <= now) return null;
    return { alert: "approval", key: `basht:approval:${e.approval.id}`, url: approvalUrl(e.approval.id), detail: e.approval.summary,
      expiresAt: exp ?? now + 30 * 60_000 };
  }
  if (e.at !== null && now - e.at > STALE_MS) return null;
  if ((e.type === "chat.final" || e.type === "chat.error") && e.seen === false) return { alert: "reply", key: `basht:reply:${e.id}`, url: "/chat" };
  if (e.type === "cron.failed") return { alert: "cron_failed", key: `basht:cron:${e.id}`, url: "/tasks", detail: e.name };
  return null;
}

/** One poll of the BASHT feed: turns new records into deliveries for the owner's linked devices. Call under the dispatcher lock. */
export async function pollBashtEvents(store: NotifyStore, feed: Feed, now: number): Promise<BashtReport> {
  const rep: BashtReport = { polled: false, events: 0, queued: 0, cancelled: 0, offline: false };
  const saved = parseCursor(await store.getCursor(CURSOR));
  const cur: Cursor = saved ?? { after: 0, epoch: null, offlineSince: null, offlineNotified: false };
  const r = await feed(cur.after);
  if (r.kind === "unconfigured") return { ...rep, skipped: "unconfigured" };
  rep.polled = true;
  const devices = await store.bashtDevices(DEVICES);
  const queue = async (a: Alert) => {
    for (const d of devices) {
      const p = bashtPayload(a.alert, a.key, { url: a.url, detail: a.detail }, d.prefs);
      const del = deliveryOf(p, now);
      if (await store.addDelivery(d.id, a.expiresAt ? { ...del, expiresAt: Math.min(del.expiresAt, a.expiresAt) } : del)) rep.queued++;
    }
  };

  const offline = r.kind === "offline" || !r.linkUp;
  if (offline) {
    rep.offline = true;
    cur.offlineSince ??= now;
    if (!cur.offlineNotified && now - cur.offlineSince >= OFFLINE_AFTER_MS) {
      await queue({ alert: "offline", key: `basht:offline:${cur.offlineSince}`, url: "/chat" });
      cur.offlineNotified = true;
    }
  } else if (cur.offlineSince !== null) {
    if (cur.offlineNotified) await queue({ alert: "online", key: `basht:online:${cur.offlineSince}`, url: "/chat" });
    cur.offlineSince = null; cur.offlineNotified = false;
  }

  if (r.kind === "ok") {
    // read the whole backlog first (the first poll included): a request on page 1 answered on page 3 must not be pushed, and the
    // cursor must never jump past records nobody looked at
    const collected = [...r.events];
    let reached = pageEnd(r, cur.after);
    let complete = r.more !== true;
    for (let page = 1; !complete && page < MAX_PAGES; page++) {
      const n = await feed(reached);
      if (n.kind !== "ok") break; // keep what was read; the next tick continues from `reached`
      collected.push(...n.events);
      const next = pageEnd(n, reached);
      complete = n.more !== true || next <= reached;
      reached = Math.max(reached, next);
    }
    const events = collected.filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i).sort((a, b) => a.id - b.id);
    rep.events = events.length;
    // an approval answered within this same page (requested … resolved) is never pushed: reconcile before queuing
    const answered = new Set(events.filter((e) => e.type === "approval.resolved" && e.approval_id).map((e) => e.approval_id!));
    for (const e of events) {
      if (saved && e.id <= cur.after) continue;
      if (e.type === "approval.resolved" && e.approval_id) {
        // answered elsewhere (or expired) before the push went out (e.g. held by quiet hours): withdraw it
        for (const d of devices) {
          if (await store.isDeliveryPending(d.id, `basht:approval:${e.approval_id}`)) {
            await store.markDelivery(d.id, `basht:approval:${e.approval_id}`, { status: "cancelled", attempts: 0, lastError: "answered" });
            rep.cancelled++;
          }
        }
        continue;
      }
      if (e.type === "approval.requested" && e.approval?.id && answered.has(e.approval.id)) continue;
      // first poll ever: start from "now" (the backlog is in the app); still announce approvals that are waiting right now
      if (!saved && e.type !== "approval.requested") continue;
      const a = alertFor(e, now);
      if (a) await queue(a);
    }
    // a fully read first poll starts at the ring's latest record (an older API may not say how far a page reached)
    if (!saved && complete && r.latest !== null) reached = Math.max(reached, r.latest);
    // a new ring whose ids are all below our cursor (should not happen: ids are seeded with the engine's boot time) restarts at 0
    cur.after = saved && r.latest !== null && r.epoch !== cur.epoch && r.latest < cur.after ? 0 : Math.max(reached, saved ? cur.after : 0);
    cur.epoch = r.epoch;
  }
  await store.setCursor(CURSOR, JSON.stringify(cur), now);
  return rep;
}

type Backend = (o: { path: string; method: "POST"; body: unknown; timeoutMs: number }) => Promise<{ kind: string; status?: number; json?: unknown }>;
/** The feed through the API (HMAC), as the notify loop uses it. "unconfigured" never counts as offline. */
export function apiFeed(callBackend: Backend): Feed {
  return async (after) => {
    const r = await callBackend({ path: "/internal/v1/basht/events", method: "POST", body: { after }, timeoutMs: 15_000 });
    // no API / a signature the API refuses: a set-up problem, never reported to the owner as "BASHT is offline"
    if (r.kind === "unconfigured" || r.kind === "rejected") return { kind: "unconfigured" };
    if (r.kind !== "ok" || r.status !== 200) return { kind: "offline" }; // API or engine unreachable / 5xx / engine 502
    const j = (r.json ?? {}) as { available?: unknown; events?: unknown; epoch?: unknown; latest?: unknown; next_after?: unknown; more?: unknown; link?: { state?: unknown } };
    if (j.available !== true) return { kind: "unconfigured" }; // an engine without the live link: nothing to push, not an outage
    const events = (Array.isArray(j.events) ? j.events : []).filter((e): e is FeedEvent =>
      !!e && typeof e === "object" && Number.isSafeInteger((e as FeedEvent).id) && typeof (e as FeedEvent).type === "string");
    return { kind: "ok", available: true, events, epoch: typeof j.epoch === "string" ? j.epoch : null,
      latest: Number.isSafeInteger(j.latest) ? (j.latest as number) : null, linkUp: j.link?.state === "up",
      nextAfter: Number.isSafeInteger(j.next_after) ? (j.next_after as number) : null, more: j.more === true };
  };
}
