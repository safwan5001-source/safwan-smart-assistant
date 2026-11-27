import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/server/notify/memory-store";
import { alertFor, apiFeed, CURSOR, OFFLINE_AFTER_MS, pollBashtEvents, STALE_MS, type Feed, type FeedEvent, type FeedResult } from "@/server/notify/basht-events";
import { applyPrivacy, bashtPayload, deliveryOf } from "@/server/notify/push";
import { dispatchTick } from "@/server/notify/dispatch";
import { pollBasht } from "@/server/notify/runtime";
import { handleNotify } from "@/server/notify/api";
import { parseServerPrefs } from "@/lib/notify-prefs";
import { fakeSender, makeRuntime, makeSubscription, registerDevice, req, riyadh } from "./notify-helpers";

const NOW = riyadh(2026, 11, 27, 12, 0);
const AID = "2f075550-246c-4742-97d7-5268e18d63d2";
const approval = (id: number, aid = AID, over: Partial<NonNullable<FeedEvent["approval"]>> = {}): FeedEvent =>
  ({ id, type: "approval.requested", at: NOW, approval: { id: aid, kind: "exec", summary: "echo hello && rm -rf /tmp/x", expires_at: NOW + 30 * 60_000, is_app: true, ...over } });

/** A scripted feed: each call returns the next answer (the last one repeats); records the cursor it was asked for. */
function feedOf(...answers: FeedResult[]) {
  const asked: number[] = [];
  let i = 0;
  const feed: Feed = async (after) => { asked.push(after); return answers[Math.min(i++, answers.length - 1)]; };
  return { feed, asked };
}
const ok = (events: FeedEvent[], latest = events.at(-1)?.id ?? 0, linkUp = true): FeedResult => ({ kind: "ok", available: true, events, epoch: "e1", latest, linkUp });

async function setup(linked = true, prefs: unknown = {}) {
  const store = createMemoryStore();
  const id = crypto.randomUUID();
  await store.createDevice({ id, tokenHash: "ab".repeat(32), prefs: parseServerPrefs(prefs), now: NOW });
  await store.setSubscription(id, makeSubscription().sub, NOW);
  if (linked) await store.setBashtAlerts(id, true);
  const other = crypto.randomUUID(); // a device nobody linked (e.g. registered by a stranger): never gets BASHT pushes
  await store.createDevice({ id: other, tokenHash: "cd".repeat(32), prefs: parseServerPrefs({}), now: NOW });
  await store.setSubscription(other, makeSubscription().sub, NOW);
  return { store, id, other };
}
const payloads = async (store: ReturnType<typeof createMemoryStore>, id: string) =>
  (await store.listDeliveries(id, 50)).map((d) => ({ key: d.key, kind: d.kind, priority: d.priority, status: d.status, p: JSON.parse(d.payload) }));

describe("B4: which BASHT records become a push", () => {
  it("approval needed (high, deep link), reply only when the app was not watching, failed automations; never stale backlog", () => {
    const a = alertFor(approval(1), NOW)!;
    expect(a).toMatchObject({ alert: "approval", key: `basht:approval:${AID}`, url: `/notifications?tab=approvals&focus=${AID}` });
    expect(alertFor(approval(1, AID, { expires_at: NOW - 1 }), NOW)).toBeNull();
    expect(alertFor({ id: 2, type: "chat.final", at: NOW, seen: false }, NOW)).toMatchObject({ alert: "reply", url: "/chat" });
    expect(alertFor({ id: 2, type: "chat.error", at: NOW, seen: false }, NOW)?.alert).toBe("reply");
    expect(alertFor({ id: 2, type: "chat.final", at: NOW, seen: true }, NOW)).toBeNull();
    expect(alertFor({ id: 3, type: "cron.failed", at: NOW, name: "تقرير الصباح" }, NOW)).toMatchObject({ alert: "cron_failed", detail: "تقرير الصباح" });
    expect(alertFor({ id: 3, type: "cron.finished", at: NOW }, NOW)).toBeNull();
    expect(alertFor({ id: 4, type: "chat.final", at: NOW - STALE_MS - 1, seen: false }, NOW)).toBeNull();
    expect(alertFor({ id: 5, type: "gateway.down", at: NOW }, NOW)).toBeNull();
  });
  it("Arabic, concise, generic on the lock screen by default; a short preview only with the owner's opt-in (and redacted again at send time)", () => {
    const generic = bashtPayload("approval", "k", { url: "/notifications", detail: "echo hello && rm -rf /tmp/x" }, parseServerPrefs({}));
    expect(generic).toMatchObject({ kind: "basht", alert: "approval", title: "باشت ينتظر موافقتك", body: "طلب تنفيذ ينتظر موافقتك أو رفضك.", priority: "high", generic: true });
    expect(JSON.stringify(generic)).not.toContain("rm -rf");
    const rich = bashtPayload("approval", "k", { url: "/x", detail: "echo hello ".repeat(20) }, parseServerPrefs({ lockScreenContent: true }));
    expect(rich.generic).toBe(false);
    expect(rich.body.length).toBeLessThanOrEqual(62);
    expect(JSON.parse(applyPrivacy(JSON.stringify(rich), parseServerPrefs({}))).body).toBe(generic.body);
    expect(bashtPayload("reply", "k", { url: "/chat" }, parseServerPrefs({ lockScreenContent: true })).body).toBe("رد باشت جاهز.");
    expect(bashtPayload("cron_failed", "k", { url: "/tasks", detail: "تقرير" }, parseServerPrefs({ lockScreenContent: true })).body).toBe("تعذّر تنفيذ مهمة مجدولة: تقرير");
    expect(bashtPayload("offline", "k", { url: "/chat" }, parseServerPrefs({})).tag).toBe("basht-link");
  });
});

