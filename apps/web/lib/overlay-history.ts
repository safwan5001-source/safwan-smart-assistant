/**
 * The phone's back gesture/button closes the voice screen (ending the session) instead of leaving the conversation: opening it
 * pushes one history entry; closing it by any other way goes back over that entry. `history.back()` is asynchronous, so an
 * overlay re-opened before that pop arrives waits for it — the pop of the OLD entry never closes the NEW overlay, and the new
 * entry is never the one popped.
 */
type HistoryHost = {
  history: { state: unknown; pushState: (s: unknown, t: string) => void; back: () => void };
  addEventListener: (t: "popstate", f: () => void) => void;
  removeEventListener: (t: "popstate", f: () => void) => void;
};
const MARK = "bashtVoice";

export function createOverlayHistory(w: HistoryHost) {
  let pendingPop = false;
  const marked = () => !!(w.history.state as Record<string, unknown> | null)?.[MARK];
  return {
    pending: () => pendingPop,
    /**
     * The overlay opened: `onBack` runs when the owner goes back. `push: false` when the screen was opened by its own address
     * (that entry is being replaced; back then simply returns where the owner was). Returns the close/cleanup function.
     */
    open(onBack: () => void, { push = true }: { push?: boolean } = {}): () => void {
      let active = true, armed = false;
      const onPop = () => { if (active) onBack(); };
      const arm = () => {
        if (!active) return;
        if (push) { try { w.history.pushState({ ...((w.history.state as object | null) ?? {}), [MARK]: 1 }, ""); } catch { /* no history API */ } }
        w.addEventListener("popstate", onPop);
        armed = true;
      };
      let waitPop: (() => void) | null = null;
      if (pendingPop) { waitPop = () => { w.removeEventListener("popstate", waitPop!); waitPop = null; arm(); }; w.addEventListener("popstate", waitPop); }
      else arm();
      return () => {
        active = false;
        if (waitPop) { w.removeEventListener("popstate", waitPop); waitPop = null; }
        if (!armed) return;
        w.removeEventListener("popstate", onPop);
        if (push && marked()) {
          pendingPop = true;
          const clear = () => { pendingPop = false; w.removeEventListener("popstate", clear); };
          w.addEventListener("popstate", clear); // registered before any re-open waiter: it runs first
          try { w.history.back(); } catch { clear(); }
        }
      };
    },
  };
}
let shared: ReturnType<typeof createOverlayHistory> | null = null;
export const overlayHistory = () => (shared ??= createOverlayHistory(window as unknown as HistoryHost));
