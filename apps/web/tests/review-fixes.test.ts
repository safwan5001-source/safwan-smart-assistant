import { describe, expect, it, vi } from "vitest";
import type { AssistantStatus } from "@/lib/assistant";
import { createBashtClient, type BashtModelState } from "@/lib/basht-client";
import { headerModel } from "@/lib/basht-model";
import { parseEngineStatus, unknownEngineStatus } from "@/lib/engine-status";
import { createEngineStatusStore } from "@/lib/engine-status-store";
import { attachHealthRefresh, recheckAll, startVisibleTick } from "@/lib/status-refresh";
import { readApprovals, readEngine } from "@/lib/status-model";
import { claudeBadge } from "@/features/settings/claude-settings";

const T0 = 1_800_000_000_000;
const online = (basht: "connected" | "starting" | "offline" | "unconfigured"): AssistantStatus => ({ server: "online", assistant: false, version: "1", basht, bashtChat: true });
const up = (over: Record<string, unknown> = {}) => parseEngineStatus({ ok: true, link: { state: "up" }, ...over });
const state = (over: Partial<BashtModelState> = {}): BashtModelState => ({
  model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", source: "override" },
  thinking: { level: null, default: "medium", effective: "medium", levels: ["off", "low", "medium", "high"] },
  fast: { supported: false, enabled: false }, usage: { input_tokens: null, output_tokens: null, context_tokens: null, context_window: null },
  last_reply: null, fallback: null, last_run: null, ...over });

describe("I1: the gateway half and the engine half of «جاهزية باشت» cannot drift apart", () => {
  it("an OLDER «starting» / «offline» gateway reading never degrades a fresher signed read with the link up", () => {
    for (const gw of ["starting", "offline", "unconfigured"] as const) {
      const r = readEngine(online(gw), T0, { status: up(), at: T0 + 600_000 });
      expect(r, gw).toMatchObject({ level: "tested_ok", label: "جاهز", checkedAt: T0 + 600_000 });
    }
  });
  it("a gateway reading that is as new as the engine read still counts (degraded, with a reason) and the stamp is the OLDER of the two", () => {
    const r = readEngine(online("starting"), T0 + 1000, { status: up(), at: T0 });
    expect(r).toMatchObject({ level: "degraded", checkedAt: T0, detail: expect.stringContaining("بوابة") });
    const ok = readEngine(online("connected"), T0 + 5000, { status: up(), at: T0 + 2000 });
    expect(ok).toMatchObject({ level: "tested_ok", checkedAt: T0 + 2000 });
    expect(readEngine(online("connected"), T0, { status: up(), at: T0 + 2000 })).toMatchObject({ level: "tested_ok", checkedAt: T0 + 2000 });
  });
  it("mirror case: a failed engine read with only an OLDER gateway reading says «could not read», it does not blame the app path or claim the engine works", () => {
    const r = readEngine(online("connected"), T0, { status: unknownEngineStatus(), at: T0 + 600_000 });
    expect(r).toMatchObject({ level: "degraded", checkedAt: T0 + 600_000, detail: "تعذّرت قراءة حالة المحرك الآن" });
    const fresh = readEngine(online("connected"), T0 + 600_000, { status: unknownEngineStatus(), at: T0 + 600_000 });
    expect(fresh.detail).toContain("مسار التطبيق");
  });
  it("«الخادم» going offline is a fresh health reading, so the engine row turns unknown (not a stale blame)", () => {
    expect(readEngine({ server: "offline" }, T0 + 700_000, { status: unknownEngineStatus(), at: T0 + 600_000 }).level).toBe("unknown");
  });
});

