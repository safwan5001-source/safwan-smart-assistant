import { describe, expect, it } from "vitest";
import { createAttachmentStore, type StoredImage } from "@/lib/attachment-store";
import { createImageViews, pendingState, rowLocalState } from "@/lib/local-image-views";
import { createLocalAttachments } from "@/lib/local-attachments";
import { fakeIDB } from "./stubs/fake-idb";

const img = (id: string): StoredImage => ({ id, name: id + ".jpg", mime: "image/jpeg", size: 3, width: 10, height: 20, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) });
const tick = () => new Promise((r) => setTimeout(r, 15));
function urls() { const made: string[] = [], revoked: string[] = []; let n = 0; return { made, revoked, createUrl: () => { const u = "blob:t/" + ++n; made.push(u); return u; }, revokeUrl: (u: string) => { revoked.push(u); } }; }
/** An image source whose reads are held until the test lets them go (a slow device read). */
function slowSource() {
  const waiting = new Map<string, (v: StoredImage[] | null | Error) => void>();
  return { waiting, images: (id: string) => new Promise<StoredImage[] | null>((res, rej) => waiting.set(id, (v) => (v instanceof Error ? rej(v) : res(v)))) };
}

describe("device photos of the records on screen: loading → ready | failed", () => {
  it("the FIRST render of a matched row is «loading» (nothing known yet), never «unavailable»; then ready", async () => {
    const src = slowSource(); const u = urls();
    const v = createImageViews(src, u);
    const matches = new Map([["row-1", "c1"]]);
    // first render, before the effect even ran: nothing is known → loading
    expect(rowLocalState(matches, v.getSnapshot())).toMatchObject({ loadingRows: new Set(["row-1"]), failedRows: new Set() });
    expect(rowLocalState(matches, v.getSnapshot()).byRow.size).toBe(0);
    v.want(["c1"]);
    expect(rowLocalState(matches, v.getSnapshot()).loadingRows.has("row-1")).toBe(true); // the read is slow: still loading
    src.waiting.get("c1")!([img("a")]);
    await tick();
    const s = rowLocalState(matches, v.getSnapshot());
    expect(s.loadingRows.size).toBe(0); expect(s.failedRows.size).toBe(0);
    expect(s.byRow.get("row-1")?.map((i) => [i.id, i.url])).toEqual([["c1:a", "blob:t/1"]]);
  });

  it("a read that returns nothing or throws becomes a deliberate FAILED state, with a notification (no empty bubble, no endless shimmer)", async () => {
    for (const result of [null, [], new Error("idb broke")] as const) {
      const src = slowSource(); const v = createImageViews(src, urls());
      let notified = 0; v.subscribe(() => notified++);
      v.want(["c1"]);
      src.waiting.get("c1")!(result as StoredImage[] | null | Error);
      await tick();
      expect(v.getSnapshot().get("c1")).toEqual({ status: "failed" });
      expect(notified).toBeGreaterThan(0);
      expect(rowLocalState(new Map([["row-1", "c1"]]), v.getSnapshot()).failedRows.has("row-1")).toBe(true);
      const p = pendingState([{ clientMsgId: "c1", text: "", sentAt: 1 }], v.getSnapshot());
      expect(p[0].status).toBe("failed"); expect(p[0].images).toEqual([]); // the pending bubble can end its shimmer with an honest placeholder
    }
  });

  it("pending bubbles: loading → ready with their images", async () => {
    const src = slowSource(); const v = createImageViews(src, urls());
    const pend = [{ clientMsgId: "c1", text: "شوف", sentAt: 5 }];
    expect(pendingState(pend, v.getSnapshot())[0]).toMatchObject({ status: "loading", images: [] });
    v.want(["c1"]); src.waiting.get("c1")!([img("a"), img("b")]); await tick();
    const p = pendingState(pend, v.getSnapshot())[0];
    expect(p.status).toBe("ready"); expect(p.images).toHaveLength(2);
  });

  it("works against the real store through the manager: a record the device no longer has fails; one it has is ready", async () => {
    const idb = fakeIDB(); const store = createAttachmentStore(idb as unknown as IDBFactory);
    const mgr = createLocalAttachments(store);
    mgr.register({ clientMsgId: "have", text: "x", sentAt: 1, images: [img("a")] });
    await tick(); await tick();
    const v = createImageViews(mgr, urls());
    v.want(["have", "gone"]);
    await tick(); await tick();
    expect(v.getSnapshot().get("have")?.status).toBe("ready");
    expect(v.getSnapshot().get("gone")).toEqual({ status: "failed" });
  });

  it("a record that leaves the screen has its URLs revoked; a read that lands after it left is dropped (and its URLs revoked)", async () => {
    const src = slowSource(); const u = urls();
    const v = createImageViews(src, u);
    v.want(["c1"]); src.waiting.get("c1")!([img("a")]); await tick();
    expect(u.made).toEqual(["blob:t/1"]);
    v.want([]); // left the screen
    expect(u.revoked).toEqual(["blob:t/1"]);
    expect(v.getSnapshot().has("c1")).toBe(false);
    v.want(["c2"]); v.want([]); // c2's read is still in flight when it leaves
    src.waiting.get("c2")!([img("b")]); await tick();
    expect(v.getSnapshot().has("c2")).toBe(false);
    expect(u.made).toEqual(["blob:t/1"]); expect(u.revoked).toEqual(["blob:t/1"]); // the late images never even get a URL: nothing leaks
    v.want(["c1"]); src.waiting.get("c1")!([img("a")]); await tick(); // back on screen: loaded again (a fresh URL)
    expect(v.getSnapshot().get("c1")?.status).toBe("ready");
    v.dispose();
    expect(v.getSnapshot().size).toBe(0);
  });

  it("each record is read once however often it is asked for", async () => {
    let reads = 0;
    const v = createImageViews({ images: async () => { reads++; return [img("a")]; } }, urls());
    v.want(["c1"]); v.want(["c1"]); v.want(["c1", "c1"]); await tick();
    expect(reads).toBe(1);
  });
});
