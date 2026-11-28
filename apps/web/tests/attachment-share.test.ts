import { describe, expect, it, vi } from "vitest";
import { downloadFile, openFile, shareFile, SHARE_TEXT, type ShareHost } from "@/lib/attachment-share";

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
function host(over: Partial<ShareHost> & { anchor?: { click: () => void } } = {}) {
  const clicks: string[] = []; const revoked: string[] = []; const timers: (() => void)[] = []; let n = 0;
  const h: ShareHost = {
    navigator: { share: vi.fn(async () => {}), canShare: vi.fn(() => true) },
    document: { createElement: () => { const a = { href: "", download: "", rel: "", style: { display: "" }, click: () => { clicks.push(a.href + "|" + a.download); over.anchor?.click(); }, remove: () => {} }; return a; }, body: { appendChild: () => null } },
    URL: { createObjectURL: () => "blob:test/" + ++n, revokeObjectURL: (u) => { revoked.push(u); } },
    open: vi.fn(() => ({ opener: {} })),
    File: class { constructor(public parts: unknown[], public name: string, public opts: { type?: string }) {} } as unknown as typeof File,
    setTimeout: (f) => { timers.push(f); return 0; },
    ...over,
  };
  return { h, clicks, revoked, flush: () => timers.splice(0).forEach((f) => f()) };
}

describe("share / download fallbacks", () => {
  it("shares the real file through the system sheet when canShare({files}) is true", async () => {
    const { h, clicks } = host();
    expect(await shareFile(blob, "photo.jpg", h)).toEqual({ status: "shared" });
    const call = (h.navigator!.share as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.files).toHaveLength(1);
    expect(call.files[0]).toMatchObject({ name: "photo.jpg", opts: { type: "image/jpeg" } });
    expect(h.navigator!.canShare).toHaveBeenCalledWith({ files: [call.files[0]] });
    expect(clicks).toEqual([]); // no download when the sheet worked
  });
  it("the owner dismissing the share sheet (AbortError) is not an error and triggers no fallback", async () => {
    const { h, clicks } = host();
    h.navigator!.share = vi.fn(async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); });
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "cancelled" });
    expect(clicks).toEqual([]);
  });
  it("no canShare for files (desktop browsers): falls back to a blob download through <a download>, object URL revoked later", async () => {
    const { h, clicks, revoked, flush } = host();
    h.navigator!.canShare = vi.fn(() => false);
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "downloaded" });
    expect(clicks).toEqual(["blob:test/1|p.jpg"]);
    expect(h.navigator!.share).not.toHaveBeenCalled();
    expect(revoked).toEqual([]); flush(); expect(revoked).toEqual(["blob:test/1"]);
  });
  it("no navigator.share at all → download", async () => {
    const { h, clicks } = host({ navigator: {} });
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "downloaded" });
    expect(clicks).toHaveLength(1);
  });
  it("the share sheet refusing for another reason (NotAllowedError) falls back to the download instead of failing silently", async () => {
    const { h, clicks } = host();
    h.navigator!.share = vi.fn(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); });
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "downloaded" });
    expect(clicks).toHaveLength(1);
  });
  it("download unavailable → the file opens in a new tab", async () => {
    const { h } = host({ anchor: { click: () => { throw new Error("blocked"); } } });
    h.navigator!.canShare = () => false;
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "opened" });
    expect(h.open).toHaveBeenCalledWith("blob:test/2", "_blank");
  });
  it("everything blocked → a short Arabic message, never silence", async () => {
    const { h } = host({ anchor: { click: () => { throw new Error("blocked"); } }, open: vi.fn(() => null) });
    h.navigator!.canShare = () => false;
    expect(await shareFile(blob, "p.jpg", h)).toEqual({ status: "failed", message: SHARE_TEXT.shareFailed });
    expect(await downloadFile(blob, "p.jpg", h)).toEqual({ status: "failed", message: SHARE_TEXT.downloadFailed });
    expect(await openFile(blob, h)).toEqual({ status: "failed", message: SHARE_TEXT.openFailed });
    expect(SHARE_TEXT.shareFailed).toMatch(/[؀-ۿ]/);
  });
  it("bytes not ready yet → «الملف غير جاهز بعد»", async () => {
    const { h } = host();
    expect(await shareFile(null, "p.jpg", h)).toEqual({ status: "failed", message: SHARE_TEXT.noFile });
    expect(await downloadFile(undefined, "p.jpg", h)).toEqual({ status: "failed", message: SHARE_TEXT.noFile });
    expect(openFile(null, h)).toEqual({ status: "failed", message: SHARE_TEXT.noFile });
  });
  it("downloadFile downloads; openFile opens the blob in a new tab", async () => {
    const a = host();
    expect(await downloadFile(blob, "doc.pdf", a.h)).toEqual({ status: "downloaded" });
    expect(a.clicks).toEqual(["blob:test/1|doc.pdf"]);
    const b = host();
    expect(openFile(blob, b.h)).toEqual({ status: "opened" });
    expect(b.h.open).toHaveBeenCalledWith("blob:test/1", "_blank");
  });
});
