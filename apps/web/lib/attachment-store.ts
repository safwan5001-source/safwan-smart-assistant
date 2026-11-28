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
export type AttachmentRecord = { clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string; runDone?: boolean;
  /** How the turn ended (`runDone` says only that it did). `uncertain`: the send was cut off by the network, so the engine may or may not have the turn. */
  runEnd?: "done" | "error" | "stopped"; uncertain?: boolean; superseded?: boolean; images: StoredImage[] };
export type AttachmentMeta = Omit<AttachmentRecord, "images"> & { images: StoredImageMeta[] };
/** `noscope`: no owner is known yet, so the scoped store is not touched at all (never an unscoped fallback). `absent`: this browser has no IndexedDB at all (nothing could ever have been stored). `unavailable`: it has one but could not OPEN it
 *  now — what is inside is unknown (a wipe that hits this has NOT wiped anything). */
export type StoreFailure = "absent" | "noscope" | "unavailable" | "quota" | "error";
export type StoreResult<T = void> = { ok: true; value: T } | { ok: false; reason: StoreFailure };
export type AttachmentUsage = { count: number; bytes: number };

export type AttachmentStore = {
  put(rec: AttachmentRecord): Promise<StoreResult>;
  list(): Promise<StoreResult<AttachmentMeta[]>>;
  /** One record with its photo bytes. */
  get(id: string): Promise<StoreResult<AttachmentRecord | null>>;
  /** Fills fields into an existing record (a missing record is not an error); `matchedRowId: null` clears the binding. */
  patch(id: string, fields: { runId?: string; matchedRowId?: string | null; runDone?: boolean; runEnd?: "done" | "error" | "stopped"; uncertain?: boolean; superseded?: boolean }): Promise<StoreResult>;
  remove(id: string): Promise<StoreResult>;
  usage(): Promise<StoreResult<AttachmentUsage>>;
  /** Deletes everything (sign-out, or the owner's explicit «clear»). */
  clear(): Promise<StoreResult>;
};

/** The database name of earlier, UNSCOPED builds (never deployed; still wiped on sign-out). A scoped database is `basht-attachments-v1-<scope>`. */
export const ATTACHMENT_DB = "basht-attachments-v1";
export const scopedDbName = (scope: string) => `${ATTACHMENT_DB}-${scope}`;
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
export function createAttachmentStore(factory?: IDBFactory | undefined, dbName: string = ATTACHMENT_DB): AttachmentStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) return reject(new Error("unavailable"));
      let req: IDBOpenDBRequest;
      try { req = factory.open(dbName, 1); } catch (e) { return reject(e); }
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
        ...(rec.runDone ? { runDone: true } : {}), ...(rec.runEnd ? { runEnd: rec.runEnd } : {}), ...(rec.uncertain ? { uncertain: true } : {}), ...(rec.superseded ? { superseded: true } : {}),
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
        if (fields.runEnd) next.runEnd = fields.runEnd;
        if (fields.uncertain) next.uncertain = true;
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

/** Which scopes have a database on this device (so sign-out can find them where `indexedDB.databases()` does not exist). Opaque ids only. */
export type ScopeRegistry = {
  read(): string[]; add(scope: string): void; clear(): void;
  /** How many times the registry could not be read or written (full quota, blocked storage, corrupt value). Above 0 it cannot be trusted
   *  to list every scope this device used. */
  failures?(): number;
};
const REGISTRY_KEY = "basht.attachment.scopes";
export function localStorageRegistry(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = typeof localStorage === "undefined" ? undefined : (() => { try { return localStorage; } catch { return undefined; } })()): ScopeRegistry {
  let failed = 0;
  const read = (): string[] => {
    try {
      const raw = storage?.getItem(REGISTRY_KEY);
      if (raw === null || raw === undefined) return [];
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) { failed++; return []; }
      return v.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{16}$/.test(x));
    } catch { failed++; return []; }
  };
  return {
    read,
    // a scope that could not be recorded (no storage, a full quota) is counted: the registry can no longer be trusted to find everything
    add(scope) {
      try {
        if (!storage) { failed++; return; }
        const all = new Set(read());
        if (!all.has(scope)) { all.add(scope); storage.setItem(REGISTRY_KEY, JSON.stringify([...all])); }
      } catch { failed++; }
    },
    clear() { try { storage?.removeItem(REGISTRY_KEY); } catch { /* the next wipe clears it */ } },
    failures: () => failed,
  };
}

/**
 * Wipes EVERY scope's database (and the unscoped one of earlier builds): sign-out. The scopes found by `indexedDB.databases()` or the
 * registry PLUS every scope this page session opened (`liveScopes`). Each database is cleared (its open retried once);
 * any scope that could not be wiped makes the whole wipe fail, so the leftover warning stays honest.
 */
