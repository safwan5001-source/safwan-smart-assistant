import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DevicePhotosPanel, devicePhotosLine } from "@/features/settings/device-photos";
import { clearDevicePhotos, DEVICE_PHOTOS_TEXT as T, readDevicePhotos } from "@/lib/device-photos";
import { createScopedStore, type ScopeRegistry } from "@/lib/attachment-store";
import { bindOwnerScope, createLocalAttachments } from "@/lib/local-attachments";
import { getOwnerScope, resetOwnerScopeForTests, setOwnerScope, subscribeOwnerScope } from "@/lib/owner-scope";
import { createImageViews, rowLocalState } from "@/lib/local-image-views";
import { matchAttachments, type MatchRow } from "@/lib/attachment-match";
import { engineRowView } from "@/lib/engine-row";
import { parseVoiceNote } from "@/lib/basht-voice";
import { fakeIDB } from "./stubs/fake-idb";

const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";
const img = (id: string, n = 2048) => ({ id, name: id + ".jpg", mime: "image/jpeg", size: n, width: 8, height: 8, blob: new Blob([new Uint8Array(n)], { type: "image/jpeg" }) });
const settle = () => new Promise((r) => setTimeout(r, 30));
const memRegistry = (): ScopeRegistry => { const ids = new Set<string>(); return { read: () => [...ids], add: (s) => void ids.add(s), clear: () => ids.clear() }; };
function make() {
  const idb = fakeIDB();
  const scoped = createScopedStore(idb as unknown as IDBFactory, memRegistry());
  const mgr = createLocalAttachments(scoped);
  bindOwnerScope(scoped, mgr, { get: getOwnerScope, subscribe: subscribeOwnerScope });
  return { idb, scoped, mgr };
}
afterEach(() => resetOwnerScopeForTests());
const panel = (p: Partial<Parameters<typeof DevicePhotosPanel>[0]> = {}) => renderToStaticMarkup(createElement(DevicePhotosPanel, { view: null, busy: false, result: null, onClear: () => {}, ...p }));

describe("«صور هذا الجهاز» section", () => {
  it("renders the title, the explanation (device only, used to show sent photos, nothing deleted from BASHT), the usage and an enabled clear button", () => {
    const html = panel({ view: { status: "ready", count: 3, bytes: 5 * 1024 * 1024 } });
    expect(html).toContain("صور هذا الجهاز");
    expect(html).toContain("تُحفظ على هذا الجهاز فقط"); expect(html).toContain("لا يحذف شيئًا من باشت");
    expect(html).toContain("3 رسالة بصور"); expect(html).toContain("5.0 MB");
    expect(html).toContain(T.button);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain('class="muted"'); expect(html).toContain("aria-labelledby=\"photos-h\"");
  });
  it("nothing saved → a plain «none» line and the button is disabled; owner unknown / unreadable → an honest note, button disabled", () => {
    expect(panel({ view: { status: "ready", count: 0, bytes: 0 } })).toContain(T.none);
    expect(panel({ view: { status: "ready", count: 0, bytes: 0 } })).toMatch(/<button[^>]*disabled/);
    for (const status of ["noowner", "unreadable"] as const) {
      const html = panel({ view: { status, count: 0, bytes: 0 } });
      expect(html).toContain(status === "noowner" ? T.noOwner : T.unreadable); expect(html).toMatch(/<button[^>]*disabled/);
    }
    expect(devicePhotosLine(null)).toBe("");
  });
  it("busy disables the button; the result is announced: success as a status, failure as an ALERT that never says it was cleared", () => {
    expect(panel({ view: { status: "ready", count: 1, bytes: 1 }, busy: true })).toMatch(/<button[^>]*disabled/);
    const ok = panel({ view: { status: "ready", count: 0, bytes: 0 }, result: { ok: true, text: T.done } });
    expect(ok).toContain('role="status"'); expect(ok).toContain(T.done);
    const bad = panel({ view: { status: "ready", count: 1, bytes: 1 }, result: { ok: false, text: T.failed } });
    expect(bad).toContain('role="alert"'); expect(bad).toContain(T.failed); expect(bad).not.toContain(T.done);
    expect(T.failed).not.toContain("مُسحت");
  });
  it("is part of the settings screen, RTL-safe and a full-width touch target", () => {
    const WEB = resolve(__dirname, "..");
    expect(readFileSync(join(WEB, "features/settings/settings-screen.tsx"), "utf8")).toContain("<DevicePhotos />");
    expect(readFileSync(join(WEB, "features/settings/device-photos.tsx"), "utf8")).not.toMatch(/\b(left|right):/);
  });
});

