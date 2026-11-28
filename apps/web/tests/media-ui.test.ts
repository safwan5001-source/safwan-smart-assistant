import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogsProvider } from "@/components/dialogs";
import MediaViewer, { VIEWER_TEXT } from "@/components/media-viewer";
import MessageMedia, { ImageTile, LiveImages, MEDIA_TEXT } from "@/features/chat/message-media";
import { bashtMediaUrl, type BashtMedia } from "@/lib/basht-client";
import { viewerItems, type LocalImageView, type ViewerItem } from "@/lib/viewer-items";
import { createOverlayHistory } from "@/lib/overlay-history";

const SRC = (p: string) => readFileSync(join(resolve(__dirname, ".."), p), "utf8");
const KEY = "agent:main:app:owner";
const wrap = (el: ReactElement) => renderToStaticMarkup(createElement(DialogsProvider, null, el)).replace(/<div class="toasts"[^>]*><\/div>/, ""); // without the provider's own toast region
const local = (id = "c1:a"): LocalImageView => ({ id, name: "photo.jpg", mime: "image/jpeg", size: 1000, width: 800, height: 600, url: "blob:local/" + id, blob: new Blob(["x"], { type: "image/jpeg" }) });
const srvImg = (ref: string, extra: Partial<BashtMedia> = {}): BashtMedia => ({ kind: "image", name: ref + ".png", ref, mime: "image/png", ...extra });
const mm = (props: Partial<Parameters<typeof MessageMedia>[0]>) => wrap(createElement(MessageMedia, { sessionKey: KEY, messageId: "m1", media: undefined, ...props }));

describe("an owner's image message is never an empty bubble", () => {
  it("no text and nothing the app can show: «صورة غير متاحة» with «إعادة المحاولة» (the engine row carried only a placeholder)", () => {
    const html = mm({ ownerNoText: true, onRetry: () => {} });
    expect(html).toContain(MEDIA_TEXT.imageUnavailable);
    expect(html).toContain(MEDIA_TEXT.retry);
    expect(html).toContain("<button");
  });
  it("with a device-local copy the bubble shows the photo, not the placeholder", () => {
    const html = mm({ ownerNoText: true, local: [local()], onRetry: () => {} });
    expect(html).toContain('src="blob:local/c1:a"');
    expect(html).not.toContain(MEDIA_TEXT.imageUnavailable);
    expect(html).toContain("عرض الصورة photo.jpg");
  });
  it("with the server's media the server copy is shown and the local copy is ignored (the server always wins)", () => {
    const html = mm({ ownerNoText: true, media: [srvImg("a".repeat(32))], local: [local()] });
    expect(html).toContain(bashtMediaUrl(KEY, "m1", "a".repeat(32)).replace(/&/g, "&amp;"));
    expect(html).not.toContain("blob:local");
  });
  it("server media listed but unavailable, no local copy: an honest «غير متاحة» tile with a retry (not a hidden message)", () => {
    const html = mm({ ownerNoText: true, media: [srvImg("b".repeat(32), { available: false })], onRetry: () => {} });
    expect(html).toContain(MEDIA_TEXT.unavailable);
    expect(html).toContain(MEDIA_TEXT.retry);
  });
  it("…and a local copy rescues a row whose server media is unavailable", () => {
    const html = mm({ ownerNoText: true, media: [srvImg("b".repeat(32), { available: false })], local: [local()] });
    expect(html).toContain('src="blob:local/c1:a"');
  });
  it("a message WITH text and no media renders nothing extra; photos still being read from the device are not flagged unavailable", () => {
    expect(mm({ ownerNoText: false })).toBe("");
    expect(mm({ ownerNoText: false, local: undefined })).toBe("");
  });
  it("a PDF chip offers a preview next to download / save", () => {
    const html = mm({ media: [{ kind: "file", name: "تقرير.pdf", ref: "c".repeat(32), mime: "application/pdf", size: 2048 }] });
    expect(html).toContain("معاينة تقرير.pdf");
    expect(html).toContain("تنزيل تقرير.pdf");
  });
  it("the live (sending) photos open the viewer when a handler is given", () => {
    const html = renderToStaticMarkup(createElement(LiveImages, { images: [{ name: "a.jpg", previewUrl: "blob:live/1" }], onOpen: () => {} }));
    expect(html).toContain("blob:live/1");
    expect(html).not.toContain("disabled");
  });
});

describe("image tile states", () => {
  it("starts in the loading state (a stable box with the shimmer), the image is in the DOM so the browser loads it", () => {
    const item: ViewerItem = { id: "s:m1:r", kind: "image", name: "a.png", src: "/api/basht/media?x=1" };
    const html = renderToStaticMarkup(createElement(ImageTile, { item, onOpen: () => {} }));
    expect(html).toContain("media-thumb loading");
    expect(html).toContain('src="/api/basht/media?x=1"');
  });
});

describe("viewer items", () => {
  it("server images and PDFs come from the media route; a local copy is added only when the server has no image", () => {
    const media: BashtMedia[] = [srvImg("a".repeat(32)), { kind: "file", name: "d.pdf", ref: "d".repeat(32), mime: "application/pdf" }, { kind: "file", name: "n.txt", ref: "e".repeat(32), mime: "text/plain" }, srvImg("f".repeat(32), { available: false })];
    const items = viewerItems({ sessionKey: KEY, messageId: "m1", media, local: [local()] });
    expect(items.map((i) => [i.kind, i.local ?? false])).toEqual([["image", false], ["pdf", false]]);
    expect(items[0].src).toBe(bashtMediaUrl(KEY, "m1", "a".repeat(32)));
    const onlyLocal = viewerItems({ sessionKey: KEY, messageId: "m1", media: [srvImg("f".repeat(32), { available: false })], local: [local()] });
    expect(onlyLocal.map((i) => [i.id, i.local, !!i.blob])).toEqual([["l:c1:a", true, true]]);
    expect(viewerItems({ sessionKey: null, messageId: null, media: [], local: [local()] })).toHaveLength(1); // a pending (not yet in the history) message
    expect(viewerItems({ sessionKey: KEY, messageId: null, media: [srvImg("a".repeat(32))] })).toEqual([]); // no message id → no URL to build
  });
});

