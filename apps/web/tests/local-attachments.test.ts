import { describe, expect, it } from "vitest";
import { createAttachmentStore } from "@/lib/attachment-store";
import { base64ToBlob, createLocalAttachments } from "@/lib/local-attachments";
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
});
