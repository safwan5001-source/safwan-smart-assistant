import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATTACHMENT_DB, clearAttachments, createAttachmentStore, createScopedStore, localStorageRegistry, scopedDbName, wipeAllScopes, type ScopeRegistry } from "@/lib/attachment-store";
import { bindOwnerScope, createLocalAttachments } from "@/lib/local-attachments";
import { getOwnerScope, resetOwnerScopeForTests, setOwnerScope, subscribeOwnerScope } from "@/lib/owner-scope";
import { createAuthClient, parseOwnerScope } from "@/lib/owner-auth";
import { matchAttachments } from "@/lib/attachment-match";
import { fakeIDB } from "./stubs/fake-idb";

const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";
const img = (id: string) => ({ id, name: id + ".jpg", mime: "image/jpeg", size: 4, width: 8, height: 8, blob: new Blob([new Uint8Array(4)], { type: "image/jpeg" }) });
const rec = (id: string) => ({ clientMsgId: id, text: "x", sentAt: 1, images: [img("a")] });
const memRegistry = (): ScopeRegistry & { ids: Set<string> } => { const ids = new Set<string>(); return { ids, read: () => [...ids], add: (s) => void ids.add(s), clear: () => ids.clear() }; };
const setup = () => { const idb = fakeIDB(); const registry = memRegistry(); const scoped = createScopedStore(idb as unknown as IDBFactory, registry); return { idb, registry, scoped }; };
const ids = async (s: { list(): Promise<{ ok: boolean; value?: unknown }> }) => { const l = await s.list() as { ok: boolean; value?: { clientMsgId: string }[] }; return l.ok ? l.value!.map((m) => m.clientMsgId) : "fail"; };
const settle = () => new Promise((r) => setTimeout(r, 30));
afterEach(() => resetOwnerScopeForTests());

