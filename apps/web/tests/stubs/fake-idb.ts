/**
 * A tiny in-memory IndexedDB double: exactly the subset lib/attachment-store uses (open + upgrade, transaction over several
 * stores, get / getAll / put / delete / clear, complete / error / abort). Transactions are atomic (writes are applied only on
 * commit) and every callback is asynchronous, like the real thing. `failNext` makes the next write transaction abort with a
 * quota (or other) error so the failure paths can be tested.
 */
type Op = () => unknown;
class Req {
  result: unknown; error: unknown = null;
  onsuccess: (() => void) | null = null; onerror: (() => void) | null = null;
}
class Store {
  constructor(public name: string, public keyPath: string, public data = new Map<unknown, unknown>()) {}
}
class Tx {
  oncomplete: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  error: unknown = null;
  private queue: Op[] = []; private done = false; private started = false;
  private work = new Map<string, Map<unknown, unknown>>();
  constructor(private db: Db, names: string[], private mode: string) {
    for (const n of names) { const s = db.stores.get(n); if (!s) throw new DOMException("no such store", "NotFoundError"); this.work.set(n, new Map(s.data)); }
  }
  enqueue(req: Req, op: Op) {
    if (this.done) throw new DOMException("transaction finished", "TransactionInactiveError");
    this.queue.push(() => { try { req.result = op(); req.onsuccess?.(); } catch (e) { req.error = e; req.onerror?.(); this.abortWith(e); } });
    if (!this.started) { this.started = true; setTimeout(() => this.run(), 0); }
  }
  private run() {
    if (this.done) return;
    const next = this.queue.shift();
    if (next) { next(); setTimeout(() => this.run(), 0); return; }
    this.commit();
  }
  private commit() {
    if (this.done) return;
    if (this.mode === "readwrite" && this.db.factory.failures.length) { const f = this.db.factory.failures.shift()!; this.abortWith(new DOMException("full", f)); return; }
    this.done = true;
    if (this.mode === "readwrite") for (const [n, m] of this.work) this.db.stores.get(n)!.data = m;
    this.oncomplete?.();
  }
  abortWith(e: unknown) { if (this.done) return; this.done = true; this.error = e; this.onabort?.(); }
  abort() { this.abortWith(new DOMException("aborted", "AbortError")); }
  data(n: string) { return this.work.get(n)!; }
  readonly = () => this.mode === "readonly";
  objectStore(name: string) {
    const tx: Tx = this as Tx; const s = this.db.stores.get(name)!;
    const key = (v: unknown) => (v as Record<string, unknown>)[s.keyPath];
    const mk = (op: Op) => { const r = new Req(); tx.enqueue(r, op); return r; };
    return {
      get: (k: unknown) => mk(() => tx.data(name).get(k)),
      getAll: () => mk(() => [...tx.data(name).values()]),
      put: (v: unknown) => mk(() => { if (tx.readonly()) throw new DOMException("read only", "ReadOnlyError"); tx.data(name).set(key(v), v); return key(v); }),
      delete: (k: unknown) => mk(() => { if (tx.readonly()) throw new DOMException("read only", "ReadOnlyError"); tx.data(name).delete(k); }),
      clear: () => mk(() => { if (tx.readonly()) throw new DOMException("read only", "ReadOnlyError"); tx.data(name).clear(); }),
    };
  }
}
class Db {
  stores = new Map<string, Store>(); version = 0; closed = false;
  onversionchange: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(public factory: FakeIDB) {}
  get objectStoreNames() { return { contains: (n: string) => this.stores.has(n) }; }
  createObjectStore(name: string, opts: { keyPath: string }) { const s = new Store(name, opts.keyPath); this.stores.set(name, s); return s; }
  transaction(names: string | string[], mode: "readonly" | "readwrite" = "readonly") {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    return new Tx(this, Array.isArray(names) ? names : [names], mode);
  }
  close() { this.closed = true; }
}
export class FakeIDB {
  dbs = new Map<string, Db>();
  /** The next write transactions abort with these DOMException names (e.g. "QuotaExceededError"), one each. */
  failures: string[] = [];
  /** `open` itself fails (private mode / blocked): "throw" throws synchronously, "error" fires onerror. */
  openFails: "throw" | "error" | null = null;
  /** The next N opens fail (then the database opens normally again): a TEMPORARY failure. */
  failOpens = 0;
  opens = 0;
  /** `indexedDB.databases()` exists (Chrome, Safari 14+); false simulates a browser without it. */
  supportsDatabases = true;
  get databases() { return this.supportsDatabases ? async () => [...this.dbs.keys()].map((name) => ({ name, version: 1 })) : undefined; }
  failNext(name = "QuotaExceededError", times = 1) { for (let i = 0; i < times; i++) this.failures.push(name); }
  open(name: string, version = 1) {
    this.opens++;
    if (this.openFails === "throw") throw new DOMException("denied", "SecurityError");
    const transient = this.failOpens > 0; if (transient) this.failOpens--;
    const req = { result: undefined as unknown as Db, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null, onblocked: null as (() => void) | null };
    setTimeout(() => {
      if (transient) { req.error = new DOMException("busy", "UnknownError"); req.onerror?.(); return; }
      if (this.openFails === "error") { req.error = new DOMException("denied", "SecurityError"); req.onerror?.(); return; }
      let db = this.dbs.get(name);
      const fresh = !db;
      if (!db) { db = new Db(this); this.dbs.set(name, db); }
      db.closed = false;
      req.result = db;
      if (fresh || db.version < version) { db.version = version; req.onupgradeneeded?.(); }
      req.onsuccess?.();
    }, 0);
    return req;
  }
  /** The browser closed the connection WITHOUT telling the app (no close event): the next transaction() throws InvalidStateError. */
  silentDrop() { for (const d of this.dbs.values()) d.closed = true; }
  /** Simulates the browser closing the connection under the app (storage eviction, another tab upgrading). */
  dropConnections() { for (const d of this.dbs.values()) { d.closed = true; d.onclose?.(); } }
}
export const fakeIDB = () => new FakeIDB();