describe("B4: polling the feed into deliveries", () => {
  it("first poll starts from now (no backlog burst) but still announces approvals waiting right now", async () => {
    const { store, id, other } = await setup();
    const { feed, asked } = feedOf(ok([{ id: 100, type: "chat.final", at: NOW, seen: false }, approval(101), { id: 102, type: "cron.failed", at: NOW, name: "x" }], 102));
    const r = await pollBashtEvents(store, feed, NOW);
    expect(asked).toEqual([0]);
    expect(r).toMatchObject({ polled: true, events: 3, queued: 1 });
    expect((await payloads(store, id)).map((d) => d.key)).toEqual([`basht:approval:${AID}`]);
    expect(await store.listDeliveries(other, 10)).toEqual([]);
    expect(JSON.parse((await store.getCursor(CURSOR))!).after).toBe(102);
  });

  it("dedups by event id and approval id across polls and restarts; only linked devices; approvals expire with the request", async () => {
    const { store, id } = await setup();
    await store.setCursor(CURSOR, JSON.stringify({ after: 10, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const evs = [approval(11), { id: 12, type: "chat.final", at: NOW, seen: false }, { id: 13, type: "chat.final", at: NOW, seen: true }, { id: 14, type: "cron.failed", at: NOW, name: "n" }] as FeedEvent[];
    const { feed, asked } = feedOf(ok(evs, 14), ok([approval(15)], 15), ok([], 15));
    expect((await pollBashtEvents(store, feed, NOW)).queued).toBe(3);
    // the same approval announced again (e.g. after the engine's link reconnected) is not a second push
    expect((await pollBashtEvents(store, feed, NOW + 20_000)).queued).toBe(0);
    await pollBashtEvents(store, feed, NOW + 40_000);
    expect(asked).toEqual([10, 14, 15]);
    const d = await payloads(store, id);
    expect(d.map((x) => [x.key, x.priority])).toEqual(expect.arrayContaining([[`basht:approval:${AID}`, "high"], ["basht:reply:12", "normal"], ["basht:cron:14", "normal"]]));
    expect(d).toHaveLength(3);
    const ap = (await store.listDeliveries(id, 10)).find((x) => x.key === `basht:approval:${AID}`)!;
    expect(ap.expiresAt).toBe(NOW + 30 * 60_000);
    expect(d.find((x) => x.key === `basht:approval:${AID}`)!.p.url).toBe(`/notifications?tab=approvals&focus=${AID}`);
  });

  it("an approval answered elsewhere before its push went out is withdrawn", async () => {
    const { store, id } = await setup();
    await store.setCursor(CURSOR, JSON.stringify({ after: 0, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const { feed } = feedOf(ok([approval(1)]), ok([{ id: 2, type: "approval.resolved", at: NOW, approval_id: AID }]));
    await pollBashtEvents(store, feed, NOW);
    const r = await pollBashtEvents(store, feed, NOW + 1000);
    expect(r.cancelled).toBe(1);
    expect((await store.listDeliveries(id, 5))[0].status).toBe("cancelled");
  });

  it("offline for more than 2 minutes: one push; back online: one push; a short blip: nothing", async () => {
    const { store, id } = await setup();
    await store.setCursor(CURSOR, JSON.stringify({ after: 5, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const off: FeedResult = { kind: "offline" };
    // blip: 60 s offline then back → no push at all
    let f = feedOf(off, ok([], 5));
    await pollBashtEvents(store, f.feed, NOW);
    await pollBashtEvents(store, f.feed, NOW + 60_000);
    expect(await store.listDeliveries(id, 10)).toEqual([]);
    // the engine's gateway down (wrapper up, link down) counts the same as unreachable
    f = feedOf(ok([], 5, false), off, off, ok([], 5));
    await pollBashtEvents(store, f.feed, NOW + 100_000);
    await pollBashtEvents(store, f.feed, NOW + 100_000 + OFFLINE_AFTER_MS);
    await pollBashtEvents(store, f.feed, NOW + 100_000 + OFFLINE_AFTER_MS + 20_000);
    expect((await payloads(store, id)).map((d) => d.p.alert)).toEqual(["offline"]);
    await pollBashtEvents(store, f.feed, NOW + 300_000);
    const all = await payloads(store, id);
    expect(all.map((d) => d.p.alert).sort()).toEqual(["offline", "online"]);
    expect(all.find((d) => d.p.alert === "online")!.p.body).toBe("عاد باشت متصلًا.");
  });

  it("an API that is not set up (or an engine without the live link) is never reported as BASHT offline", async () => {
    const { store, id } = await setup();
    const { feed } = feedOf({ kind: "unconfigured" });
    for (let t = 0; t < 10; t++) expect((await pollBashtEvents(store, feed, NOW + t * OFFLINE_AFTER_MS)).skipped).toBe("unconfigured");
    expect(await store.listDeliveries(id, 10)).toEqual([]);
    expect(await store.getCursor(CURSOR)).toBeNull();
  });

  it("apiFeed maps the API answers", async () => {
    const call = (r: { kind: string; status?: number; json?: unknown }) => apiFeed(async () => r)(0);
    expect(await call({ kind: "unconfigured" })).toEqual({ kind: "unconfigured" });
    expect(await call({ kind: "rejected", status: 401 })).toEqual({ kind: "unconfigured" });
    expect(await call({ kind: "unreachable" })).toEqual({ kind: "offline" });
    expect(await call({ kind: "unavailable", status: 503 })).toEqual({ kind: "offline" });
    expect(await call({ kind: "ok", status: 502, json: { detail: { code: "basht_unavailable" } } })).toEqual({ kind: "offline" });
    expect(await call({ kind: "ok", status: 200, json: { available: false, events: [] } })).toEqual({ kind: "unconfigured" });
    expect(await call({ kind: "ok", status: 200, json: { available: true, epoch: "e1", latest: 3, link: { state: "up" }, events: [{ id: 3, type: "chat.final" }, { id: "x" }, null] } }))
      .toEqual({ kind: "ok", available: true, epoch: "e1", latest: 3, linkUp: true, events: [{ id: 3, type: "chat.final" }], nextAfter: null, more: false });
    expect(await call({ kind: "ok", status: 200, json: { available: true, epoch: "e1", latest: 9, next_after: 4, more: true, link: { state: "up" }, events: [] } }))
      .toMatchObject({ nextAfter: 4, more: true });
    let asked: unknown = null;
    await apiFeed(async (o) => { asked = o; return { kind: "unconfigured" }; })(42);
    // Codex (PR #62): a full feed page can exceed callBackend's 64 KiB default — read it with the 512 KiB ceiling
    expect(asked).toEqual({ path: "/internal/v1/basht/events", method: "POST", body: { after: 42 }, timeoutMs: 15_000, maxBytes: 512 * 1024 });
  });

  it("goes out through the existing dispatcher: TTL, urgency, quiet hours, and nothing when push is not configured", async () => {
    const { store, id } = await setup(true, { quiet: { enabled: true, start: "23:00", end: "07:00", allowCritical: false } });
    const { sent, send } = fakeSender();
    await store.setCursor(CURSOR, JSON.stringify({ after: 0, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const rt = makeRuntime({ store, send, now: () => NOW });
    rt.bashtFeed = feedOf(ok([approval(1), { id: 2, type: "chat.final", at: NOW, seen: false }])).feed;
    expect((await pollBasht(rt))!.queued).toBe(2);
    await dispatchTick(store, send, NOW);
    expect(sent).toHaveLength(2);
    const ap = sent.find((s) => JSON.parse(s.payload).alert === "approval")!;
    expect(ap.opts).toMatchObject({ ttl: 1800, urgency: "high" });
    expect(sent.find((s) => JSON.parse(s.payload).alert === "reply")!.opts.ttl).toBe(3600);
    // inside quiet hours (01:00 Riyadh) a BASHT push waits like a reminder
    const night = riyadh(2026, 11, 28, 1, 0);
    rt.bashtFeed = feedOf(ok([{ id: 3, type: "cron.failed", at: night, name: "x" }])).feed;
    rt.now = () => night;
    await pollBasht(rt);
    const r = await dispatchTick(store, send, night);
    expect(r.held).toBe(1);
    expect(sent).toHaveLength(2);
    expect((await store.listDeliveries(id, 10)).find((d) => d.key === "basht:cron:3")!.status).toBe("pending");
    // push not configured: the poll does not run at all
    const off = makeRuntime({ store, send, env: { VAPID_PUBLIC_KEY: "" } });
    off.bashtFeed = feedOf(ok([approval(9)])).feed;
    expect(await pollBasht(off)).toBeNull();
  });

  it("Codex #1: a BASHT push never outlives its subject: TTL capped by the time left, nothing sent when it is (almost) over", async () => {
    const { store, id } = await setup();
    const { sent, send } = fakeSender();
    await store.setCursor(CURSOR, JSON.stringify({ after: 0, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const soon = "aaaaaaaa-0000-4000-8000-000000000001", gone = "aaaaaaaa-0000-4000-8000-000000000002";
    await pollBashtEvents(store, feedOf(ok([approval(1, soon, { expires_at: NOW + 5 * 60_000 }), approval(2, gone, { expires_at: NOW + 8_000 })])).feed, NOW);
    await dispatchTick(store, send, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].opts.ttl).toBe(300); // not the fixed 1800 s
    expect(JSON.parse(sent[0].payload).url).toContain(soon);
    expect((await store.listDeliveries(id, 10)).find((d) => d.key === `basht:approval:${gone}`)!.status).toBe("expired");
  });

  it("Codex #2: unlinking withdraws queued BASHT pushes, and an unlinked device is never sent one", async () => {
    const { store, id } = await setup(true, { quiet: { enabled: true, start: "23:00", end: "07:00", allowCritical: false } });
    const { sent, send } = fakeSender();
    const night = riyadh(2026, 11, 28, 1, 0);
    await store.setCursor(CURSOR, JSON.stringify({ after: 0, epoch: "e1", offlineSince: null, offlineNotified: false }), night);
    await pollBashtEvents(store, feedOf(ok([{ id: 1, type: "cron.failed", at: night, name: "x" }])).feed, night);
    expect((await dispatchTick(store, send, night)).held).toBe(1); // held by quiet hours
    await store.setBashtAlerts(id, false);
    expect((await store.listDeliveries(id, 10))[0].status).toBe("cancelled");
    await dispatchTick(store, send, riyadh(2026, 11, 28, 8, 0));
    expect(sent).toHaveLength(0);
    // enforced at send time too: a basht delivery for a device that is not linked is withdrawn, not sent
    const { store: s2, other } = await setup();
    await s2.addDelivery(other, deliveryOf(bashtPayload("reply", "basht:reply:9", { url: "/chat" }, parseServerPrefs({})), NOW));
    await dispatchTick(s2, send, NOW);
    expect(sent).toHaveLength(0);
    expect((await s2.listDeliveries(other, 5))[0]).toMatchObject({ status: "cancelled", lastError: "unlinked" });
  });

  it("Codex #3: an approval answered within the same page is never pushed (first poll and later polls)", async () => {
    const page = (base: number) => ok([approval(base), { id: base + 1, type: "approval.resolved", at: NOW, approval_id: AID }]);
    const first = await setup();
    expect((await pollBashtEvents(first.store, feedOf(page(1)).feed, NOW)).queued).toBe(0);
    expect(await first.store.listDeliveries(first.id, 5)).toEqual([]);
    expect(JSON.parse((await first.store.getCursor(CURSOR))!).after).toBe(2);
    const later = await setup();
    await later.store.setCursor(CURSOR, JSON.stringify({ after: 10, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    expect((await pollBashtEvents(later.store, feedOf(page(11)).feed, NOW)).queued).toBe(0);
    expect(await later.store.listDeliveries(later.id, 5)).toEqual([]);
  });

  it("Codex #4: a backlog longer than one page is read page by page; resolutions on later pages win; nothing is skipped", async () => {
    const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "aaaaaaaa-0000-4000-8000-00000000000b";
    /** a feed answering by cursor, like the API: up to `size` records after `after`, with next_after and more */
    const paged = (all: FeedEvent[], size: number) => {
      const asked: number[] = [];
      const feed: Feed = async (after) => {
        asked.push(after);
        const page = all.filter((e) => e.id > after).slice(0, size);
        const latest = all.at(-1)?.id ?? 0;
        const next = page.at(-1)?.id ?? after;
        return { kind: "ok", available: true, events: page, epoch: "e1", latest, linkUp: true, nextAfter: next, more: next < latest };
      };
      return { feed, asked };
    };
    // first poll ever: A waits on page 1 but is answered on page 2; B is still waiting on page 2
    const first = await setup();
    const backlog: FeedEvent[] = [approval(1, A), { id: 2, type: "chat.final", at: NOW, seen: false }, approval(3, B),
      { id: 4, type: "approval.resolved", at: NOW, approval_id: A }, { id: 5, type: "cron.failed", at: NOW, name: "x" }];
    const f1 = paged(backlog, 2);
    await pollBashtEvents(first.store, f1.feed, NOW);
    expect(f1.asked).toEqual([0, 2, 4]);
    expect((await payloads(first.store, first.id)).map((d) => d.key)).toEqual([`basht:approval:${B}`]);
    expect(JSON.parse((await first.store.getCursor(CURSOR))!).after).toBe(5);
    // a later poll that is truncated: the request on page 1 is answered on page 2 → not pushed; the rest is
    const later = await setup();
    await later.store.setCursor(CURSOR, JSON.stringify({ after: 10, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    const f2 = paged([{ id: 9, type: "cron.failed", at: NOW }, approval(11, A), { id: 12, type: "approval.resolved", at: NOW, approval_id: A },
      { id: 13, type: "cron.failed", at: NOW, name: "y" }], 1);
    await pollBashtEvents(later.store, f2.feed, NOW);
    expect(f2.asked).toEqual([10, 11, 12]);
    expect((await payloads(later.store, later.id)).map((d) => d.key)).toEqual(["basht:cron:13"]);
    expect(JSON.parse((await later.store.getCursor(CURSOR))!).after).toBe(13);
    // a page that does not advance (e.g. every record dropped as malformed) ends the loop instead of spinning
    const stuck: Feed = async (after) => ({ kind: "ok", available: true, events: [], epoch: "e1", latest: 99, linkUp: true, nextAfter: after, more: true });
    const s3 = await setup();
    await s3.store.setCursor(CURSOR, JSON.stringify({ after: 10, epoch: "e1", offlineSince: null, offlineNotified: false }), NOW);
    expect((await pollBashtEvents(s3.store, stuck, NOW)).polled).toBe(true);
  });

  it("unsubscribing a device unlinks it; the dispatch endpoint polls too", async () => {
    const store = createMemoryStore();
    const { send } = fakeSender();
    const rt = makeRuntime({ store, send, now: () => NOW });
    const dev = await registerDevice(rt, makeSubscription().sub);
    await store.setBashtAlerts(dev.deviceId, true);
    expect((await store.bashtDevices(10)).map((d) => d.id)).toEqual([dev.deviceId]);
    await handleNotify(req("DELETE", undefined, dev.auth), ["devices", "me", "subscription"], rt);
    expect(await store.bashtDevices(10)).toEqual([]);
    await store.setBashtAlerts(dev.deviceId, true); // cannot link without a subscription
    expect(await store.bashtDevices(10)).toEqual([]);
    rt.bashtFeed = feedOf(ok([], 0)).feed;
    const res = await handleNotify(req("POST", undefined, { Authorization: `Bearer ${"s".repeat(32)}` }), ["dispatch"], rt);
    expect(((await res.json()) as { basht?: { polled: boolean } }).basht?.polled).toBe(true);
  });
});
