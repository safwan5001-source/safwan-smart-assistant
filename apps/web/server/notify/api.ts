import "server-only";
/**
 * /api/notify/* — thin, defensive HTTP layer over the store. Fixed error codes (never internal text), no-store caching,
 * same-origin only (bearer header, no cookies ⇒ not CSRF-able), bounded bodies, rate limits, SSRF-safe subscription endpoints.
 */
import { randomUUID } from "node:crypto";
import { parseServerPrefs, type ServerPrefs } from "@/lib/notify-prefs";
import { authenticate, bearerMatches, hashToken, newDeviceId, newToken } from "./auth";
import { dispatchTick } from "./dispatch";
import { deliveryOf, testPayload, topicOf, ttlOf, urgencyOf } from "./push";
import { isReady, pollBasht, type Runtime } from "./runtime";
import { ReminderLimitError } from "./types";
import { parseSubscription, parseSyncBody, readJson, SYNC_MAX_BYTES } from "./validate";
import { clientIp } from "../client-ip";

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const err = (code: string, status: number) => json({ error: code }, status);

/** Tiny fixed-window limiter (per instance). Bounded so it can never grow without limit. */
export function createLimiter(max: number, windowMs: number, cap = 10_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (id: string, now: number): boolean => {
    const h = hits.get(id);
    if (!h || h.reset <= now) {
      if (hits.size >= cap) { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); if (hits.size >= cap) hits.clear(); }
      hits.set(id, { n: 1, reset: now + windowMs }); return true;
    }
    h.n++; return h.n <= max;
  };
}

// limiters are per runtime so tests are isolated
const limiters = new WeakMap<Runtime, { register: ReturnType<typeof createLimiter>; test: ReturnType<typeof createLimiter>; sync: ReturnType<typeof createLimiter> }>();
const limitersFor = (rt: Runtime) => {
  let l = limiters.get(rt);
  if (!l) limiters.set(rt, (l = { register: createLimiter(10, 3600_000), test: createLimiter(5, 60_000), sync: createLimiter(120, 60_000) }));
  return l;
};

export async function handleNotify(req: Request, path: string[], rt: Runtime): Promise<Response> {
  const method = req.method.toUpperCase();
  const route = `${method} /${path.join("/")}`;
  const now = rt.now();
  const lim = limitersFor(rt);
  try {
    if (route === "GET /config") {
      return json({ push: !!rt.cfg.push && !!rt.store, publicKey: rt.cfg.push && rt.store ? rt.cfg.push.publicKey : null, store: rt.storeKind, dispatcher: isReady(rt) });
    }
    if (route === "POST /dispatch") {
      if (!rt.cfg.dispatchSecret) return err("not_configured", 503);
      if (!bearerMatches(req, rt.cfg.dispatchSecret)) return err("unauthorized", 401);
      if (!isReady(rt)) return err("not_configured", 503);
      const basht = await pollBasht(rt);
      // a fresh clock after the poll (as the in-process loop does): deliveries it just queued are due now, not next minute
      return json({ ...(await dispatchTick(rt.store!, rt.send!, rt.now())), ...(basht?.polled ? { basht } : {}) });
    }
    if (!isReady(rt)) return err("not_configured", 503);
    const store = rt.store!;
    const policy = { extraHosts: rt.cfg.extraEndpointHosts, production: rt.cfg.production };

    if (route === "POST /devices") {
      // M4: with unified sign-in on, only the signed-in owner can add a device (same-origin, like every other owner write);
      // later calls keep using the per-device bearer
      const gate = await rt.ownerGate(req);
      if (gate === "unavailable") return err("unavailable", 503);
      if (gate === "unauthorized") return err("unauthorized", 401);
      if (!lim.register(clientIp(req), now)) return err("rate_limited", 429);
      if ((await store.countDevices()) >= rt.cfg.maxDevices) return err("capacity", 503);
      const id = newDeviceId(), token = newToken();
      await store.createDevice({ id, tokenHash: hashToken(token), prefs: parseServerPrefs({}), now });
      return json({ deviceId: id, token }, 201);
    }

    const dev = await authenticate(req, store);
    if (!dev) return err("unauthorized", 401);

    switch (route) {
      case "GET /devices/me": return json({ deviceId: dev.id, subscribed: !!dev.subscription, prefs: dev.prefs, createdAt: dev.createdAt });
      case "DELETE /devices/me": await store.deleteDevice(dev.id); return json({ erased: true });
      case "PUT /devices/me/subscription": {
        const body = (await readJson(req, 8 * 1024)) as { subscription?: unknown; prefs?: unknown } | undefined;
        if (!body) return err("bad_request", 400);
        const sub = parseSubscription(body.subscription, policy);
        if (!sub) return err("invalid_subscription", 400);
        if (body.prefs !== undefined) await store.setPrefs(dev.id, parseServerPrefs(body.prefs));
        await store.setSubscription(dev.id, sub, now);
        return json({ subscribed: true });
      }
      case "DELETE /devices/me/subscription": await store.setSubscription(dev.id, null, now); return json({ subscribed: false });
      case "PUT /devices/me/prefs": {
        const body = (await readJson(req, 8 * 1024)) as { prefs?: unknown } | undefined;
        if (!body || typeof body.prefs !== "object" || body.prefs === null) return err("bad_request", 400);
        const prefs: ServerPrefs = parseServerPrefs(body.prefs);
        await store.setPrefs(dev.id, prefs);
        return json({ prefs });
      }
      case "PUT /reminders/sync": {
        if (!dev.subscription) return err("push_not_enabled", 409);
        if (!lim.sync(dev.id, now)) return err("rate_limited", 429);
        const raw = await readJson(req, SYNC_MAX_BYTES);
        const body = parseSyncBody(raw);
        if (!body) return err("bad_request", 400);
        // the client attaches its CURRENT preferences to every sync, so a preference change made while offline (lock-screen privacy,
        // quiet hours) reaches the server on the next reconnect even if the dedicated prefs request had failed
        const rawPrefs = (raw as { prefs?: unknown }).prefs;
        if (rawPrefs && typeof rawPrefs === "object") {
          const p = parseServerPrefs(rawPrefs);
          if (JSON.stringify(p) !== JSON.stringify(dev.prefs)) await store.setPrefs(dev.id, p);
        }
        try { return json({ reminders: await store.syncReminders(dev.id, body.reminders, body.deleted, now), serverTime: now }); }
        catch (e) { if (e instanceof ReminderLimitError) return err("reminder_limit", 413); throw e; }
      }
      case "POST /devices/me/test": {
        if (!dev.subscription) return err("push_not_enabled", 409);
        if (!lim.test(dev.id, now)) return err("rate_limited", 429);
        const p = testPayload(`test:${randomUUID()}`);
        await store.addDelivery(dev.id, deliveryOf(p, now));
        const r = await rt.send!(dev.subscription, JSON.stringify(p), { ttl: ttlOf("test"), urgency: urgencyOf("normal"), topic: topicOf(p.key) });
        const ok = r.status >= 200 && r.status < 300;
        const gone = r.status === 404 || r.status === 410;
        await store.markDelivery(dev.id, p.key, { status: ok ? "sent" : gone ? "gone" : "failed", attempts: 1, ...(ok ? { sentAt: now } : { lastError: r.error ?? `http_${r.status}` }) });
        if (gone) await store.setSubscription(dev.id, null, now);
        return json({ sent: ok, subscriptionExpired: gone }, ok ? 200 : 502);
      }
      default: return err("not_found", 404);
    }
  } catch {
    return err("server_error", 500);
  }
}
