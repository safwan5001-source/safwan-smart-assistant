/**
 * Loads the device-local photos of the records that are on screen and gives each an object URL (revoked when the record leaves the
 * screen). Framework-free so its timing is testable: a record is "loading" from the very first look (nothing is known yet), becomes
 * "ready" with its images, or "failed" (the device no longer has the bytes) — a failure is a state the bubble can show honestly,
 * never an empty bubble or a shimmer that never ends.
 */
import type { StoredImage } from "./attachment-store";
import type { LocalImageView } from "./viewer-items";

export type ImageViewState = { status: "ready"; images: LocalImageView[] } | { status: "failed" };
export type ImageViewSnapshot = ReadonlyMap<string, ImageViewState>;
export type ImageSource = { images(id: string): Promise<StoredImage[] | null> };

export function createImageViews(source: ImageSource, deps: { createUrl?: (b: Blob) => string; revokeUrl?: (u: string) => void } = {}) {
  const createUrl = deps.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeUrl ?? ((u: string) => { try { URL.revokeObjectURL(u); } catch { /* gone */ } });
  let state: ImageViewSnapshot = new Map();
  const claims = new Map<string, symbol>(); // one load per record; a stale load never lands after its claim was dropped
  const listeners = new Set<() => void>();
  const publish = (next: Map<string, ImageViewState>) => { state = next; listeners.forEach((l) => l()); };
  const release = (id: string, into: Map<string, ImageViewState>) => {
    const s = into.get(id);
    if (s?.status === "ready") s.images.forEach((i) => revokeUrl(i.url));
    into.delete(id); claims.delete(id);
  };
  let wanted: string[] = [];
  const start = (id: string) => {
    const claim = Symbol(id);
    claims.set(id, claim);
    const land = (s: ImageViewState) => { if (claims.get(id) !== claim) { if (s.status === "ready") s.images.forEach((i) => revokeUrl(i.url)); return; } const n = new Map(state); n.set(id, s); publish(n); };
    source.images(id).then((imgs) => {
      if (claims.get(id) !== claim) return;
      if (!imgs?.length) return land({ status: "failed" });
      land({ status: "ready", images: imgs.map((i) => ({ id: `${id}:${i.id}`, name: i.name, mime: i.mime, size: i.size, width: i.width, height: i.height, blob: i.blob, url: createUrl(i.blob) })) });
    }, () => land({ status: "failed" }));
  };
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: (): ImageViewSnapshot => state,
    /** The records on screen now: loads the new ones, releases the ones that left. */
    want(ids: readonly string[]) {
      wanted = [...ids];
      const next = new Map(state); let changed = false;
      for (const id of [...claims.keys()]) if (!ids.includes(id)) { release(id, next); changed = true; }
      if (changed) publish(next);
      for (const id of ids) if (!claims.has(id)) start(id);
    },
    /**
     * The owner pressed «إعادة المحاولة»: every record on screen whose read FAILED is read again (once per press, so there is no loop;
     * only those records go back to «loading» meanwhile). A transient device failure can recover this way.
     */
    retryFailed() {
      const failed = wanted.filter((id) => state.get(id)?.status === "failed");
      if (!failed.length) return;
      const next = new Map(state);
      for (const id of failed) { next.delete(id); claims.delete(id); }
      publish(next);
      for (const id of failed) start(id);
    },
    dispose() { const next = new Map(state); for (const id of [...claims.keys()]) release(id, next); state = new Map(); listeners.forEach((l) => l()); },
  };
}
export type ImageViews = ReturnType<typeof createImageViews>;

/** What each matched row shows, derived on every render from what is known NOW: nothing known yet reads as loading (first render
 *  included), so a reloaded photo never flashes «unavailable». */
export function rowLocalState(matches: ReadonlyMap<string, string>, snap: ImageViewSnapshot) {
  const byRow = new Map<string, LocalImageView[]>(); const loadingRows = new Set<string>(); const failedRows = new Set<string>();
  for (const [rowKey, id] of matches) {
    const s = snap.get(id);
    if (!s) loadingRows.add(rowKey); else if (s.status === "ready") byRow.set(rowKey, s.images); else failedRows.add(rowKey);
  }
  return { byRow, loadingRows, failedRows };
}
export type PendingView = { clientMsgId: string; text: string; sentAt: number; images: LocalImageView[]; status: "loading" | "ready" | "failed" };
export function pendingState(pending: readonly { clientMsgId: string; text: string; sentAt: number }[], snap: ImageViewSnapshot): PendingView[] {
  return pending.map((p) => { const s = snap.get(p.clientMsgId); return { ...p, images: s?.status === "ready" ? s.images : [], status: !s ? "loading" : s.status }; });
}
