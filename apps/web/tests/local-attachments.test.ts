import { describe, expect, it } from "vitest";
import { createAttachmentStore } from "@/lib/attachment-store";
import { base64ToBlob, createLocalAttachments, sendWithLocalCopy } from "@/lib/local-attachments";
import { fakeIDB } from "./stubs/fake-idb";

const img = (id: string) => ({ id, name: id + ".jpg", mime: "image/jpeg", size: 3, width: 10, height: 20, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) });
const settle = () => new Promise((r) => setTimeout(r, 30));
const setup = (idb = fakeIDB()) => { const store = createAttachmentStore(idb as unknown as IDBFactory); return { idb, store, mgr: createLocalAttachments(store) }; };

describe("local attachments (in-memory index over the device store)", () => {
  it("base64ToBlob returns the same bytes that were sent", async () => {
    const b = base64ToBlob(btoa(String.fromCharCode(1, 2, 3, 250)), "image/jpeg");
    expect(b.type).toBe("image/jpeg");
    expect([...new Uint8Array(await b.arrayBuffer())]).toEqual([1, 2, 3, 250]);
  });

  it("register is known at once (sync), is saved in the background, and run id / matched row are persisted after it", async () => {
    const { store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "شوف", sentAt: 100, images: [img("a")] });
    expect(mgr.getSnapshot().map((e) => [e.clientMsgId, e.persisted])).toEqual([["c1", false]]); // synchronous, not yet saved
    mgr.attachRun("c1", "run-1"); mgr.bind("c1", "row-1");
    await settle();
    expect(mgr.getSnapshot()[0]).toMatchObject({ persisted: true, runId: "run-1", matchedRowId: "row-1" });
    const l = await store.list();
    expect(l.ok && l.value[0]).toMatchObject({ clientMsgId: "c1", runId: "run-1", matchedRowId: "row-1" });
  });

  it("survives a reload: a new manager over the same device store reads the records back (with the bytes on demand)", async () => {
    const { idb, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 100, images: [img("a")] });
    mgr.attachRun("c1", "run-1");
    await settle();
    const reopened = createLocalAttachments(createAttachmentStore(idb as unknown as IDBFactory));
    expect(reopened.getSnapshot()).toEqual([]);
    await reopened.load();
    expect(reopened.getSnapshot()).toHaveLength(1);
    expect(reopened.getSnapshot()[0]).toMatchObject({ clientMsgId: "c1", runId: "run-1", persisted: true });
    const imgs = await reopened.images("c1");
    expect(imgs?.map((i) => i.id)).toEqual(["a"]);
    expect(imgs && [...new Uint8Array(await imgs[0].blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("IndexedDB unavailable (private mode): everything keeps working from memory for this session", async () => {
    const idb = fakeIDB(); idb.openFails = "throw";
    const { mgr } = setup(idb);
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 100, images: [img("a")] });
    mgr.attachRun("c1", "run-1"); mgr.bind("c1", "row-1");
    await settle();
    expect(mgr.getSnapshot()[0]).toMatchObject({ persisted: false, runId: "run-1", matchedRowId: "row-1" });
    expect((await mgr.images("c1"))?.map((i) => i.id)).toEqual(["a"]); // the preview is still there
    await mgr.load(); // loading from an unavailable store changes nothing
    expect(mgr.getSnapshot()).toHaveLength(1);
  });

  it("quota exceeded: the photo stays in memory, the app is unaffected, and nothing already saved is evicted", async () => {
    const { idb, store, mgr } = setup();
    mgr.register({ clientMsgId: "old", text: "x", sentAt: 1, images: [img("a")] });
    await settle();
    idb.failNext("QuotaExceededError");
    mgr.register({ clientMsgId: "new", text: "y", sentAt: 2, images: [img("b")] });
    await settle();
    const byId = Object.fromEntries(mgr.getSnapshot().map((e) => [e.clientMsgId, e.persisted]));
    expect(byId).toEqual({ old: true, new: false });
    expect((await mgr.images("new"))?.length).toBe(1);
    const l = await store.list();
    expect(l.ok && l.value.map((m) => m.clientMsgId)).toEqual(["old"]);
  });

  it("discard (the engine refused the turn) forgets the copy, in memory and on the device", async () => {
    const { store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    mgr.discard("c1");
    await settle();
    expect(mgr.getSnapshot()).toEqual([]);
    expect(await store.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } });
    mgr.discard("never-existed"); // harmless
  });

  it("a record created before load() finishes is not overwritten by it; usage and clear work", async () => {
    const { idb, store } = setup();
    await store.put({ clientMsgId: "old", text: "o", sentAt: 1, images: [img("a")] });
    const mgr = createLocalAttachments(createAttachmentStore(idb as unknown as IDBFactory));
    mgr.register({ clientMsgId: "new", text: "n", sentAt: 2, images: [img("b")] });
    await mgr.load(); await settle();
    expect(mgr.getSnapshot().map((e) => e.clientMsgId).sort()).toEqual(["new", "old"]);
    expect(await mgr.usage()).toEqual({ count: 2, bytes: 6 });
    expect(await mgr.clear()).toBe(true);
    expect(mgr.getSnapshot()).toEqual([]);
    expect(await mgr.usage()).toEqual({ count: 0, bytes: 0 });
  });

  it("notifies subscribers on every change", async () => {
    const { mgr } = setup();
    let n = 0; const off = mgr.subscribe(() => n++);
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    const afterRegister = n;
    mgr.attachRun("c1", "r");
    expect(n).toBeGreaterThan(afterRegister);
    off();
  });

  it("markDone / supersede / unbind are remembered (memory and device)", async () => {
    const { store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    mgr.attachRun("c1", "run-1"); mgr.bind("c1", "row-1");
    await settle();
    mgr.markDone("run-1"); mgr.supersede("c1");
    await settle();
    expect(mgr.getSnapshot()[0]).toMatchObject({ runDone: true, superseded: true, matchedRowId: "row-1" });
    mgr.unbind("c1");
    await settle();
    expect("matchedRowId" in mgr.getSnapshot()[0]).toBe(false);
    const l = await store.list();
    expect(l.ok && l.value[0]).toMatchObject({ runDone: true, superseded: true });
    expect(l.ok && "matchedRowId" in l.value[0]).toBe(false);
    mgr.markDone("no-such-run"); // harmless
  });

  it("a save that completes AFTER sign-out's clear never resurrects its record (memory or device)", async () => {
    const { store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    const cleared = mgr.clear(); // the owner signs out while the save is still in flight
    await cleared; await settle();
    expect(mgr.getSnapshot()).toEqual([]);
    expect(await store.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } });
    mgr.register({ clientMsgId: "c2", text: "y", sentAt: 2, images: [img("b")] }); // a new session's record is kept
    await settle();
    expect(await store.usage()).toEqual({ ok: true, value: { count: 1, bytes: 3 } });
  });

  it("the save is not even STARTED after a clear, and one already in flight is undone (each guard on its own)", async () => {
    const idb = fakeIDB(); const real = createAttachmentStore(idb as unknown as IDBFactory);
    let puts = 0; let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const slow = { ...real, put: async (rec: Parameters<typeof real.put>[0]) => { puts++; await gate; return real.put(rec); } };
    const mgr = createLocalAttachments(slow);
    mgr.register({ clientMsgId: "early", text: "x", sentAt: 1, images: [img("a")] });
    await settle(); // the save is in flight, held at the gate
    expect(puts).toBe(1);
    const cleared = mgr.clear();
    open(); await cleared; await settle();
    expect(await real.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } }); // the in-flight save did not resurrect "early"
    const startedAfterClear = createLocalAttachments(slow);
    const before = puts;
    startedAfterClear.register({ clientMsgId: "z", text: "z", sentAt: 3, images: [img("c")] });
    void startedAfterClear.clear(); // clear() in the same tick as register(): the chained save must see the new generation and not start
    await settle();
    expect(puts).toBe(before);
  });

  it("clear() is NOT successful when the database could not be opened after photos were saved (and says so for the leftovers report)", async () => {
    const { idb, store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    await settle();
    idb.dropConnections(); idb.openFails = "error";
    expect(await mgr.clear()).toBe(false);
    const { wipeLeftovers } = await import("@/lib/sign-out");
    expect(wipeLeftovers({ filesCleared: true, serverErased: true, attachmentsCleared: false }).join(" ")).toContain("الصور");
    idb.openFails = null;
    const l = await store.list();
    expect(l.ok && l.value.map((m) => m.clientMsgId)).toEqual(["c1"]); // still on the device
  });
  it("clear() recovers from a temporary open failure (one retry) and from a browser with no IndexedDB (nothing stored)", async () => {
    const { idb, store, mgr } = setup();
    mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] });
    await settle();
    idb.dropConnections(); idb.failOpens = 1;
    expect(await mgr.clear()).toBe(true);
    expect(await store.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } });
    expect(await createLocalAttachments(createAttachmentStore(undefined)).clear()).toBe(true);
  });

  it("a load that finishes after the clear does not bring old records back", async () => {
    const { idb, store } = setup();
    await store.put({ clientMsgId: "old", text: "o", sentAt: 1, images: [img("a")] });
    const mgr = createLocalAttachments(createAttachmentStore(idb as unknown as IDBFactory));
    const loading = mgr.load();
    await mgr.clear();
    await loading; await settle();
    expect(mgr.getSnapshot()).toEqual([]);
  });
});

