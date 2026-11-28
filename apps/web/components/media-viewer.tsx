"use client";
/**
 * Full-screen viewer (A04): images with pinch-zoom / pan / double-tap / wheel, swipe-down to close, previous/next across the
 * message's (or conversation's) pictures; PDFs in a sandboxed preview with «فتح» and «تنزيل». Works for server media (fetched
 * through the owner's session) and for local copies (already a Blob). The phone's Back gesture closes it (lib/overlay-history),
 * the page behind never scrolls (Modal locks the body, as the voice screen does), focus stays inside (native modal <dialog>).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/icon";
import Modal from "@/components/modal";
import { overlayHistory } from "@/lib/overlay-history";
import { createGestures, type GestureView } from "@/lib/viewer-gestures";
import { downloadFile, openFile, shareFile, type ShareOutcome } from "@/lib/attachment-share";
import { bustUrl } from "@/lib/image-load";
import type { ViewerItem } from "@/lib/viewer-items";
import "./media-viewer.css";

export const VIEWER_TEXT = {
  label: "عارض الوسائط", close: "إغلاق العارض", prev: "الصورة السابقة", next: "الصورة التالية", share: "مشاركة", download: "تنزيل", open: "فتح",
  loading: "جارٍ التحميل…", failed: "تعذّر تحميل الملف.", imageFailed: "تعذّر عرض هذه الصورة. يمكنك تنزيلها.", retry: "إعادة المحاولة",
  zoomHint: "انقر مرتين أو اضغط بإصبعين للتكبير", pdfNote: "إن لم تظهر المعاينة فاستخدم «فتح» أو «تنزيل».",
} as const;

type Bytes = { status: "loading" | "ready" | "error"; blob: Blob | null; url: string | null };
type Tagged = Bytes & { key: string };
const LOADING: Bytes = { status: "loading", blob: null, url: null };
/** The bytes belong to ONE item+attempt: after next/prev the previous picture's bytes are never shown, not even for a frame. */
export const bytesFor = (s: Tagged, key: string): Bytes => (s.key === key ? s : LOADING);

/** The bytes of one item: a local copy is ready at once; a server item is fetched once (through the owner session) and shown from a blob URL. */
function useItemBytes(item: ViewerItem, attempt: number): Bytes {
  // tagged with the item+attempt it belongs to: after next/prev the previous picture's bytes are never shown for one frame
  const key = `${item.id}:${attempt}`;
  const [s, setS] = useState<Tagged>({ key: "", ...LOADING });
  useEffect(() => {
    const ctl = new AbortController();
    let made: string | null = null;
    const ready = (blob: Blob) => { made = URL.createObjectURL(blob); setS({ key, status: "ready", blob, url: made }); };
    if (item.blob) { ready(item.blob); return () => { if (made) URL.revokeObjectURL(made); }; }
    void (async () => {
      try {
        const r = await fetch(bustUrl(item.src, attempt), { credentials: "same-origin", cache: "no-store", signal: ctl.signal });
        if (!r.ok) throw new Error(String(r.status));
        let blob = await r.blob();
        if (item.kind === "pdf" && blob.type !== "application/pdf") blob = new Blob([blob], { type: "application/pdf" });
        if (!ctl.signal.aborted) ready(blob);
      } catch { if (!ctl.signal.aborted) setS({ key, status: "error", blob: null, url: null }); }
    })();
    return () => { ctl.abort(); if (made) URL.revokeObjectURL(made); };
  }, [item, attempt, key]);
  return bytesFor(s, key);
}

const fit = (nw: number, nh: number, vw: number, vh: number) => {
  if (!nw || !nh || !vw || !vh) return { cw: vw, ch: vh };
  const k = Math.min(vw / nw, vh / nh);
  return { cw: nw * k, ch: nh * k };
};