export async function wipeAllScopes(factory: IDBFactory | undefined, registry: ScopeRegistry, liveScopes: readonly string[] = []): Promise<StoreResult> {
  if (!factory) return fail("absent");
  const names = new Set<string>();
  let listed = false;
  try {
    const dbs = await (factory as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.();
    if (dbs) { listed = true; for (const d of dbs) if (d.name?.startsWith(ATTACHMENT_DB)) names.add(d.name); }
  } catch { /* fall back to the registry */ }
  if (!listed) { names.add(ATTACHMENT_DB); for (const s of registry.read()) names.add(scopedDbName(s)); }
  // every scope this page session has opened or written to is wiped, whatever discovery says
  for (const s of liveScopes) names.add(scopedDbName(s));
  let failed: StoreFailure | null = null;
  for (const name of names) {
    const st = createAttachmentStore(factory, name);
    let r = await st.clear();
    if (!r.ok && r.reason !== "absent") r = await st.clear();
    if (!r.ok && r.reason !== "absent") failed = r.reason;
  }
  if (failed) return fail(failed);
  // Could not be sure: no way to list the databases, and the registry failed to read or record a scope — an earlier session's scope may
  // exist that nothing here can find. That is NOT proof that no scoped data exists, so the wipe is reported as not complete.
  if (!listed && (registry.failures?.() ?? 0) > 0) return fail("unavailable");
  registry.clear();
  return { ok: true, value: undefined };
}

export type ScopedAttachmentStore = AttachmentStore & {
  setScope(scope: string | null): void; scope(): string | null;
  /** Every scope (sign-out). */
  clearAll(): Promise<StoreResult>;
};
/**
 * The store the app uses: one database per owner scope. While the owner is not known (`scope` null) NOTHING is read or written —
 * every call answers `noscope` without touching IndexedDB. A call is bound to the scope it started under, so a save in flight
 * when the owner changes finishes in the OLD owner's database, never the new one's.
 */
export function createScopedStore(factory: IDBFactory | undefined, registry: ScopeRegistry = localStorageRegistry()): ScopedAttachmentStore {
  let scope: string | null = null;
  const stores = new Map<string, AttachmentStore>();
  const forScope = (s: string) => {
    let st = stores.get(s);
    if (!st) { st = createAttachmentStore(factory, scopedDbName(s)); stores.set(s, st); }
    // EVERY use re-registers the scope (idempotent): a wipe empties the registry, and a cached store that is used again afterwards
    // must still be findable by the next wipe where indexedDB.databases() does not exist
    if (factory) registry.add(s);
    return st;
  };
  const via = <A extends unknown[], R>(f: (st: AttachmentStore, ...a: A) => Promise<StoreResult<R>>) => (...a: A): Promise<StoreResult<R>> => {
    const s = scope;
    return s ? f(forScope(s), ...a) : Promise.resolve(fail<R>("noscope"));
  };
  return {
    setScope(next) { scope = next; },
    scope: () => scope,
    put: via((st, rec: AttachmentRecord) => st.put(rec)),
    list: via((st) => st.list()),
    get: via((st, id: string) => st.get(id)),
    patch: via((st, id: string, fields: Parameters<AttachmentStore["patch"]>[1]) => st.patch(id, fields)),
    remove: via((st, id: string) => st.remove(id)),
    usage: via((st) => st.usage()),
    clear: via((st) => st.clear()),
    clearAll: () => wipeAllScopes(factory, registry, [...stores.keys()]),
  };
}

let shared: ScopedAttachmentStore | null = null;
/** The app's store (this browser's IndexedDB, one database per owner scope; every call reports "absent" where there is none). */
export const attachmentStore = (): ScopedAttachmentStore => (shared ??= createScopedStore(typeof indexedDB === "undefined" ? undefined : indexedDB));
/**
 * For sign-out: wipes the local photo copies of EVERY owner scope. True only when nothing is left: the wipe ran, or this browser has no
 * IndexedDB at all (nothing could have been stored). A database that merely failed to OPEN may still hold photos, so that is NOT
 * success — each open is retried once, and a second failure is reported as not cleared.
 */
export const clearAttachments = async (store: AttachmentStore & { clearAll?: () => Promise<StoreResult> } = attachmentStore()): Promise<boolean> => {
  const wipe = () => (store.clearAll ? store.clearAll() : store.clear());
  let r = await wipe();
  if (!r.ok && r.reason !== "absent") r = await wipe();
  return r.ok || r.reason === "absent";
};
