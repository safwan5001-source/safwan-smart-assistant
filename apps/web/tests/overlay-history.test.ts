import { describe, expect, it, vi } from "vitest";
import { createOverlayHistory } from "@/lib/overlay-history";

/** A fake window whose history.back() pops asynchronously, like a browser. */
function fakeWindow() {
  const stack: unknown[] = [{ __NA: true }];
  let idx = 0;
  const ls = new Set<() => void>();
  const w = {
    history: {
      get state() { return stack[idx]; },
      pushState: (s: unknown) => { stack.splice(idx + 1); stack.push(s); idx++; },
      back: () => { queueMicrotask(() => { if (idx > 0) idx--; [...ls].forEach((f) => f()); }); },
    },
    addEventListener: (_t: "popstate", f: () => void) => { ls.add(f); },
    removeEventListener: (_t: "popstate", f: () => void) => { ls.delete(f); },
    userBack: () => { if (idx > 0) idx--; [...ls].forEach((f) => f()); },
    depth: () => idx,
  };
  return w;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("voice overlay history (the back gesture closes it)", () => {
  it("back closes the overlay; closing by a button goes back over its entry", async () => {
    const w = fakeWindow(); const h = createOverlayHistory(w);
    const onBack = vi.fn();
    const close = h.open(onBack);
    expect(w.depth()).toBe(1);
    w.userBack(); expect(onBack).toHaveBeenCalledTimes(1);
    close(); expect(w.depth()).toBe(0);
    const onBack2 = vi.fn();
    const close2 = h.open(onBack2);
    close2(); await tick();
    expect(w.depth()).toBe(0); expect(onBack2).not.toHaveBeenCalled();
  });
  it("re-opened before the async back() lands: the old pop never closes the new overlay, and the new entry is pushed after it", async () => {
    const w = fakeWindow(); const h = createOverlayHistory(w);
    const close1 = h.open(vi.fn());
    close1();                        // history.back() is queued, not done
    expect(h.pending()).toBe(true);
    const onBack = vi.fn();
    const close2 = h.open(onBack);   // same frame
    expect(w.depth()).toBe(1);       // not pushed yet (it would be the entry popped)
    await tick();
    expect(onBack, "the stale pop did not close the new overlay").not.toHaveBeenCalled();
    expect(h.pending()).toBe(false);
    expect(w.depth()).toBe(1);       // popped the old entry, pushed the new one
    w.userBack(); expect(onBack).toHaveBeenCalledTimes(1);
    close2();
  });
  it("opened by its own address: nothing is pushed; back still closes it", () => {
    const w = fakeWindow(); const h = createOverlayHistory(w);
    const onBack = vi.fn();
    const close = h.open(onBack, { push: false });
    expect(w.depth()).toBe(0);
    w.userBack(); expect(onBack).toHaveBeenCalled();
    close(); expect(h.pending()).toBe(false);
  });
});