describe("per-owner scope of the device-local photo store", () => {
  it("two owners on the same browser: each has its OWN database; one never sees the other's photos", async () => {
    const { idb, scoped } = setup();
    scoped.setScope(A); await scoped.put(rec("a1")); await scoped.put(rec("a2"));
    scoped.setScope(B);
    expect(await ids(scoped)).toEqual([]);                      // B sees nothing of A's
    await scoped.put(rec("b1"));
    expect(await ids(scoped)).toEqual(["b1"]);
    expect(await scoped.get("a1")).toEqual({ ok: true, value: null });
    expect(await scoped.usage()).toEqual({ ok: true, value: { count: 1, bytes: 4 } });
    scoped.setScope(A);
    expect(await ids(scoped)).toEqual(["a1", "a2"]);
    expect([...idb.dbs.keys()].sort()).toEqual([scopedDbName(A), scopedDbName(B)]);
  });

  it("a scope's explicit clear touches ONLY that scope", async () => {
    const { scoped } = setup();
    scoped.setScope(A); await scoped.put(rec("a1")); scoped.setScope(B); await scoped.put(rec("b1"));
    expect((await scoped.clear()).ok).toBe(true);
    expect(await ids(scoped)).toEqual([]);
    scoped.setScope(A);
    expect(await ids(scoped)).toEqual(["a1"]);
  });

  it("owner not known yet (scope null): NOTHING is read or written — IndexedDB is not even opened, and there is no unscoped fallback", async () => {
    const { idb, scoped } = setup();
    const results = [await scoped.put(rec("x")), await scoped.list(), await scoped.get("x"), await scoped.patch("x", { runId: "r" }), await scoped.remove("x"), await scoped.usage(), await scoped.clear()];
    for (const r of results) expect(r).toEqual({ ok: false, reason: "noscope" });
    expect(idb.opens).toBe(0); expect(idb.dbs.size).toBe(0);
    expect(idb.dbs.has(ATTACHMENT_DB)).toBe(false);
  });

  it("sign-out wipes ALL scopes (and the unscoped database of earlier builds), found through indexedDB.databases()", async () => {
    const { idb, scoped } = setup();
    scoped.setScope(A); await scoped.put(rec("a1")); scoped.setScope(B); await scoped.put(rec("b1"));
    await createAttachmentStore(idb as unknown as IDBFactory).put(rec("legacy"));
    expect(await clearAttachments(scoped)).toBe(true);
    for (const s of [A, B]) { scoped.setScope(s); expect(await ids(scoped)).toEqual([]); }
    expect(await ids(createAttachmentStore(idb as unknown as IDBFactory))).toEqual([]);
  });

  it("…and where indexedDB.databases() does not exist, through the registry of scopes this device used", async () => {
    const { idb, registry, scoped } = setup();
    idb.supportsDatabases = false;
    scoped.setScope(A); await scoped.put(rec("a1")); scoped.setScope(B); await scoped.put(rec("b1"));
    expect([...registry.ids].sort()).toEqual([A, B]);
    expect(await clearAttachments(scoped)).toBe(true);
    expect(registry.ids.size).toBe(0);
    for (const s of [A, B]) { scoped.setScope(s); expect(await ids(scoped)).toEqual([]); }
  });

  it("a scope that cannot be wiped makes the whole wipe UNSUCCESSFUL (the leftover warning stays honest), while the other scopes are still wiped; recovery succeeds", async () => {
    const { idb, scoped } = setup();
    scoped.setScope(A); await scoped.put(rec("a1")); scoped.setScope(B); await scoped.put(rec("b1"));
    idb.failNext("DataError", 2);                    // the first scope's wipe fails twice (the retry too)
    const r = await wipeAllScopes(idb as unknown as IDBFactory, memRegistry());
    expect(r.ok).toBe(false);
    const left = (await Promise.all([A, B].map(async (s) => { scoped.setScope(s); return (await ids(scoped) as string[]).length; }))).reduce((n, x) => n + x, 0);
    expect(left).toBe(1);                            // exactly one scope still holds its photo
    expect(await clearAttachments(scoped)).toBe(true); // the next wipe finishes the job
    for (const s of [A, B]) { scoped.setScope(s); expect(await ids(scoped)).toEqual([]); }
  });

  for (const withDatabases of [true, false]) {
    it(`P1: put → clearAll → put → clearAll in ONE page session finds the second photo too (${withDatabases ? "with" : "without"} indexedDB.databases())`, async () => {
      const { idb, registry, scoped } = setup();
      idb.supportsDatabases = withDatabases;
      scoped.setScope(A);
      await scoped.put(rec("first"));
      expect(await clearAttachments(scoped)).toBe(true);
      expect(await ids(scoped)).toEqual([]);
      await scoped.put(rec("second"));                       // the cached store is reused: its scope must be findable again
      if (!withDatabases) expect(registry.ids.has(A)).toBe(true);
      expect(await clearAttachments(scoped)).toBe(true);
      expect(await ids(scoped)).toEqual([]);                 // really gone (not merely reported gone)
      // and a third owner in the same session, then everything again
      scoped.setScope(B); await scoped.put(rec("b-one"));
      expect(await clearAttachments(scoped)).toBe(true);
      for (const s of [A, B]) { scoped.setScope(s); expect(await ids(scoped)).toEqual([]); }
    });
  }

  describe("P2 (registry cannot be saved): the wipe never claims success while scoped photos could remain", () => {
    const storage = (over: Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">> = {}) => {
      const data = new Map<string, string>();
      return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); }, ...over };
    };
    const full = () => storage({ setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } });
    const mk = (st: ReturnType<typeof storage> | undefined, databases: boolean | "rejects") => {
      const idb = fakeIDB(); idb.supportsDatabases = databases === true;
      if (databases === "rejects") { idb.supportsDatabases = true; Object.defineProperty(idb, "databases", { get: () => async () => { throw new Error("boom"); } }); }
      const registry = localStorageRegistry(st);
      return { idb, registry, scoped: createScopedStore(idb as unknown as IDBFactory, registry) };
    };

    it("the reproduction: no databases(), a registry whose setItem throws, put → clearAll: the live-known scope IS wiped and the wipe reports it could not be sure", async () => {
      const { scoped } = mk(full(), false);
      scoped.setScope(A); await scoped.put(rec("a1"));
      const r = await scoped.clearAll();
      expect(await ids(scoped)).toEqual([]);                          // the photo is gone (wiped through the live-known scope)
      expect(r).toEqual({ ok: false, reason: "unavailable" });        // …and sign-out / erase-all will name the photos as a leftover
      expect(await clearAttachments(scoped)).toBe(false);
    });
    it("…also when databases() REJECTS", async () => {
      const { scoped } = mk(full(), "rejects");
      scoped.setScope(A); await scoped.put(rec("a1"));
      expect(await clearAttachments(scoped)).toBe(false);
      expect(await ids(scoped)).toEqual([]);
    });
    it("a browser with no usable localStorage at all (scope cannot be recorded) is the same", async () => {
      const { scoped } = mk(undefined, false);
      scoped.setScope(A); await scoped.put(rec("a1"));
      expect(await clearAttachments(scoped)).toBe(false);
      expect(await ids(scoped)).toEqual([]);
    });
    it("a corrupt registry value is a discovery failure too", async () => {
      const { scoped } = mk(storage({ getItem: () => "{not json" }), false);
      scoped.setScope(A); await scoped.put(rec("a1"));
      expect(await clearAttachments(scoped)).toBe(false);
    });
    it("the live-known scopes are wiped even when the registry would not list them (two owners in one page session)", async () => {
      const { scoped } = mk(full(), false);
      scoped.setScope(A); await scoped.put(rec("a1")); scoped.setScope(B); await scoped.put(rec("b1"));
      await scoped.clearAll();
      for (const sc of [A, B]) { scoped.setScope(sc); expect(await ids(scoped)).toEqual([]); }
    });
    it("happy paths still report success: databases() works (even with a broken registry); a healthy registry works without databases(); a device that stored nothing", async () => {
      const a = mk(full(), true);
      a.scoped.setScope(A); await a.scoped.put(rec("a1"));
      expect(await clearAttachments(a.scoped)).toBe(true); expect(await ids(a.scoped)).toEqual([]);
      const b = mk(storage(), false);
      b.scoped.setScope(A); await b.scoped.put(rec("a1"));
      expect(await clearAttachments(b.scoped)).toBe(true); expect(await ids(b.scoped)).toEqual([]);
      const c = mk(full(), false);                                     // never stored anything: nothing could remain
      expect(await clearAttachments(c.scoped)).toBe(true);
      const d = mk(undefined, false);
      expect(await clearAttachments(d.scoped)).toBe(true);
    });
    it("registry unit: a read of an absent key is not a failure; a throwing setItem, a missing storage and a corrupt value are counted", () => {
      expect(localStorageRegistry(storage()).failures!()).toBe(0);
      const ok = localStorageRegistry(storage()); expect(ok.read()).toEqual([]); ok.add(A); expect(ok.read()).toEqual([A]); expect(ok.failures!()).toBe(0);
      const q = localStorageRegistry(full()); q.add(A); expect(q.failures!()).toBe(1);
      const n = localStorageRegistry(undefined); n.add(A); expect(n.failures!()).toBe(1);
      const c = localStorageRegistry(storage({ getItem: () => "[1" })); c.read(); expect(c.failures!()).toBe(1);
      const w = localStorageRegistry(storage({ getItem: () => '{"not":"a list"}' })); expect(w.read()).toEqual([]); expect(w.failures!()).toBe(1); // valid JSON of the wrong shape
    });
  });

  it("no IndexedDB at all: the wipe counts as done", async () => {
    expect(await wipeAllScopes(undefined, memRegistry())).toEqual({ ok: false, reason: "absent" });
    expect(await clearAttachments(createScopedStore(undefined, memRegistry()))).toBe(true);
  });

  it("a save in flight when the owner changes finishes in the OLD owner's database, never the new one's", async () => {
    const { idb, scoped } = setup();
    scoped.setScope(A);
    const saving = scoped.put(rec("late"));         // bound to scope A when it starts
    scoped.setScope(B);
    await saving;
    expect(await ids(scoped)).toEqual([]);          // B has nothing
    scoped.setScope(A);
    expect(await ids(scoped)).toEqual(["late"]);
    expect(idb.dbs.has(scopedDbName(A))).toBe(true);
  });
});

