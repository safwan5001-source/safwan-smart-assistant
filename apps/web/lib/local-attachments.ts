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

export function createLocalAttachments(store: AttachmentStore, opts: { newId?: () => string } = {}) {
  const entries = new Map<string, LocalEntry>();
  const memory = new Map<string, StoredImage[]>(); // bytes of records that could not be persisted (this page session only)
  const chains = new Map<string, Promise<unknown>>(); // per record: persist → patches run in order
  let snapshot: readonly LocalEntry[] = [];
  const listeners = new Set<() => void>();
  const changed = () => { snapshot = [...entries.values()]; listeners.forEach((l) => l()); };
  const chain = (id: string, f: () => Promise<unknown>) => { const p = (chains.get(id) ?? Promise.resolve()).then(f, f); chains.set(id, p); return p; };
  let loaded: Promise<void> | null = null;

  const api = {
    newId: opts.newId ?? (() => crypto.randomUUID()),
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snapshot,
    /** Reads what earlier sessions kept (once). Records created meanwhile in this session are not overwritten. */
    load(): Promise<void> {
      return (loaded ??= store.list().then((r) => {
        if (!r.ok) return;
        let any = false;
        for (const m of r.value) if (!entries.has(m.clientMsgId)) { entries.set(m.clientMsgId, { ...m, persisted: true }); any = true; }
        if (any) changed();
      }).catch(() => { loaded = null; }));
    },
    /** A photo message is about to be sent: known in memory at once, saved to the device in the background. */
    register(n: NewAttachment): void {
      const meta: LocalEntry = { clientMsgId: n.clientMsgId, text: n.text, sentAt: n.sentAt, persisted: false,
        images: n.images.map(({ blob: _b, ...i }) => i) };
      entries.set(n.clientMsgId, meta);
      memory.set(n.clientMsgId, n.images);
      changed();
      void chain(n.clientMsgId, async () => {
        const r = await store.put({ clientMsgId: n.clientMsgId, text: n.text, sentAt: n.sentAt, images: n.images });
        const cur = entries.get(n.clientMsgId);
        if (r.ok && cur) { memory.delete(n.clientMsgId); entries.set(n.clientMsgId, { ...cur, persisted: true }); changed(); }
        // not saved (private mode, quota, …): the bytes stay in memory for this session
      });
    },
    /** The engine accepted the turn: remember its run id (the strongest match). */
    attachRun(id: string, runId: string): void {
      const cur = entries.get(id); if (!cur) return;
      entries.set(id, { ...cur, runId }); changed();
      void chain(id, () => (entries.get(id)?.persisted ? store.patch(id, { runId }) : Promise.resolve()));
    },
    /** The row this record was matched to (persisted so it survives reloads). */
    bind(id: string, rowId: string): void {
      const cur = entries.get(id); if (!cur || cur.matchedRowId === rowId) return;
      entries.set(id, { ...cur, matchedRowId: rowId }); changed();
      void chain(id, () => (entries.get(id)?.persisted ? store.patch(id, { matchedRowId: rowId }) : Promise.resolve()));
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
      entries.clear(); memory.clear(); changed();
      const r = await store.clear();
      return r.ok || r.reason === "unavailable";
    },
  };
  return api;
}
export type LocalAttachments = ReturnType<typeof createLocalAttachments>;

let shared: LocalAttachments | null = null;
export const localAttachments = (): LocalAttachments => (shared ??= createLocalAttachments(attachmentStore()));
