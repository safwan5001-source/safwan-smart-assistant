"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import type { Store } from "./storage";
import { assistantService, type AssistantStatus } from "./assistant";

export const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);

/** Surfaces "your changes will not persist" when localStorage is blocked/full. */
export function useStoreError<T>(s: Store<T>): string | null {
  return useSyncExternalStore(s.subscribe, s.getError, () => null);
}

const noop = () => () => {};
/** false during SSR/first paint, true once on the client — lets screens show skeletons instead of flashing "empty". */
export const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** `checkedAt`: epoch ms when the current `status` ANSWERED (null while checking), for the "last check" line of the status indicators. */
export function useAssistantStatus(): { status: AssistantStatus; refresh: () => void; refreshQuiet: () => void; checkedAt: number | null } {
  const [state, setState] = useState<{ status: AssistantStatus; checkedAt: number | null }>({ status: { server: "checking" }, checkedAt: null });
  const refresh = useCallback(() => {
    setState({ status: { server: "checking" }, checkedAt: null });
    void assistantService.status().then((status) => setState({ status, checkedAt: Date.now() }));
  }, []);
  /** Re-reads the health WITHOUT flipping every indicator to «checking» (used on focus, throttled by the caller). */
  const refreshQuiet = useCallback(() => { void assistantService.status().then((status) => setState({ status, checkedAt: Date.now() })); }, []);
  useEffect(() => {
    let live = true;
    void assistantService.status().then((status) => live && setState({ status, checkedAt: Date.now() }));
    return () => { live = false; };
  }, []);
  return { status: state.status, refresh, refreshQuiet, checkedAt: state.checkedAt };
}

/** Keeps a local search box in sync when global search navigates to the same page with a new ?q=. */
export function useUrlQuery(set: (q: string) => void) {
  const q = useSearchParams().get("q");
  useEffect(() => { if (q !== null) set(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
}