function ImageStage({ item, bytes, canNav, onNav, onClose, onRetry }: {
  item: ViewerItem; bytes: Bytes; canNav: boolean; onNav: (d: 1 | -1) => void; onClose: () => void; onRetry: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const natural = useRef({ w: 0, h: 0 });
  const [view, setView] = useState<GestureView>({ scale: 1, x: 0, y: 0, dismissDy: 0, navDx: 0, active: false });
  const [broken, setBroken] = useState(false);
  const cb = useRef({ onNav, onClose, canNav });
  cb.current = { onNav, onClose, canNav };
  const g = useMemo(() => createGestures({
    bounds: () => {
      const r = stage.current?.getBoundingClientRect();
      const vw = r?.width ?? 0, vh = r?.height ?? 0;
      return { vw, vh, ...fit(natural.current.w, natural.current.h, vw, vh) };
    },
    onView: setView, onClose: () => cb.current.onClose(), onNav: (d) => cb.current.onNav(d), canNav: () => cb.current.canNav,
    rtl: typeof document !== "undefined" ? getComputedStyle(document.documentElement).direction === "rtl" : true,
  }), []);

  // the wheel must be a non-passive native listener to stop the page zooming on ctrl+wheel / trackpad pinch
  useEffect(() => {
    const el = stage.current; if (!el) return;
    // zoom only with ctrl/meta (a trackpad pinch arrives as ctrl+wheel); a plain wheel / two-finger scroll pans the zoomed picture
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(); const k = e.deltaMode === 1 ? 16 : 1;
      g.wheel({ x: e.clientX - r.left, y: e.clientY - r.top, deltaX: e.deltaX * k, deltaY: e.deltaY * k, ctrl: e.ctrlKey, meta: e.metaKey });
    };
    el.addEventListener("wheel", h, { passive: false });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => g.refit()) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("wheel", h); ro?.disconnect(); };
  }, [g]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") g.zoomBy(1.4); else if (e.key === "-") g.zoomBy(1 / 1.4); else if (e.key === "0") g.reset();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [g]);

  const pt = (e: React.PointerEvent) => { const r = stage.current!.getBoundingClientRect(); return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp }; };
  const { scale, x, y, dismissDy, navDx } = view;
  const tx = x + navDx, ty = y + dismissDy;
  return (
    <div ref={stage} className="vw-stage" data-zoomed={scale > 1.03 ? "1" : undefined} aria-label={item.name}
      onPointerDown={(e) => { if (bytes.status !== "ready") return; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } g.pointerDown(pt(e)); }}
      onPointerMove={(e) => g.pointerMove(pt(e))}
      onPointerUp={(e) => g.pointerUp(pt(e))}
      onPointerCancel={(e) => g.pointerCancel(pt(e))}>
      {bytes.status === "loading" && <span className="vw-center"><span className="spinner" aria-hidden="true" />{VIEWER_TEXT.loading}</span>}
      {(bytes.status === "error" || broken) && (
        <span className="vw-center" role="alert">
          <Icon name="alert" size={28} />{broken ? VIEWER_TEXT.imageFailed : VIEWER_TEXT.failed}
          {!broken && <button type="button" className="vw-btn pill" onClick={onRetry}>{VIEWER_TEXT.retry}</button>}
        </span>
      )}
      {bytes.status === "ready" && !broken && bytes.url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={"vw-img" + (view.active ? "" : " settle")} src={bytes.url} alt={item.name} draggable={false}
          style={{ transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})` }}
          onLoad={(e) => { natural.current = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }; g.refit(); }}
          onError={() => setBroken(true)} />
      )}
    </div>
  );
}

function PdfStage({ item, bytes, onRetry }: { item: ViewerItem; bytes: Bytes; onRetry: () => void }) {
  return (
    <div className="vw-pdf">
      {bytes.status === "loading" && <span className="vw-center"><span className="spinner" aria-hidden="true" />{VIEWER_TEXT.loading}</span>}
      {bytes.status === "error" && (
        <span className="vw-center" role="alert"><Icon name="alert" size={28} />{VIEWER_TEXT.failed}<button type="button" className="vw-btn pill" onClick={onRetry}>{VIEWER_TEXT.retry}</button></span>
      )}
      {/* sandbox with no tokens: the PDF cannot run scripts, navigate the app or reach its origin */}
      {bytes.status === "ready" && bytes.url && <iframe className="vw-frame" title={item.name} src={bytes.url + "#view=FitH"} sandbox="" referrerPolicy="no-referrer" />}
      <small className="vw-note">{VIEWER_TEXT.pdfNote}</small>
    </div>
  );
}

function ViewerBody({ items, index, onIndex, onClose }: { items: ViewerItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const item = items[index];
  // the retry counter belongs to the item it was pressed for (the body itself stays mounted across next/prev, so focus stays on the arrow)
  const [retry, setRetry] = useState({ id: item.id, n: 0 });
  const attempt = retry.id === item.id ? retry.n : 0;
  const bytes = useItemBytes(item, attempt);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((o: ShareOutcome) => {
    if (timer.current) clearTimeout(timer.current);
    setStatus(o.message ?? "");
    if (o.message) timer.current = setTimeout(() => setStatus(""), 5000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const many = items.length > 1;
  const go = useCallback((d: 1 | -1) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); }, [index, items.length, onIndex]);

  // keyboard (on the document: a click on the picture leaves focus on the dialog itself): the arrow that points left is «next»
  // in a right-to-left layout
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(1); } else if (e.key === "ArrowRight") { e.preventDefault(); go(-1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go]);
  const blob = bytes.blob;
  return (
    <div className="vw">
      <div className="vw-top">
        <button type="button" className="vw-btn" onClick={onClose} aria-label={VIEWER_TEXT.close}><Icon name="close" size={22} /></button>
        <div className="vw-title">
          <strong dir="auto">{item.name}</strong>
          {many && <small className="num" dir="ltr" aria-live="polite">{index + 1} / {items.length}</small>}
        </div>
        <div className="vw-actions">
          {item.kind === "pdf" && <button type="button" className="vw-btn" disabled={!blob} onClick={() => say(openFile(blob))} aria-label={VIEWER_TEXT.open}><Icon name="pdf" size={22} /></button>}
          <button type="button" className="vw-btn" disabled={!blob} onClick={() => void shareFile(blob, item.name).then(say)} aria-label={VIEWER_TEXT.share}><Icon name="share" size={22} /></button>
          <button type="button" className="vw-btn" disabled={!blob} onClick={() => void downloadFile(blob, item.name).then(say)} aria-label={VIEWER_TEXT.download}><Icon name="download" size={22} /></button>
        </div>
      </div>
      <div className="vw-body">
        {item.kind === "image"
          ? <ImageStage key={item.id + ":" + attempt} item={item} bytes={bytes} canNav={many} onNav={go} onClose={onClose} onRetry={() => setRetry({ id: item.id, n: attempt + 1 })} />
          : <PdfStage key={item.id + ":" + attempt} item={item} bytes={bytes} onRetry={() => setRetry({ id: item.id, n: attempt + 1 })} />}
        {many && <button type="button" className="vw-btn vw-nav prev" onClick={() => go(-1)} disabled={index === 0} aria-label={VIEWER_TEXT.prev}><Icon name="back" size={26} /></button>}
        {many && <button type="button" className="vw-btn vw-nav next" onClick={() => go(1)} disabled={index === items.length - 1} aria-label={VIEWER_TEXT.next}><Icon name="forward" size={26} /></button>}
      </div>
      {item.kind === "pdf" && (
        <div className="vw-bottom">
          <button type="button" className="vw-btn pill" disabled={!blob} onClick={() => say(openFile(blob))}><Icon name="pdf" size={18} />{VIEWER_TEXT.open}</button>
          <button type="button" className="vw-btn pill" disabled={!blob} onClick={() => void downloadFile(blob, item.name).then(say)}><Icon name="download" size={18} />{VIEWER_TEXT.download}</button>
        </div>
      )}
      <p className="vw-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

/** `index === null` = closed. The caller owns `items` and `index` (so the same viewer serves one message or the whole conversation). */
export default function MediaViewer({ items, index, onIndex, onClose }: { items: ViewerItem[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const open = index !== null && index >= 0 && index < items.length;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // the Back gesture / button closes the viewer instead of leaving the conversation
  useEffect(() => {
    if (!open) return;
    return overlayHistory().open(() => closeRef.current());
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} label={VIEWER_TEXT.label} variant="viewer">
      {open && <ViewerBody items={items} index={index!} onIndex={onIndex} onClose={onClose} />}
    </Modal>
  );
}
