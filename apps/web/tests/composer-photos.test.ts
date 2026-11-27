import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createComposerPhotos, createTurnPreviews } from "@/lib/composer-photos";
import type { Codec } from "@/lib/image-prep";

/** A codec whose decode waits for `gate` (to act while preparation runs); each preview URL is unique. */
function gatedCodec() {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let n = 0;
  const codec: Codec = {
    decode: async () => { await gate; return { width: 100, height: 100, source: {} }; },
    encode: async () => ({ size: 1000, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(1000) }) as unknown as Blob,
    previewUrl: () => `blob:p${++n}`,
  };
  return { codec, open };
}
const pic = (name = "a.jpg") => Object.assign(new Blob([new Uint8Array(10)], { type: "image/jpeg" }), { name });
const readyCodec = () => { const c = gatedCodec(); c.open(); return c.codec; };

describe("composer photos (review: state reconciled with the latest, previews revoked)", () => {
  it("remove during preparation, then the batch lands: the removed photo does not come back", async () => {
    const revoked: string[] = [];
    let open!: () => void; let gated = false;
    const gate = new Promise<void>((r) => { open = r; });
    let n = 0;
    const codec: Codec = {
      decode: async () => { if (gated) await gate; return { width: 100, height: 100, source: {} }; },
      encode: async () => ({ size: 1000, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(1000) }) as unknown as Blob,
      previewUrl: () => `blob:p${++n}`,
    };
    const s = createComposerPhotos({ codec, revoke: (u) => revoked.push(u) });
    await s.take([pic("first.jpg")]).done;
    const first = s.getSnapshot().images[0];
    gated = true;
    const batch = s.take([pic("second.jpg"), pic("third.jpg")]);
    expect(s.getSnapshot().preparing).toBe(2);
    s.remove(first.id); // while the batch is still being prepared
    open();
    await batch.done;
    const names = s.getSnapshot().images.map((i) => i.name);
    expect(names).toEqual(["second.jpg", "third.jpg"]);
    expect(s.getSnapshot().images.some((i) => i.id === first.id)).toBe(false);
    expect(revoked).toEqual([first.previewUrl]);
    expect(s.getSnapshot().preparing).toBe(0);
  });

  it("two batches picked back to back are both kept, in order", async () => {
    const s = createComposerPhotos({ codec: readyCodec(), revoke: () => {} });
    const a = s.take([pic("1.jpg"), pic("2.jpg")]); const b = s.take([pic("3.jpg")]);
    await Promise.all([a.done, b.done]);
    expect(s.getSnapshot().images.map((i) => i.name)).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
  });

  it("the 8-image cap counts photos still being prepared", async () => {
    const s = createComposerPhotos({ codec: readyCodec(), revoke: () => {} });
    const first = s.take(Array.from({ length: 7 }, (_, i) => pic(`${i}.jpg`)));
    const over = s.take([pic("8.jpg"), pic("9.jpg")]); // 7 pending + 2 > 8
    await first.done; await over.done;
    expect(s.getSnapshot().images).toHaveLength(7);
    expect(s.getSnapshot().error).toMatch(/8 صور/);
    const rest = s.take([Object.assign(new Blob([new Uint8Array(4)], { type: "application/pdf" }), { name: "a.pdf" })]); // documents pass through
    expect(rest.rest).toHaveLength(1);
  });

  it("handOff keeps the previews alive for the turn; dispose revokes what is still waiting and late results", async () => {
    const revoked: string[] = [];
    const s = createComposerPhotos({ codec: readyCodec(), revoke: (u) => revoked.push(u) });
    await s.take([pic()]).done;
    const sent = s.handOff();
    expect(sent).toHaveLength(1); expect(revoked).toEqual([]); expect(s.getSnapshot().images).toEqual([]);
    await s.take([pic("waiting.jpg")]).done;
    const waiting = s.getSnapshot().images[0].previewUrl;
    s.dispose();
    expect(revoked).toEqual([waiting]);
  });

  it("turn previews: revoked once the turn no longer needs them (done / replaced), kept for a retry of the same photos", () => {
    const revoked: string[] = [];
    const t = createTurnPreviews((u) => revoked.push(u));
    t.adopt(["blob:a", "blob:b"]);
    t.release(["blob:a", "blob:b"], ["blob:a", "blob:b"]); // retry with the same photos
    expect(revoked).toEqual([]);
    t.release(["blob:a", "blob:b"]); // the turn finished
    expect(revoked).toEqual(["blob:a", "blob:b"]);
    t.release(["blob:a"]); // never twice
    expect(revoked).toHaveLength(2); expect(t.size()).toBe(0);
  });

  it("use-basht hands sent previews to turnPreviews and releases them when the turn is done, replaced or reset", () => {
    const src = readFileSync(new URL("../features/chat/use-basht.ts", import.meta.url), "utf8");
    expect(src).toMatch(/turnPreviews\.adopt\(urlsOf\(lastTurn\)\)/);
    expect(src).toMatch(/if \(prev\) turnPreviews\.release\(urlsOf\(prev\), urlsOf\(lastTurn\)\)/);
    expect(src).toMatch(/await finish\(\);\s*if \(finished\) turnPreviews\.release\(urlsOf\(finished\)\);/);
    expect(src).toMatch(/turnPreviews\.release\(urlsOf\(lastTurn\)\); lastTurn = null;/);
    const composer = readFileSync(new URL("../features/chat/composer-images.tsx", import.meta.url), "utf8");
    expect(composer).toMatch(/return \(\) => store\.dispose\(\);/);
  });

  // Review (Codex, round 3)
  it("survives React replaying effect cleanup + setup (StrictMode): photos picked afterwards are kept", async () => {
    const revoked: string[] = [];
    const s = createComposerPhotos({ codec: readyCodec(), revoke: (u) => revoked.push(u) });
    s.dispose(); s.activate(); // what the composer's effect does on a replayed mount
    await s.take([pic("after.jpg")]).done;
    expect(s.getSnapshot().images.map((i) => i.name)).toEqual(["after.jpg"]);
    expect(s.getSnapshot().preparing).toBe(0);
    expect(revoked).toEqual([]);
    const composer = readFileSync(new URL("../features/chat/composer-images.tsx", import.meta.url), "utf8");
    expect(composer).toMatch(/useEffect\(\(\) => \{ store\.activate\(\); return \(\) => store\.dispose\(\); \}, \[store\]\)/);
  });

  it("hand-off after a send takes only the photos sent with it; one attached meanwhile stays (and is not revoked)", async () => {
    const revoked: string[] = [];
    const s = createComposerPhotos({ codec: readyCodec(), revoke: (u) => revoked.push(u) });
    await s.take([pic("sent.jpg")]).done;
    const sent = s.getSnapshot().images.map((i) => i.id);
    await s.take([pic("meanwhile.jpg")]).done; // attached while basht.send was awaiting the server
    const handed = s.handOff(sent);
    expect(handed.map((i) => i.name)).toEqual(["sent.jpg"]);
    expect(s.getSnapshot().images.map((i) => i.name)).toEqual(["meanwhile.jpg"]);
    expect(revoked).toEqual([]);
    const chat = readFileSync(new URL("../features/chat/chat-screen.tsx", import.meta.url), "utf8");
    expect(chat).toMatch(/await basht\.send\(text, photos\); setDraft\(""\); pics\.clear\(photos\.map\(\(p\) => p\.id\)\);/);
  });
});
