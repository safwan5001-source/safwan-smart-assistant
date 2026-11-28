"use client";
/**
 * The engine's own status (GET /api/basht/engine-status), read by the settings and dashboard indicators. It is NOT polled:
 *  - one read when a screen that shows it opens, and again on focus / when the tab becomes visible, at most every 30 s;
 *  - a hidden page never reads (no timer exists at all, so nothing can run in the background);
 *  - concurrent callers share one in-flight read, and the API caches the engine read for 30 s on top of that.
 * `status: null` = not asked successfully (signed out / disabled): "no data", never "down".
 */
import { useEffect, useSyncExternalStore } from "react";
import { bashtClient } from "./basht-client";
import type { EngineStatus } from "./engine-status";
import type { EngineSnapshot } from "./status-model";

export const ENGINE_STATUS_MIN_MS = 30_000;
const NONE: EngineSnapshot = { status: null, at: 0 };

export function createEngineStatusStore(deps: { fetch: () => Promise<EngineStatus | null>; now?: () => number; minIntervalMs?: number }) {
  const now = deps.now ?? Date.now;
  const minMs = deps.minIntervalMs ?? ENGINE_STATUS_MIN_MS;
  let state: EngineSnapshot = NONE;
  let inflight: Promise<EngineSnapshot> | null = null;
  let fetched = false;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    /** Reads unless a read is in flight or the last one is younger than the minimum (`force` skips the age check, never the in-flight one). */
    refresh({ force = false }: { force?: boolean } = {}): Promise<EngineSnapshot> {
      if (inflight) return inflight;
      if (!force && fetched && now() - state.at < minMs) return Promise.resolve(state);
      inflight = (async () => {
        let s: EngineStatus | null;
        try { s = await deps.fetch(); } catch { s = null; }
        state = { status: s, at: now() }; fetched = true;
        subs.forEach((f) => f());
        return state;
      })().finally(() => { inflight = null; });
      return inflight;
    },
    reset() { state = NONE; inflight = null; fetched = false; subs.forEach((f) => f()); },
  };
}
export type EngineStatusStore = ReturnType<typeof createEngineStatusStore>;
export const engineStatusStore: EngineStatusStore = createEngineStatusStore({ fetch: () => bashtClient.engineStatus() });

/** Reads while `enabled` (the app server is up and BASHT chat is configured); re-reads on focus/visible, throttled. Returns the snapshot. */
export function useEngineStatus(enabled: boolean, store: EngineStatusStore = engineStatusStore): EngineSnapshot {
  useEffect(() => {
    if (!enabled) return;
    void store.refresh();
    const again = () => { if (document.visibilityState !== "hidden") void store.refresh(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [enabled, store]);
  return useSyncExternalStore(store.subscribe, () => store.get(), () => NONE);
}
