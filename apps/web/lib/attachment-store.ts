/**
 * A device-local copy of the photos the owner sent (BASHT phase 2, batch 2, R5). The photo is sent to the engine as base64; this
 * keeps the already-downscaled bytes ON THIS DEVICE (IndexedDB, never localStorage) so the message still shows its photo after the
 * history reloads, the app is killed and reopened, or the engine's own row carries no media.
 *
 * - Own database (`basht-attachments-v1`): metadata (`meta`) and bytes (`blobs`) live in two stores, so listing records is cheap and
 *   a photo's bytes are read only when its bubble is on screen.
 * - A record is keyed by a client-generated `clientMsgId` (uuid). `runId` (what /send returned) and `matchedRowId` (the history row
 *   it was matched to, lib/attachment-match) are filled in later.
 * - It is a cache the owner may clear: NOTHING here evicts or deletes by itself (no size cap, no age limit). `usage()` reports
 *   count/bytes for diagnostics, `remove(id)` deletes one record, `clear()` is called only by signing out / an explicit owner action.
 * - Every method resolves, never throws: IndexedDB missing or throwing (private mode, blocked storage), a full disk (quota) or any
 *   other failure is a `{ ok: false, reason }` the caller can ignore — the app keeps working with the photo in memory.
 */
export type StoredImage = { id: string; name: string; mime: string; size: number; width: number; height: number; blob: Blob };
export type StoredImageMeta = Omit<StoredImage, "blob">;
export type AttachmentRecord = { clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string; images: StoredImage[] };
export type AttachmentMeta = Omit<AttachmentRecord, "images"> & { images: StoredImageMeta[] };
export type StoreFailure = "unavailable" | "quota" | "error";
export type StoreResult<T = void> = { ok: true; value: T } | { ok: false; reason: StoreFailure };
export type AttachmentUsage = { count: number; bytes: number };

export type AttachmentStore = {
  put(rec: AttachmentRecord): Promise<StoreResult>;
  list(): Promise<StoreResult<AttachmentMeta[]>>;
  /** One record with its photo bytes. */
  get(id: string): Promise<StoreResult<AttachmentRecord | null>>;
  /** Fills `runId` / `matchedRowId` into an existing record (a missing record is not an error). */
  patch(id: string, fields: { runId?: string; matchedRowId?: string }): Promise<StoreResult>;
  remove(id: string): Promise<StoreResult>;
  usage(): Promise<StoreResult<AttachmentUsage>>;
  /** Deletes everything (sign-out, or the owner's explicit «clear»). */
  clear(): Promise<StoreResult>;
};

export const ATTACHMENT_DB = "basht-attachments-v1";
const META = "meta";
const BLOBS = "blobs";
const blobKey = (id: string, imageId: string) => `${id}#${imageId}`;

const failure = (e: unknown): StoreFailure => {
  const name = (e as { name?: string } | null)?.name ?? "";
  const code = (e as { code?: number } | null)?.code;
  return name === "QuotaExceededError" || code === 22 ? "quota" : "error";
};
const fail = <T>(reason: StoreFailure): StoreResult<T> => ({ ok: false, reason });