describe("sendWithLocalCopy: one owner turn with photos", () => {
  it("registers before the request, ties the copy to the run once accepted, and a retry supersedes the failed attempt it replaces", async () => {
    const { mgr } = setup();
    let seenDuringPost: string[] = [];
    const first = await sendWithLocalCopy(mgr, { text: "شوف", images: [img("a")], now: () => 111, post: async () => { seenDuringPost = mgr.getSnapshot().map((e) => e.clientMsgId); return "run-1"; } });
    expect(seenDuringPost).toEqual([first.clientMsgId]); // known before the request returns
    expect(mgr.getSnapshot()[0]).toMatchObject({ runId: "run-1", sentAt: 111, text: "شوف" });
    const retry = await sendWithLocalCopy(mgr, { text: "شوف", images: [img("a")], supersedes: first.clientMsgId, post: async () => "run-2" });
    const by = Object.fromEntries(mgr.getSnapshot().map((e) => [e.clientMsgId, e]));
    expect(by[first.clientMsgId].superseded).toBe(true);
    expect(by[retry.clientMsgId].superseded).toBeFalsy();
  });
  it("the engine REFUSING the turn discards the device copy (nothing was sent) and rethrows the error", async () => {
    const { store, mgr } = setup();
    await expect(sendWithLocalCopy(mgr, { text: "x", images: [img("a")], post: async () => { throw new Error("busy"); } })).rejects.toThrow("busy");
    await settle();
    expect(mgr.getSnapshot()).toEqual([]);
    expect(await store.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } });
  });
  it("a refused RETRY leaves the failed attempt it would have replaced exactly as it was", async () => {
    const { mgr } = setup();
    const first = await sendWithLocalCopy(mgr, { text: "x", images: [img("a")], post: async () => "run-1" });
    await expect(sendWithLocalCopy(mgr, { text: "x", images: [img("a")], supersedes: first.clientMsgId, post: async () => { throw new Error("no"); } })).rejects.toThrow();
    expect(mgr.getSnapshot().map((e) => [e.clientMsgId, !!e.superseded])).toEqual([[first.clientMsgId, false]]);
  });
});
