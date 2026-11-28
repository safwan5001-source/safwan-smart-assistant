/**
 * The app's view of the device-local photo copies (lib/attachment-store): an in-memory index (so a turn just sent is known at once,
 * synchronously) with IndexedDB behind it. If IndexedDB is unavailable or full, the photos of that turn simply stay in memory for
 * this page session (`persisted: false`) — the app never fails because of it. Nothing is evicted automatically.
 */
import { attachmentStore, type AttachmentMeta, type AttachmentStore, type AttachmentUsage, type StoredImage } from "./attachment-store";
import type { PreparedImage } from "./image-prep";

export type LocalEntry = AttachmentMeta & { persisted: boolean };
export type NewAttachment = { clientMsgId: string; text: string; sentAt: number; images: StoredImage[] };

/** The prepared photo's bytes (base64, as sent) as a Blob — the same bytes the engine received. */
export function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}
export const toStoredImage = (i: PreparedImage): StoredImage =>
  ({ id: i.id, name: i.name, mime: i.mime, size: i.bytes, width: i.width, height: i.height, blob: base64ToBlob(i.data, i.mime) });

/** After a failed metadata read, the next automatic attempt waits this long (a history load triggers it; no tight loop). */
export const LOAD_RETRY_MS = 4000;
export function createLocalAttachments(store: AttachmentStore, opts: { newId?: () => string; now?: () => number } = {}) {
  const entries = new Map<string, LocalEntry>();
  const memory = new Map<string, StoredImage[]>(); // bytes of records that could not be persisted (this page session only)
  const chains = new Map<string, Promise<unknown>>(); // per record: persist → patches run in order
  let snapshot: readonly LocalEntry[] = [];
  const listeners = new Set<() => void>();
  const changed = () => { snapshot = [...entries.values()]; listeners.forEach((l) => l()); };
  const chain = (id: string, f: () => Promise<unknown>) => { const p = (chains.get(id) ?? Promise.resolve()).then(f, f); chains.set(id, p); return p; };
  let loaded: Promise<void> | null = null;
  let loadState: "none" | "loading" | "ok" | "failed" = "none";
  let failedAt = 0;
  const now = opts.now ?? Date.now;
  /** Bumped by clear(): a save that was already in flight when the owner signed out must not bring its record back. */
  let generation = 0;
  const patchEntry = (id: string, fields: Partial<LocalEntry>, persist: Parameters<AttachmentStore["patch"]>[1]) => {
    const cur = entries.get(id); if (!cur) return;
    entries.set(id, { ...cur, ...fields }); changed();
    const gen = generation;
    void chain(id, () => (gen === generation && entries.get(id)?.persisted ? store.patch(id, persist) : Promise.resolve()));
  };

  const api = {
    newId: opts.newId ?? (() => crypto.randomUUID()),
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snapshot,
    /**
     * Reads what earlier sessions kept. A successful read is final for the page session. A FAILED read (IndexedDB could not be opened
     * yet) is not cached: it is attempted again by the next call once `LOAD_RETRY_MS` has passed (the hook calls this on each history
     * load, so there is no tight loop), or at once with `force` (the owner's «إعادة المحاولة», one attempt per press).
     * Records created meanwhile in this session are never overwritten.
     */
    load(o: { force?: boolean } = {}): Promise<void> {
      if (loaded && (loadState !== "failed" || (!o.force && now() - failedAt < LOAD_RETRY_MS))) return loaded;
      if (loadState === "loading" && loaded) return loaded;
      const gen = generation;
      loadState = "loading";
      loaded = store.list().then((r) => {
        if (gen !== generation) return;
        if (!r.ok) { loadState = "failed"; failedAt = now(); return; }
        loadState = "ok";
        let any = false;
        for (const m of r.value) if (!entries.has(m.clientMsgId)) { entries.set(m.clientMsgId, { ...m, persisted: true }); any = true; }
        if (any) changed();
      }).catch(() => { if (gen === generation) { loadState = "failed"; failedAt = now(); } });
      return loaded;
    },
    /** A photo message is about to be sent: known in memory at once, saved to the device in the background. */
    register(n: NewAttachment): void {
      const meta: LocalEntry = { clientMsgId: n.clientMsgId, text: n.text, sentAt: n.sentAt, persisted: false,
        images: n.images.map(({ blob: _b, ...i }) => i) };
      entries.set(n.clientMsgId, meta);
      memory.set(n.clientMsgId, n.images);
      changed();
      const gen = generation;
      void chain(n.clientMsgId, async () => {
        if (gen !== generation) return; // signed out meanwhile
        const r = await store.put({ clientMsgId: n.clientMsgId, text: n.text, sentAt: n.sentAt, images: n.images });
        if (gen !== generation) { if (r.ok) await store.remove(n.clientMsgId); return; } // the wipe ran while this save was in flight
        const cur = entries.get(n.clientMsgId);
        if (r.ok && cur) { memory.delete(n.clientMsgId); entries.set(n.clientMsgId, { ...cur, persisted: true }); changed(); }
        // not saved (private mode, quota, …): the bytes stay in memory for this session
      });
    },
    /** The engine accepted the turn: remember its run id (the strongest match). */
    attachRun(id: string, runId: string): void { patchEntry(id, { runId }, { runId }); },
    /** The turn of this run reached a terminal state: a text match for it may now be persisted. */
    markDone(runId: string): void {
      for (const e of entries.values()) if (e.runId === runId && !e.runDone) patchEntry(e.clientMsgId, { runDone: true }, { runDone: true });
    },
    /** The owner retried this turn: it no longer stands as a separate pending bubble (a row it already has still shows its photo). */
    supersede(id: string): void { const cur = entries.get(id); if (cur && !cur.superseded) patchEntry(id, { superseded: true }, { superseded: true }); },
    /** The row this record was matched to (persisted so it survives reloads). */
    bind(id: string, rowId: string): void { const cur = entries.get(id); if (cur && cur.matchedRowId !== rowId) patchEntry(id, { matchedRowId: rowId }, { matchedRowId: rowId }); },
    /** The bound row no longer stands for the record (its text changed, or another record holds it): clear the binding. */
    unbind(id: string): void {
      const cur = entries.get(id); if (!cur?.matchedRowId) return;
      const { matchedRowId: _m, ...rest } = cur;
      entries.set(id, rest); changed();
      const gen = generation;
      void chain(id, () => (gen === generation && entries.get(id)?.persisted ? store.patch(id, { matchedRowId: null }) : Promise.resolve()));
    },
    /** The send was refused: nothing was sent, so no copy is kept. */
    discard(id: string): void {
      if (!entries.delete(id)) return;
      memory.delete(id); changed();
      void chain(id, () => store.remove(id)).then(() => chains.delete(id));
    },
    /** The record with its photo bytes (memory first, then the device), or null. */
    async images(id: string): Promise<StoredImage[] | null> {
      const m = memory.get(id); if (m) return m;
      await chains.get(id)?.catch(() => {}); // a save still running finishes first
      const m2 = memory.get(id); if (m2) return m2;
      const r = await store.get(id);
      return r.ok && r.value ? r.value.images : null;
    },
    async usage(): Promise<AttachmentUsage | null> { const r = await store.usage(); return r.ok ? r.value : null; },
    /** Explicit owner action / sign-out: forget everything this device kept. */
    async clear(): Promise<boolean> {
      generation++; loaded = null; loadState = "none";
      entries.clear(); memory.clear(); chains.clear(); changed();
      // true only when nothing is left on the device: wiped, or no IndexedDB at all. A database that failed to OPEN may still hold
      // photos (the open is retried once); that is reported as NOT cleared so sign-out names the leftovers.
      let r = await store.clear();
      if (!r.ok && r.reason !== "absent") r = await store.clear();
      return r.ok || r.reason === "absent";
    },
  };
  return api;
}
export type LocalAttachments = ReturnType<typeof createLocalAttachments>;

let shared: LocalAttachments | null = null;
export const localAttachments = (): LocalAttachments => (shared ??= createLocalAttachments(attachmentStore()));

/**
 * One owner turn WITH photos: the device copy is registered before the request (a page killed mid-send may still have reached the
 * engine), tied to the run once the engine accepted it, forgotten if the engine refused it, and the failed attempt it replaces
 * (`supersedes`, a retry) stops standing as a pending bubble of its own.
 */
export async function sendWithLocalCopy(mgr: LocalAttachments, a: { text: string; images: StoredImage[]; post: () => Promise<string>; supersedes?: string | null; now?: () => number }):
  Promise<{ runId: string; clientMsgId: string }> {
  const clientMsgId = mgr.newId();
  mgr.register({ clientMsgId, text: a.text, sentAt: (a.now ?? Date.now)(), images: a.images });
  try {
    const runId = await a.post();
    mgr.attachRun(clientMsgId, runId);
    if (a.supersedes) mgr.supersede(a.supersedes);
    return { runId, clientMsgId };
  } catch (e) { mgr.discard(clientMsgId); throw e; }
}