/** Real store over an IndexedDB factory (`indexedDB` in a browser; a double in tests). `undefined` factory → always "unavailable". */
export function createAttachmentStore(factory?: IDBFactory | undefined): AttachmentStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) return reject(new Error("unavailable"));
      let req: IDBOpenDBRequest;
      try { req = factory.open(ATTACHMENT_DB, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "clientMsgId" });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "key" });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("open failed"));
      req.onblocked = () => reject(new Error("blocked"));
    });
    opening = p;
    p.catch(() => { if (opening === p) opening = null; }); // a failed open is retried by the next call
    return p;
  };

  /** One transaction over both stores. `run` queues requests; the result is read when the transaction has committed. */
  async function tx<T>(mode: IDBTransactionMode, run: (meta: IDBObjectStore, blobs: IDBObjectStore) => () => T): Promise<StoreResult<T>> {
    if (!factory) return fail("unavailable");
    let db: IDBDatabase;
    try { db = await open(); } catch { return fail("unavailable"); }
    try {
      return await new Promise<StoreResult<T>>((resolve) => {
        let t: IDBTransaction;
        try { t = db.transaction([META, BLOBS], mode); } catch (e) { opening = null; resolve(fail(failure(e))); return; }
        let read: () => T;
        try { read = run(t.objectStore(META), t.objectStore(BLOBS)); } catch (e) { try { t.abort(); } catch { /* done */ } resolve(fail(failure(e))); return; }
        t.oncomplete = () => { try { resolve({ ok: true, value: read() }); } catch (e) { resolve(fail(failure(e))); } };
        t.onerror = () => resolve(fail(failure(t.error)));
        t.onabort = () => resolve(fail(failure(t.error)));
      });
    } catch (e) { return fail(failure(e)); }
  }

  return {
    put: (rec) => tx("readwrite", (meta, blobs) => {
      const m: AttachmentMeta = { clientMsgId: rec.clientMsgId, text: rec.text, sentAt: rec.sentAt,
        ...(rec.runId ? { runId: rec.runId } : {}), ...(rec.matchedRowId ? { matchedRowId: rec.matchedRowId } : {}),
        images: rec.images.map(({ blob: _b, ...i }) => i) };
      meta.put(m);
      for (const i of rec.images) blobs.put({ key: blobKey(rec.clientMsgId, i.id), blob: i.blob });
      return () => undefined;
    }),
    list: () => tx("readonly", (meta) => { const r = meta.getAll(); return () => (r.result as AttachmentMeta[]) ?? []; }),
    get: (id) => tx("readonly", (meta, blobs) => {
      const mr = meta.get(id);
      const imgs = new Map<string, IDBRequest>();
      mr.onsuccess = () => { const m = mr.result as AttachmentMeta | undefined; if (m) for (const i of m.images) imgs.set(i.id, blobs.get(blobKey(id, i.id))); };
      return () => {
        const m = mr.result as AttachmentMeta | undefined;
        if (!m) return null;
        const images: StoredImage[] = [];
        for (const i of m.images) { const b = (imgs.get(i.id)?.result as { blob?: Blob } | undefined)?.blob; if (b) images.push({ ...i, blob: b }); }
        return { ...m, images };
      };
    }),
    patch: (id, fields) => tx("readwrite", (meta) => {
      const r = meta.get(id);
      r.onsuccess = () => {
        const m = r.result as AttachmentMeta | undefined;
        if (!m) return;
        meta.put({ ...m, ...(fields.runId ? { runId: fields.runId } : {}), ...(fields.matchedRowId ? { matchedRowId: fields.matchedRowId } : {}) });
      };
      return () => undefined;
    }),
    remove: (id) => tx("readwrite", (meta, blobs) => {
      const r = meta.get(id);
      r.onsuccess = () => {
        const m = r.result as AttachmentMeta | undefined;
        if (m) for (const i of m.images) blobs.delete(blobKey(id, i.id));
        meta.delete(id);
      };
      return () => undefined;
    }),
    usage: () => tx("readonly", (meta) => {
      const r = meta.getAll();
      return () => {
        const all = (r.result as AttachmentMeta[]) ?? [];
        return { count: all.length, bytes: all.reduce((n, m) => n + m.images.reduce((s, i) => s + (i.size || 0), 0), 0) };
      };
    }),
    clear: () => tx("readwrite", (meta, blobs) => { meta.clear(); blobs.clear(); return () => undefined; }),
  };
}

let shared: AttachmentStore | null = null;
/** The app's store (this browser's IndexedDB; "unavailable" where there is none). */
export const attachmentStore = (): AttachmentStore =>
  (shared ??= createAttachmentStore(typeof indexedDB === "undefined" ? undefined : indexedDB));
/** For sign-out: wipes the local photo copies. Resolves true when nothing is left (or there never was a store). */
export const clearAttachments = async (store: AttachmentStore = attachmentStore()): Promise<boolean> => {
  const r = await store.clear();
  return r.ok || r.reason === "unavailable";
};