describe("I1 hook-level: the health re-reads on the same trigger, throttled, and detaches", () => {
  const rig = (over: { checkedAt?: number | null } = {}) => {
    const handlers = new Map<string, () => void>();
    const mk = () => ({ addEventListener: (t: string, f: () => void) => handlers.set(t, f), removeEventListener: (t: string) => handlers.delete(t) });
    const doc = { ...mk(), visibilityState: "visible" };
    let t = T0, checked: number | null = over.checkedAt === undefined ? T0 : over.checkedAt;
    const refreshQuiet = vi.fn();
    const detach = attachHealthRefresh({ getCheckedAt: () => checked, refreshQuiet, now: () => t, win: mk(), doc });
    return { handlers, doc, refreshQuiet, detach, at: (n: number) => { t = n; }, checked: (c: number | null) => { checked = c; } };
  };
  it("a focus or a visible event re-reads the health once it is 30 s old; sooner, hidden, or while a read is in flight it does not", () => {
    const r = rig();
    r.at(T0 + 29_999); r.handlers.get("focus")!();
    expect(r.refreshQuiet).not.toHaveBeenCalled();
    r.at(T0 + 30_000); r.handlers.get("focus")!();
    expect(r.refreshQuiet).toHaveBeenCalledTimes(1);
    r.handlers.get("visibilitychange")!(); // the same moment: focus + visibilitychange fire together, one read only
    expect(r.refreshQuiet).toHaveBeenCalledTimes(1);
    r.doc.visibilityState = "hidden"; r.at(T0 + 300_000); r.handlers.get("visibilitychange")!();
    expect(r.refreshQuiet).toHaveBeenCalledTimes(1);
    r.doc.visibilityState = "visible"; r.checked(null); r.handlers.get("focus")!(); // checking: already in flight
    expect(r.refreshQuiet).toHaveBeenCalledTimes(1);
    r.detach();
    expect(r.handlers.size).toBe(0);
  });
  it("«إعادة الفحص» re-reads the health AND forces the engine read", () => {
    const refresh = vi.fn(), engineRefresh = vi.fn();
    recheckAll({ refresh, engineRefresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(engineRefresh).toHaveBeenCalledWith({ force: true });
  });
  it("the one-minute label tick runs only while the page is visible, fetches nothing, and stops on unmount", () => {
    const handlers = new Map<string, () => void>();
    const doc = { visibilityState: "visible", addEventListener: (t: string, f: () => void) => handlers.set(t, f), removeEventListener: (t: string) => handlers.delete(t) };
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const cb = vi.fn();
    const stop = startVisibleTick(cb, { doc, setTimer: (f, ms) => { const h = { f, ms, live: true }; timers.push(h); return h; }, clearTimer: (h) => { (h as { live: boolean }).live = false; } });
    expect(timers).toHaveLength(1); expect(timers[0].ms).toBe(60_000);
    doc.visibilityState = "hidden"; handlers.get("visibilitychange")!();
    expect(timers[0].live).toBe(false);
    doc.visibilityState = "visible"; handlers.get("visibilitychange")!();
    expect(timers).toHaveLength(2); expect(timers[1].live).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1); // back in view: the label catches up at once
    stop();
    expect(timers[1].live).toBe(false); expect(handlers.size).toBe(0);
  });
});

describe("I3: approvals from an incomplete run list", () => {
  it("0 pending with runs.complete false is unknown, never an all-clear", () => {
    expect(readApprovals({ status: up({ runs: { approvalsPending: 0, complete: false } }), at: 1 })).toMatchObject({ level: "unknown" });
  });
  it("n > 0 from an incomplete list says «على الأقل n»", () => {
    expect(readApprovals({ status: up({ runs: { approvalsPending: 3, complete: false } }), at: 1 })).toMatchObject({ level: "reachable", label: "على الأقل 3" });
  });
  it("a complete list is as before", () => {
    expect(readApprovals({ status: up({ runs: { approvalsPending: 0, complete: true } }), at: 1 })).toMatchObject({ level: "reachable", label: "لا شيء" });
  });
  it("when `runs` is there but could not count approvals, the link's own (maybe unsynced) 0 is never used instead", () => {
    expect(readApprovals({ status: up({ link: { state: "up", pendingApprovals: 0 }, runs: { approvalsPending: null, complete: false } }), at: 1 }).level).toBe("unknown");
  });
});

describe("I4: header with the automatic fallback active", () => {
  const s = state({ model: { id: "openai/gpt-x", provider: "openai", source: "fallback" }, fallback: { from: "anthropic/claude-sonnet-4-5", to: "openai/gpt-x", reason: "rate_limit" },
    last_reply: { provider: "openai", model: "gpt-x", at: 1 } });
  it("model.id is the model switched TO: the selected one is fallback.from, so the note appears exactly in the fallback case", () => {
    expect(headerModel(s, [])).toMatchObject({ differs: true, executed: "gpt-x", selected: "claude-sonnet-4-5", reason: "تجاوز حدّ الاستخدام" });
  });
  it("without fallback.from the old reading stays (no invented selection)", () => {
    expect(headerModel({ ...s, fallback: null }, []).differs).toBe(false);
  });
});

describe("Minor 4 / 5: header freshness and id normalisation", () => {
  it("a newer reply row beats a stale last_reply (no stale flash right after a reply); an older or undated row does not", () => {
    const s = state({ last_reply: { provider: "openai", model: "gpt-x", at: 1000 } });
    expect(headerModel(s, [], { provider: "anthropic", model: "claude-sonnet-4-5", at: 2000 })).toMatchObject({ executed: "claude-sonnet-4-5", differs: false });
    expect(headerModel(s, [], { provider: "anthropic", model: "claude-sonnet-4-5", at: 500 }).executed).toBe("gpt-x");
    expect(headerModel(s, [], { provider: "anthropic", model: "claude-sonnet-4-5" }).executed).toBe("gpt-x");
  });
  it("the fallback reason follows the chosen source (an older state's reason is not pinned on a newer row)", () => {
    const s = state({ last_reply: { provider: "openai", model: "gpt-x", at: 1000 }, fallback: { from: "a/b", to: "openai/gpt-x", reason: "rate_limit" } });
    expect(headerModel(s, [], { provider: "openai", model: "gpt-y", at: 2000, fallback: null })).toMatchObject({ differs: true, reason: "" });
  });
  it("a bare selected id next to a prefixed fast id is the same model; two different providers are not", () => {
    const bare = state({ model: { id: "grok-3", provider: "xai", source: "override" }, last_reply: { provider: "xai", model: "grok-3-fast", at: 1 } });
    expect(headerModel(bare, []).differs).toBe(false);
    const prefixed = state({ model: { id: "xai/grok-3-fast", provider: "xai", source: "override" }, last_reply: { provider: null, model: "grok-3", at: 1 } });
    expect(headerModel(prefixed, []).differs).toBe(false);
    const other = state({ model: { id: "openai/gpt-x", provider: "openai", source: "override" }, last_reply: { provider: "azure", model: "gpt-x", at: 1 } });
    expect(headerModel(other, []).differs).toBe(true);
  });
});

describe("Minor 2: the BFF client", () => {
  const mk = (status: number, body: unknown = {}) => createBashtClient((async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
  it("404 / 429 / 503 / 401 / 403 are «no data» (null), never «asked and nobody answered»", async () => {
    for (const st of [401, 403, 404, 429, 503]) expect(await mk(st, { error: "x" }).engineStatus(), String(st)).toBeNull();
  });
  it("a 500 or a network failure is a real non-answer", async () => {
    expect(await mk(500).engineStatus()).toEqual(unknownEngineStatus());
  });
});

describe("Minor 3: the store", () => {
  it("a null (signed-out) read does not block the re-read after sign-in", async () => {
    let t = 0;
    const f = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(up());
    const st = createEngineStatusStore({ fetch: f, now: () => t });
    await st.refresh(); t = 10_000; await st.refresh();
    expect(f).toHaveBeenCalledTimes(2);
    expect(st.get().status?.reachable).toBe(true);
    t = 20_000; await st.refresh();
    expect(f).toHaveBeenCalledTimes(2); // a real answer is cached for 30 s again
  });
  it("a read in flight across reset() does not overwrite the reset state, and does not notify as fresh data", async () => {
    let res!: (v: unknown) => void;
    const f = vi.fn().mockImplementationOnce(() => new Promise((r) => { res = r; })).mockResolvedValue(up());
    const st = createEngineStatusStore({ fetch: f as never, now: () => 1 });
    const p = st.refresh(); st.reset(); res(up()); await p;
    expect(st.get()).toEqual({ status: null, at: 0 });
    await st.refresh(); // and the store is usable again right away
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("Minor 7: the legacy Claude badge", () => {
  it("green only after a real probe succeeded; configuration alone is neutral", () => {
    expect(claudeBadge("ready", true, "idle").tone).toBeUndefined();
    expect(claudeBadge("ready", true, "testing").tone).toBeUndefined();
    expect(claudeBadge("ready", true, "ok").tone).toBe("ok");
    expect(claudeBadge("ready", true, "fail").tone).toBe("warn");
    expect(claudeBadge("off", false, "idle")).toMatchObject({ tone: undefined, label: "غير مفعّل" });
  });
});