describe("the viewer (markup; gestures are tested in viewer-gestures.test.ts)", () => {
  const three: ViewerItem[] = [1, 2, 3].map((n) => ({ id: "i" + n, kind: "image", name: `p${n}.jpg`, src: "blob:x/" + n, blob: new Blob(["x"]) }));
  const render = (items: ViewerItem[], index: number | null) => renderToStaticMarkup(createElement(MediaViewer, { items, index, onIndex: () => {}, onClose: () => {} }));
  it("closed: nothing is rendered", () => { expect(render(three, null)).toBe(""); });
  it("Arabic labels on every control, a counter, and previous disabled on the first picture", () => {
    const html = render(three, 0);
    for (const l of [VIEWER_TEXT.close, VIEWER_TEXT.share, VIEWER_TEXT.download, VIEWER_TEXT.next, VIEWER_TEXT.prev, VIEWER_TEXT.label]) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toContain("1 / 3");
    expect(html).toMatch(/aria-label="الصورة السابقة"[^>]*disabled|disabled=""[^>]*aria-label="الصورة السابقة"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="الصورة التالية"|aria-label="الصورة التالية"[^>]*disabled/);
    expect(html).toContain('class="viewer-dialog"');
  });
  it("a single picture has no counter and no arrows", () => {
    const html = render(three.slice(0, 1), 0);
    expect(html).not.toContain("1 / 1"); expect(html).not.toContain(VIEWER_TEXT.next); expect(html).not.toContain(VIEWER_TEXT.prev);
  });
  it("a PDF: sandboxed-iframe preview area with «فتح» and «تنزيل» (the frame itself appears once the bytes are in)", () => {
    const html = render([{ id: "p", kind: "pdf", name: "تقرير.pdf", src: "/api/x" }], 0);
    expect(html).toContain("vw-pdf");
    expect(html).toContain(VIEWER_TEXT.open); expect(html).toContain(VIEWER_TEXT.download);
    expect(html).toContain(VIEWER_TEXT.pdfNote);
  });
  it("Back closes it and closing by a button goes back over its entry; moving between pictures never touches the history", async () => {
    // the same helper the viewer uses, over a fake window whose back() is asynchronous like a browser's
    const stack: unknown[] = [{}]; let idx = 0; const ls = new Set<() => void>();
    const w = { history: { get state() { return stack[idx]; }, pushState: (s: unknown) => { stack.splice(idx + 1); stack.push(s); idx++; }, back: () => { queueMicrotask(() => { if (idx > 0) idx--; [...ls].forEach((f) => f()); }); } },
      addEventListener: (_t: "popstate", f: () => void) => { ls.add(f); }, removeEventListener: (_t: "popstate", f: () => void) => { ls.delete(f); } };
    const h = createOverlayHistory(w);
    let closed = 0;
    const off = h.open(() => { closed++; });
    expect(idx).toBe(1);
    ls.forEach((f) => f()); expect(closed).toBe(1); // the Back gesture
    off();
    const off2 = h.open(() => { closed++; }); off2();
    await new Promise((r) => setTimeout(r, 0));
    expect(idx).toBe(0); expect(closed).toBe(1);
    const src = SRC("components/media-viewer.tsx");
    expect(src).toMatch(/overlayHistory\(\)\.open\(\(\) => closeRef\.current\(\)\)/);
    expect(src).toMatch(/\}, \[open\]\);/); // keyed on open/closed only: arrows and swipes between pictures push nothing
  });
});

describe("viewer safety and robustness (source contract)", () => {
  const viewer = SRC("components/media-viewer.tsx"), media = SRC("features/chat/message-media.tsx"), modal = SRC("components/modal.tsx"), css = SRC("components/media-viewer.css");
  it("no innerHTML anywhere in the new code; the PDF frame is sandboxed with no tokens; object URLs are revoked", () => {
    for (const f of [viewer, media, SRC("lib/attachment-share.ts"), SRC("features/chat/use-local-attachments.ts")]) expect(f).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
    expect(viewer).toContain('sandbox=""');
    expect(viewer).toContain("URL.revokeObjectURL");
  });
  it("it is a modal <dialog> (focus trap, Esc, inert background, body scroll lock) that a backdrop tap does not close", () => {
    expect(viewer).toContain('variant="viewer"');
    expect(modal).toContain('document.body.style.overflow = "hidden"');
    expect(modal).toMatch(/variant !== "viewer"/);
  });
  it("safe-area insets, reduced motion, touch-action and logical (RTL-safe) positioning in the CSS", () => {
    expect(css).toContain("env(safe-area-inset-top)"); expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("touch-action: none");
    expect(css).toMatch(/inset-inline-start/); expect(css).not.toMatch(/\b(left|right):/);
  });
  it("the chat screen uses the shared viewer, passes the local copies, and keeps the in-memory live bubble", () => {
    const chat = SRC("features/chat/chat-screen.tsx");
    expect(chat).toContain("<MediaViewer");
    expect(chat).toContain("useLocalAttachments(");
    expect(chat).toContain("ownerNoText={noText}");
    expect(chat).toMatch(/live && \(/);
  });
});