describe("the manager follows the owner", () => {
  const owner = () => ({ get: getOwnerScope, subscribe: subscribeOwnerScope });
  const make = () => {
    const { idb, registry, scoped } = setup();
    const mgr = createLocalAttachments(scoped);
    bindOwnerScope(scoped, mgr, owner());
    return { idb, registry, scoped, mgr };
  };

  it("unknown owner: a photo sent now stays in MEMORY only (no storage touched), loading reads nothing, and the matcher shows nothing", async () => {
    const { idb, mgr } = make();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    await mgr.load(); await settle();
    expect(idb.opens).toBe(0);
    expect(mgr.getSnapshot().map((e) => [e.clientMsgId, e.persisted])).toEqual([["c1", false]]);
    expect(matchAttachments([{ key: "r1", role: "user", text: "x", at: 1, hasServerMedia: false }], []).matches.size).toBe(0);
  });

  it("owner A's saved photos are read only once A is known; switching to owner B shows none of A's, and back to A shows them again", async () => {
    const { idb, mgr } = make();
    setOwnerScope(A); await settle();
    mgr.register({ clientMsgId: "a1", text: "x", sentAt: 1, images: [img("a")] });
    mgr.attachRun("a1", "run-1"); await settle();
    expect(mgr.getSnapshot()[0].persisted).toBe(true);
    setOwnerScope(B); await settle(); await mgr.load();
    expect(mgr.getSnapshot()).toEqual([]);                          // A's records are gone from memory too
    expect(await mgr.images("a1")).toBeNull();                      // and unreachable on the device
    setOwnerScope(A); await mgr.load(); await settle();
    expect(mgr.getSnapshot().map((e) => e.clientMsgId)).toEqual(["a1"]);
    expect(idb.dbs.has(scopedDbName(A))).toBe(true);
  });

  it("signed out / unknown again: the previous owner's records leave memory and storage is not touched", async () => {
    const { mgr } = make();
    setOwnerScope(A); mgr.register({ clientMsgId: "a1", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    setOwnerScope(null);
    expect(mgr.getSnapshot()).toEqual([]);
  });

  it("memory-only records made before the owner was known are kept (and never written); another owner's persisted ones are dropped", async () => {
    const { idb, mgr } = make();
    mgr.register({ clientMsgId: "early", text: "x", sentAt: 1, images: [img("a")] });
    setOwnerScope(A); await settle();
    expect(mgr.getSnapshot().map((e) => e.clientMsgId)).toEqual(["early"]);
    expect(mgr.getSnapshot()[0].persisted).toBe(false);
    expect(idb.dbs.size).toBe(0);                                   // nothing was written for it, even now
  });

  it("«clear» removes only the current owner's copies; sign-out's clearAll removes every owner's", async () => {
    const { scoped, mgr } = make();
    setOwnerScope(A); mgr.register({ clientMsgId: "a1", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    setOwnerScope(B); mgr.register({ clientMsgId: "b1", text: "x", sentAt: 1, images: [img("b")] }); await settle();
    expect(await mgr.clear()).toBe(true);                           // B's
    scoped.setScope(A); expect(await ids(scoped)).toEqual(["a1"]);
    scoped.setScope(B); expect(await ids(scoped)).toEqual([]);
    expect(await mgr.clearAll()).toBe(true);
    scoped.setScope(A); expect(await ids(scoped)).toEqual([]);
  });

  it("clearAll reports an unsuccessful wipe in ANY scope as false (the leftover report)", async () => {
    const { idb, scoped, mgr } = make();
    setOwnerScope(A); mgr.register({ clientMsgId: "a1", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    scoped.setScope(B); await scoped.put(rec("b1")); scoped.setScope(A);
    idb.dropConnections(); idb.openFails = "error";
    expect(await mgr.clearAll()).toBe(false);
    idb.openFails = null;
    scoped.setScope(B); expect(await ids(scoped)).toEqual(["b1"]);  // really still there
  });

  it("an unknown owner's «clear» is not reported as success (nothing addressable was cleared)", async () => {
    const { mgr } = make();
    expect(await mgr.clear()).toBe(false);
  });
});

describe("owner scope plumbing", () => {
  it("only a well-formed server id counts; anything else means unknown", () => {
    expect(parseOwnerScope("0123456789abcdef")).toBe("0123456789abcdef");
    for (const bad of [null, undefined, 5, "", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../etc/passwd", "g123456789abcdef"]) expect(parseOwnerScope(bad)).toBeNull();
    setOwnerScope("0123456789abcdef"); expect(getOwnerScope()).toBe("0123456789abcdef");
    setOwnerScope("nonsense"); expect(getOwnerScope()).toBeNull();
  });
  it("subscribers hear every real change, none for a repeat", () => {
    let n = 0; subscribeOwnerScope(() => n++);
    setOwnerScope(A); setOwnerScope(A); setOwnerScope(B); setOwnerScope(null); setOwnerScope(null);
    expect(n).toBe(3);
  });
  it("the login gate feeds the scope from every status answer (signed out / not authenticated → unknown)", () => {
    const src = readFileSync(join(resolve(__dirname, ".."), "components/owner-gate.tsx"), "utf8");
    expect(src).toContain("setOwnerScope(s.authenticated ? s.owner_scope : null)");
    expect(src.indexOf("if (s.unavailable) return;")).toBeLessThan(src.indexOf("setOwnerScope("));   // an outage keeps what was known
  });
  it("the status client returns the scope only for an authenticated owner (anything the server sent otherwise is ignored)", async () => {
    const mk = (body: unknown) => createAuthClient((async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
    expect((await mk({ authenticated: true, owner_auth: true, owner_scope: A }).status()).owner_scope).toBe(A);
    expect((await mk({ authenticated: false, owner_auth: true, owner_scope: A }).status()).owner_scope).toBeNull();
    expect((await mk({ authenticated: true, owner_scope: "bad" }).status()).owner_scope).toBeNull();
    const down = createAuthClient((async () => { throw new Error("offline"); }) as typeof fetch);
    expect(await down.status()).toMatchObject({ unavailable: true, owner_scope: null });
  });
});

describe("P2 (erase-all keeps the owner known): a photo sent right after «erase all local data» is persisted in the current scope", () => {
  it("erase-all wipes EVERY scope but leaves the current scope known, so the next photo persists at once (and survives a reload)", async () => {
    const idb = fakeIDB(); const registry = memRegistry(); const scoped = createScopedStore(idb as unknown as IDBFactory, registry);
    const mgr = createLocalAttachments(scoped);
    bindOwnerScope(scoped, mgr, { get: getOwnerScope, subscribe: subscribeOwnerScope });
    setOwnerScope(A);
    mgr.register({ clientMsgId: "before", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    const reader = (scope: string) => { const r = createScopedStore(idb as unknown as IDBFactory, memRegistry()); r.setScope(scope); return r; }; // a separate handle: the app's own store scope is never touched by the test
    await reader(B).put(rec("other-owner"));
    expect(await mgr.clearAll()).toBe(true);                       // what clearPrivateData does (it does NOT touch the owner scope)
    expect(getOwnerScope()).toBe(A); expect(scoped.scope()).toBe(A);
    expect(await ids(reader(B))).toEqual([]);                      // every scope was wiped
    mgr.register({ clientMsgId: "after", text: "y", sentAt: 2, images: [img("b")] }); mgr.attachRun("after", "run-1"); await settle();
    expect(mgr.getSnapshot()[0].persisted).toBe(true);             // persisted immediately, not memory-only
    expect(await ids(reader(A))).toEqual(["after"]);               // and really in A's database
  });
  it("whereas ending the owner's session drops the scope: a photo then stays memory-only and writes nothing", async () => {
    const idb = fakeIDB(); const scoped = createScopedStore(idb as unknown as IDBFactory, memRegistry());
    const mgr = createLocalAttachments(scoped);
    bindOwnerScope(scoped, mgr, { get: getOwnerScope, subscribe: subscribeOwnerScope });
    setOwnerScope(A); await settle();
    setOwnerScope(null);
    mgr.register({ clientMsgId: "x", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    expect(mgr.getSnapshot()[0].persisted).toBe(false);
    expect(idb.dbs.size).toBe(0);                                  // nothing was written anywhere
  });
});
