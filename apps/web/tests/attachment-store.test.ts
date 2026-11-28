import { describe, expect, it } from "vitest";
import { ATTACHMENT_DB, clearAttachments, createAttachmentStore, type AttachmentRecord } from "@/lib/attachment-store";
import { fakeIDB } from "./stubs/fake-idb";

const img = (id: string, n = 4) => ({ id, name: `${id}.jpg`, mime: "image/jpeg", size: n, width: 800, height: 600, blob: new Blob([new Uint8Array(n).fill(7)], { type: "image/jpeg" }) });
const rec = (id: string, extra: Partial<AttachmentRecord> = {}): AttachmentRecord => ({ clientMsgId: id, text: "شوف الصورة", sentAt: 1_700_000_000_000, images: [img("a", 10), img("b", 20)], ...extra });
const make = () => { const f = fakeIDB(); return { f, store: createAttachmentStore(f as unknown as IDBFactory) }; };
const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

describe("attachment store (IndexedDB, own database)", () => {
  it("round trip: put → list (metadata only, cheap) → get (with the photo bytes)", async () => {
    const { f, store } = make();
    expect((await store.put(rec("m1"))).ok).toBe(true);
    expect(f.dbs.has(ATTACHMENT_DB)).toBe(true);
    const l = await store.list();
    expect(l.ok && l.value).toHaveLength(1);
    if (l.ok) {
      expect(l.value[0]).toMatchObject({ clientMsgId: "m1", text: "شوف الصورة", sentAt: 1_700_000_000_000 });
      expect(l.value[0].images.map((i) => [i.id, i.name, i.mime, i.size, i.width, i.height])).toEqual([["a", "a.jpg", "image/jpeg", 10, 800, 600], ["b", "b.jpg", "image/jpeg", 20, 800, 600]]);
      expect(JSON.stringify(l.value[0])).not.toContain("blob"); // the listing never carries bytes
    }
    const g = await store.get("m1");
    expect(g.ok && g.value?.images.map((i) => i.id)).toEqual(["a", "b"]);
    if (g.ok && g.value) expect(await bytes(g.value.images[0].blob)).toEqual(Array(10).fill(7));
    const none = await store.get("nope");
    expect(none).toEqual({ ok: true, value: null });
  });

  it("patch fills runId / matchedRowId into an existing record; a missing record is not an error", async () => {
    const { store } = make();
    await store.put(rec("m1"));
    expect((await store.patch("m1", { runId: "run-1" })).ok).toBe(true);
    expect((await store.patch("m1", { matchedRowId: "row-9" })).ok).toBe(true);
    const l = await store.list();
    expect(l.ok && l.value[0]).toMatchObject({ runId: "run-1", matchedRowId: "row-9", text: "شوف الصورة" });
    expect((await store.patch("ghost", { runId: "x" })).ok).toBe(true);
    expect((await store.list() as { value: unknown[] }).value).toHaveLength(1);
  });

  it("remove deletes one record and its bytes, nothing else; usage reports count and bytes; clear empties", async () => {
    const { f, store } = make();
    await store.put(rec("m1")); await store.put(rec("m2", { images: [img("c", 5)] }));
    expect(await store.usage()).toEqual({ ok: true, value: { count: 2, bytes: 35 } });
    await store.remove("m1");
    expect(await store.usage()).toEqual({ ok: true, value: { count: 1, bytes: 5 } });
    const blobs = () => f.dbs.get(ATTACHMENT_DB)!.stores.get("blobs")!.data;
    expect([...blobs().keys()]).toEqual(["m2#c"]);
    await store.clear();
    expect(await store.usage()).toEqual({ ok: true, value: { count: 0, bytes: 0 } });
    expect(blobs().size).toBe(0);
  });

  it("never evicts by itself: many large records all stay (the cache has no cap and no age limit)", async () => {
    const { store } = make();
    for (let i = 0; i < 60; i++) await store.put(rec("m" + i, { sentAt: 1 + i, images: [img("x", 5000)] }));
    expect(await store.usage()).toEqual({ ok: true, value: { count: 60, bytes: 300_000 } });
  });

  it("survives a reopen (new store instance over the same database)", async () => {
    const f = fakeIDB();
    await createAttachmentStore(f as unknown as IDBFactory).put(rec("m1"));
    const again = await createAttachmentStore(f as unknown as IDBFactory).list();
    expect(again.ok && again.value.map((m) => m.clientMsgId)).toEqual(["m1"]);
  });

  describe("failure modes (the app keeps working: every call resolves)", () => {
    it("no IndexedDB at all → unavailable, never a throw", async () => {
      const s = createAttachmentStore(undefined);
      for (const r of [await s.put(rec("m1")), await s.list(), await s.get("m1"), await s.patch("m1", { runId: "r" }), await s.remove("m1"), await s.usage(), await s.clear()])
        expect(r).toEqual({ ok: false, reason: "unavailable" });
      expect(await clearAttachments(s)).toBe(true); // nothing to wipe where there is no store
    });
    it("open throws (private mode) or errors → unavailable; a later call retries the open", async () => {
      const { f, store } = make();
      f.openFails = "throw";
      expect(await store.put(rec("m1"))).toEqual({ ok: false, reason: "unavailable" });
      f.openFails = "error";
      expect(await store.list()).toEqual({ ok: false, reason: "unavailable" });
      f.openFails = null;
      expect((await store.put(rec("m1"))).ok).toBe(true);
      expect(f.opens).toBe(3);
    });
    it("a full disk (QuotaExceededError) is reported as quota, nothing is half-written, and the next write still works", async () => {
      const { f, store } = make();
      await store.put(rec("keep"));
      f.failNext("QuotaExceededError");
      expect(await store.put(rec("big"))).toEqual({ ok: false, reason: "quota" });
      const l = await store.list();
      expect(l.ok && l.value.map((m) => m.clientMsgId)).toEqual(["keep"]); // atomic: the failed record left nothing behind, and nothing was evicted
      expect((await store.put(rec("next"))).ok).toBe(true);
    });
    it("another failure is reported as error (not quota); a dropped connection is reopened", async () => {
      const { f, store } = make();
      await store.put(rec("m1"));
      f.failNext("UnknownError");
      expect(await store.put(rec("m2"))).toEqual({ ok: false, reason: "error" });
      f.dropConnections();
      const l = await store.list();
      expect(l.ok && l.value.map((m) => m.clientMsgId)).toEqual(["m1"]);
    });
    it("clearAttachments reports false when the wipe itself failed", async () => {
      const { f, store } = make();
      await store.put(rec("m1"));
      f.failNext("UnknownError");
      expect(await clearAttachments(store)).toBe(false);
      expect(await clearAttachments(store)).toBe(true);
    });
  });
});