describe("the clear flow (confirm → clear only the current owner → honest result → refreshed usage)", () => {
  async function twoOwners() {
    const ctx = make();
    setOwnerScope(A); ctx.mgr.register({ clientMsgId: "a1", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    setOwnerScope(B); ctx.mgr.register({ clientMsgId: "b1", text: "y", sentAt: 2, images: [img("b", 4096)] }); await settle();
    return ctx;
  }
  it("reads the CURRENT owner's usage only", async () => {
    const { mgr } = await twoOwners();
    expect(await readDevicePhotos(mgr, true)).toEqual({ status: "ready", count: 1, bytes: 4096 }); // owner B
    setOwnerScope(A);
    expect(await readDevicePhotos(mgr, true)).toEqual({ status: "ready", count: 1, bytes: 2048 });
    expect(await readDevicePhotos(mgr, false)).toEqual({ status: "noowner", count: 0, bytes: 0 });  // unknown owner: nothing is read
    expect((await readDevicePhotos({ usage: async () => { throw new Error("idb"); }, clear: async () => true }, true)).status).toBe("unreadable");
  });
  it("cancelled confirmation clears nothing", async () => {
    const { mgr } = await twoOwners();
    const out = await clearDevicePhotos({ mgr, ownerKnown: true, confirm: async () => false });
    expect(out).toMatchObject({ cancelled: true, cleared: false, view: { count: 1 } });
    expect((await mgr.usage())!.count).toBe(1);
  });
  it("confirmed: clears ONLY the current owner's copies, says so, and the usage is refreshed to zero; the other owner's copies stay", async () => {
    const { scoped, mgr } = await twoOwners();
    const out = await clearDevicePhotos({ mgr, ownerKnown: true, confirm: async () => true });
    expect(out).toMatchObject({ cleared: true, cancelled: false, message: T.done, view: { status: "ready", count: 0, bytes: 0 } });
    scoped.setScope(A);
    expect((await scoped.list() as { value: unknown[] }).value).toHaveLength(1); // A untouched
    scoped.setScope(B);
    expect((await scoped.list() as { value: unknown[] }).value).toHaveLength(0);
  });
  it("a FAILED wipe shows the failure and never says «cleared» (the copies are still on the device)", async () => {
    const { idb, mgr } = await twoOwners();
    idb.dropConnections(); idb.openFails = "error";
    const out = await clearDevicePhotos({ mgr, ownerKnown: true, confirm: async () => true });
    expect(out.cleared).toBe(false); expect(out.message).toBe(T.failed); expect(out.message).not.toBe(T.done);
    idb.openFails = null;
    expect((await mgr.usage())!.count).toBe(1);                        // really still there
  });
  it("a wipe that reports success while something is still there is NOT reported as cleared", async () => {
    const out = await clearDevicePhotos({ mgr: { usage: async () => ({ count: 2, bytes: 10 }), clear: async () => true }, ownerKnown: true, confirm: async () => true });
    expect(out.cleared).toBe(false); expect(out.message).toBe(T.failed);
  });
  it("a wipe that throws is a failure, not a crash", async () => {
    const out = await clearDevicePhotos({ mgr: { usage: async () => ({ count: 1, bytes: 1 }), clear: async () => { throw new Error("boom"); } }, ownerKnown: true, confirm: async () => true });
    expect(out.cleared).toBe(false);
  });
  it("unknown owner: the clear is refused honestly (never reported as cleared)", async () => {
    const { mgr } = make();
    const out = await clearDevicePhotos({ mgr, ownerKnown: false, confirm: async () => true });
    expect(out.cleared).toBe(false); expect(out.view.status).toBe("noowner");
  });
});

describe("after a clear the chat refreshes without a crash: a ready photo becomes «unavailable»", () => {
  it("the matcher has no records, the image views release the photo, and the row shows the honest placeholder", async () => {
    const { mgr } = make();
    setOwnerScope(A);
    mgr.register({ clientMsgId: "c1", text: "", sentAt: 1000, images: [img("a")] }); mgr.attachRun("c1", "run-1"); await settle();
    const rows: MatchRow[] = [{ key: "r1", role: "user", text: "", at: 2000, hasServerMedia: false }];
    const views = createImageViews(mgr, { createUrl: () => "blob:t/1", revokeUrl: () => {} });
    const matched = matchAttachments(rows, mgr.getSnapshot());
    expect([...matched.matches]).toEqual([["r1", "c1"]]);
    views.want([...matched.matches.values()]); await settle();
    expect(rowLocalState(matched.matches, views.getSnapshot()).byRow.has("r1")).toBe(true);   // ready: the photo shows
    await mgr.clear();                                                                           // the owner clears the copies
    const after = matchAttachments(rows, mgr.getSnapshot());
    expect(after.matches.size).toBe(0);                                                          // no record: nothing to show, no wrong photo
    views.want([...after.matches.values()]);                                                     // the screen drops the photo's claim
    const s = rowLocalState(after.matches, views.getSnapshot());
    expect(s.byRow.size).toBe(0); expect(s.loadingRows.size).toBe(0);
    expect(engineRowView({ role: "user", text: "" }, parseVoiceNote, "none").noText).toBe(true); // → «صورة غير متاحة» with its retry
  });
  it("a photo whose bytes vanish mid-read (cleared while it loads) fails cleanly instead of crashing", async () => {
    const { mgr } = make();
    setOwnerScope(A); mgr.register({ clientMsgId: "c1", text: "x", sentAt: 1, images: [img("a")] }); await settle();
    const views = createImageViews({ images: async (id) => { await mgr.clear(); return mgr.images(id); } }, { createUrl: () => "blob:t/2", revokeUrl: () => {} });
    views.want(["c1"]); await settle(); await settle();
    expect(views.getSnapshot().get("c1")).toEqual({ status: "failed" });
  });
});
