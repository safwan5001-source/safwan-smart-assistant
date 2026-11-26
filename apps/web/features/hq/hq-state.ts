"use client";
/**
 * HQ view state: one small external store (no extra library) shared by the 2D panels and the 3D scene.
 * Only display preferences persist (localStorage `safwan-hq-prefs`); the simulation itself restarts on every visit.
 */
import { useSyncExternalStore } from "react";
import type { AgentId } from "@/lib/hq/roster";
import type { ViewId } from "@/lib/hq/layout";
import type { ScenarioId } from "@/lib/hq/demo-data";

export type Quality = "auto" | "high" | "low";
export type Panel = "people" | "tasks" | "approvals" | "reports" | "log";
export type HqUi = {
  selected: AgentId | null;
  view: ViewId;
  /** bumps when the same view is requested again (re-centre) */
  viewNonce: number;
  labels: boolean;
  night: boolean;
  paused: boolean;
  quality: Quality;
  mode: "3d" | "plan";
  immersive: boolean;
  panel: Panel;
  scenario: ScenarioId;
  query: string;
};

export const PREFS_KEY = "safwan-hq-prefs";
type Prefs = Pick<HqUi, "labels" | "night" | "quality" | "mode">;
const PREF_KEYS: (keyof Prefs)[] = ["labels", "night", "quality", "mode"];

const DEFAULTS: HqUi = {
  selected: null, view: "overview", viewNonce: 0, labels: true, night: false, paused: false, quality: "auto", mode: "3d",
  immersive: false, panel: "people", scenario: "fleet", query: "",
};

function readPrefs(): Partial<Prefs> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Partial<Prefs>;
    const out: Partial<Prefs> = {};
    if (typeof p.labels === "boolean") out.labels = p.labels;
    if (typeof p.night === "boolean") out.night = p.night;
    if (p.quality === "auto" || p.quality === "high" || p.quality === "low") out.quality = p.quality;
    if (p.mode === "3d" || p.mode === "plan") out.mode = p.mode;
    return out;
  } catch { return {}; }
}

export function createHqStore(initial?: Partial<HqUi>) {
  let state: HqUi = { ...DEFAULTS, ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    set(patch: Partial<HqUi>) {
      state = { ...state, ...patch };
      if (PREF_KEYS.some((k) => k in patch)) {
        try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, state[k]])))); } catch { /* private mode: prefs just don't stick */ }
      }
      listeners.forEach((l) => l());
    },
    /** Load saved prefs + system hints once on the client. */
    hydrate() {
      const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      this.set({ ...readPrefs(), ...(reduce ? { paused: true } : {}) });
    },
  };
}
export type HqStore = ReturnType<typeof createHqStore>;
export const useHq = <T,>(store: HqStore, pick: (s: HqUi) => T): T =>
  useSyncExternalStore(store.subscribe, () => pick(store.get()), () => pick(store.get()));
