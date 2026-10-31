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

export function useAssistantStatus(): { status: AssistantStatus; refresh: () => void } {
  const [status, setStatus] = useState<AssistantStatus>({ server: "checking" });
  const refresh = useCallback(() => {
    setStatus({ server: "checking" });
    void assistantService.status().then(setStatus);
  }, []);
  useEffect(() => {
    let live = true;
    void assistantService.status().then((s) => live && setStatus(s));
    return () => { live = false; };
  }, []);
  return { status, refresh };
}

/** Keeps a local search box in sync when global search navigates to the same page with a new ?q=. */
export function useUrlQuery(set: (q: string) => void) {
  const q = useSearchParams().get("q");
  useEffect(() => { if (q !== null) set(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
}
