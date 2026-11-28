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
/** `runDone`: the record's turn reached a terminal state (a text match may be persisted from then on). `superseded`: the owner retried
 *  this turn, so it no longer stands as a pending bubble of its own. */
export type AttachmentRecord = { clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string; runDone?: boolean; superseded?: boolean; images: StoredImage[] };
export type AttachmentMeta = Omit<AttachmentRecord, "images"> & { images: StoredImageMeta[] };
/** `absent`: this browser has no IndexedDB at all (nothing could ever have been stored). `unavailable`: it has one but could not OPEN it
 *  now — what is inside is unknown (a wipe that hits this has NOT wiped anything). */
export type StoreFailure = "absent" | "unavailable" | "quota" | "error";
export type StoreResult<T = void> = { ok: true; value: T } | { ok: false; reason: StoreFailure };
export type AttachmentUsage = { count: number; bytes: number };

export type AttachmentStore = {
  put(rec: AttachmentRecord): Promise<StoreResult>;
  list(): Promise<StoreResult<AttachmentMeta[]>>;
  /** One record with its photo bytes. */
  get(id: string): Promise<StoreResult<AttachmentRecord | null>>;
  /** Fills fields into an existing record (a missing record is not an error); `matchedRowId: null` clears the binding. */
  patch(id: string, fields: { runId?: string; matchedRowId?: string | null; runDone?: boolean; superseded?: boolean }): Promise<StoreResult>;
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

/** Real store over an IndexedDB factory (`indexedDB` in a browser; a double in tests). `undefined` factory → always "absent". */
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

  /** Reasons the browser gives when it has silently dropped the connection (iOS under storage pressure / backgrounding). */
  const lost = (e: unknown) => ["InvalidStateError", "UnknownError", "TransactionInactiveError", "AbortError"].includes((e as { name?: string } | null)?.name ?? "");

  /** One transaction over both stores. `run` queues requests; the result is read when the transaction has committed. A lost
   *  connection (InvalidStateError / UnknownError) reopens the database and retries ONCE; a full disk never retries. */
  async function tx<T>(mode: IDBTransactionMode, run: (meta: IDBObjectStore, blobs: IDBObjectStore) => () => T, retried = false): Promise<StoreResult<T>> {
    if (!factory) return fail("absent");
    let db: IDBDatabase;
    try { db = await open(); } catch { return fail("unavailable"); }
    let lastError: unknown = null;
    const r = await new Promise<StoreResult<T>>((resolve) => {
      let t: IDBTransaction;
      try { t = db.transaction([META, BLOBS], mode); } catch (e) { lastError = e; resolve(fail(failure(e))); return; }
      let read: () => T;
      try { read = run(t.objectStore(META), t.objectStore(BLOBS)); } catch (e) { lastError = e; try { t.abort(); } catch { /* done */ } resolve(fail(failure(e))); return; }
      t.oncomplete = () => { try { resolve({ ok: true, value: read() }); } catch (e) { lastError = e; resolve(fail(failure(e))); } };
      t.onerror = () => { lastError = t.error; resolve(fail(failure(t.error))); };
      t.onabort = () => { lastError = t.error; resolve(fail(failure(t.error))); };
    });
    if (!r.ok && !retried && r.reason === "error" && lost(lastError)) {
      opening = null; try { db.close(); } catch { /* already closed */ }
      return tx(mode, run, true);
    }
    return r;
  }

  return {
    put: (rec) => tx("readwrite", (meta, blobs) => {
      const m: AttachmentMeta = { clientMsgId: rec.clientMsgId, text: rec.text, sentAt: rec.sentAt,
        ...(rec.runId ? { runId: rec.runId } : {}), ...(rec.matchedRowId ? { matchedRowId: rec.matchedRowId } : {}),
        ...(rec.runDone ? { runDone: true } : {}), ...(rec.superseded ? { superseded: true } : {}),
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
        const next: AttachmentMeta = { ...m };
        if (fields.runId) next.runId = fields.runId;
        if (fields.matchedRowId) next.matchedRowId = fields.matchedRowId; else if (fields.matchedRowId === null) delete next.matchedRowId;
        if (fields.runDone) next.runDone = true;
        if (fields.superseded) next.superseded = true;
        meta.put(next);
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
/** The app's store (this browser's IndexedDB; every call reports "absent" where there is none). */
export const attachmentStore = (): AttachmentStore =>
  (shared ??= createAttachmentStore(typeof indexedDB === "undefined" ? undefined : indexedDB));
/**
 * For sign-out: wipes the local photo copies. True only when nothing is left: the wipe ran, or this browser has no IndexedDB at all
 * (nothing could have been stored). A database that merely failed to OPEN may still hold photos, so that is NOT success — the open is
 * retried once, and a second failure is reported as not cleared.
 */
export const clearAttachments = async (store: AttachmentStore = attachmentStore()): Promise<boolean> => {
  let r = await store.clear();
  if (!r.ok && r.reason !== "absent") r = await store.clear();
  return r.ok || r.reason === "absent";
};
