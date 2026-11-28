"use client";
/**
 * B2 files out: images and files BASHT shows in a message (its replies, or photos the owner sent), served through the owner's own
 * session (/api/basht/media), plus the device-local copy of the owner's own photos when the engine's row has none (lib/attachment-match).
 * - Every image tile has three honest states — loading, ready, «غير متاحة · إعادة المحاولة» (bounded retries, no layout jump).
 * - A tap opens the full-screen viewer (components/media-viewer): zoom, swipe, share/download; a PDF opens the same viewer as a preview.
 * - An owner's message with no text and no picture the app can show is NEVER an empty bubble: it shows «صورة غير متاحة» with a retry.
 * «حفظ في ملفاتي» puts a copy of a file into the app's existing Files library (lib/files-db, IndexedDB on this device).
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import Icon from "@/components/icon";
import MediaViewer from "@/components/media-viewer";
import { useDialogs } from "@/components/dialogs";
import { bashtMediaUrl, type BashtMedia } from "@/lib/basht-client";
import { downloadBlob, putFiles } from "@/lib/files-db";
import { canRetryImage, imageLoadReducer, initImageLoad } from "@/lib/image-load";
import { isPdf, serverImage, viewerItems, type LocalImageView, type ViewerItem } from "@/lib/viewer-items";
import type { LiveImage } from "./use-basht";
import "./chat-media.css";

export const formatBytes = (n: number | null | undefined) =>
  typeof n !== "number" ? "" : n < 1024 ? `${n} بايت` : n < 1024 * 1024 ? `${Math.round(n / 1024)} ك.ب` : `${(n / 1024 / 1024).toFixed(1)} م.ب`;

export const MEDIA_TEXT = { unavailable: "غير متاحة", imageUnavailable: "صورة غير متاحة", retry: "إعادة المحاولة", preview: "معاينة", localOnly: "على هذا الجهاز فقط" } as const;

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.blob();
}

/** Saves one engine file into the app's Files library (this device). */
export async function saveToFiles(url: string, name: string): Promise<void> {
  const blob = await fetchBlob(url);
  await putFiles([{ id: crypto.randomUUID(), name, size: blob.size, type: blob.type || "غير معروف", file: blob, added: Date.now() }]);
}

/** «غير متاحة · إعادة المحاولة»: the tile's error face (same box as the loading/ready one: nothing jumps). */
function UnavailableTile({ label = MEDIA_TEXT.unavailable, onRetry, ratio }: { label?: string; onRetry?: () => void; ratio?: number }) {
  return (
    <div className="media-thumb unavailable" style={ratio ? { aspectRatio: String(ratio) } : undefined}>
      <span className="thumb-state" role="group" aria-label={label}>
        <Icon name="image" size={20} />
        <span>{label}</span>
        {onRetry && <button type="button" className="btn btn-sm" onClick={onRetry}>{MEDIA_TEXT.retry}</button>}
      </span>
    </div>
  );
}

/** One image: loading → ready, or error with a bounded retry that reloads the same address with a cache-busting parameter. */
export function ImageTile({ item, ratio, onOpen }: { item: ViewerItem; ratio?: number; onOpen: () => void }) {
  const [st, dispatch] = useReducer(imageLoadReducer, item.src, initImageLoad);
  useEffect(() => { dispatch({ type: "reset", url: item.src }); }, [item.src]);
  if (st.status === "error") return <UnavailableTile ratio={ratio} onRetry={canRetryImage(st) ? () => dispatch({ type: "retry" }) : undefined} />;
  return (
    <button type="button" className={"media-thumb" + (st.status === "loading" ? " loading" : "")} style={ratio ? { aspectRatio: String(ratio) } : undefined}
      onClick={onOpen} aria-label={"عرض الصورة " + item.name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img key={st.attempt} src={st.src} alt={item.name} loading="lazy" decoding="async"
        // an image already decoded before React attached its handlers counts as loaded; «error» only ever comes from a real error
        // event (a lazy image that has not started loading is also `complete` with no width: that is not a failure)
        ref={(el) => { if (el && el.complete && el.naturalWidth > 0 && st.status === "loading") dispatch({ type: "load" }); }}
        onLoad={() => dispatch({ type: "load" })} onError={() => dispatch({ type: "error" })} />
    </button>
  );
}

export default function MessageMedia({ sessionKey, messageId, media, local, ownerNoText = false, localFailed = false, onOpen, onRetry, localOnly = false }: {
  sessionKey: string | null; messageId: string | null | undefined; media: BashtMedia[] | undefined;
  /** The owner's own photos kept on this device (shown only while the server has no image for this message). */
  local?: LocalImageView[];
  /** An owner message with no text: it must never render as an empty bubble. */
  ownerNoText?: boolean;
  /** The owner's photo copy on this device could not be read (with or without a caption): an unavailable tile with the retry is shown. */
  localFailed?: boolean;
  /** Opens the shared (conversation-wide) viewer; without it this message opens its own. */
  onOpen?: (item: ViewerItem) => void;
  /** Re-reads the history (an unavailable picture may be available now). */
  onRetry?: () => void;
  localOnly?: boolean;
}) {
  const { toast } = useDialogs();
  const [own, setOwn] = useState<number | null>(null);
  const items = useMemo(() => viewerItems({ sessionKey, messageId, media, local }), [sessionKey, messageId, media, local]);
  const save = async (u: string, name: string) => {
    try { await saveToFiles(u, name); toast("حُفظ في ملفاتي"); } catch { toast("تعذّر الحفظ في ملفاتي.", "error"); }
  };
  const download = async (u: string, name: string) => {
    try { downloadBlob(await fetchBlob(u), name); } catch { toast("تعذّر تنزيل الملف.", "error"); }
  };
  const open = (it: ViewerItem) => { if (onOpen) onOpen(it); else setOwn(items.findIndex((x) => x.id === it.id)); };
  const all = media ?? [];
  const images = items.filter((i) => i.kind === "image");
  // the engine lists them but cannot serve them (a local copy of the owner's photos stands in for them, so no «unavailable» tile next to it)
  const brokenImages = images.some((i) => i.local) ? [] : all.filter((m) => m.kind === "image" && !serverImage(m));
  const others = all.filter((m) => m.kind !== "image");
  // an owner's message without text and without any picture to show: say so (never an empty bubble)
  const placeholder = (ownerNoText || localFailed) && !images.length && !brokenImages.length && !others.length;
  if (!images.length && !brokenImages.length && !others.length && !placeholder) return null;
  const shown = images.length + brokenImages.length;
  return (
    <div className="msg-media">
      {(images.length > 0 || brokenImages.length > 0 || placeholder) && (
        <div className={"media-grid n" + Math.min(Math.max(shown, 1), 3)}>
          {images.map((it) => {
            const l = it.local ? local?.find((x) => "l:" + x.id === it.id) : undefined;
            return <ImageTile key={it.id} item={it} ratio={shown === 1 && l?.width && l.height ? Math.min(2, Math.max(0.6, l.width / l.height)) : undefined} onOpen={() => open(it)} />;
          })}
          {brokenImages.map((m, i) => <UnavailableTile key={"b" + i} onRetry={onRetry} />)}
          {placeholder && <UnavailableTile label={MEDIA_TEXT.imageUnavailable} onRetry={onRetry} />}
        </div>
      )}
      {localOnly && images.some((i) => i.local) && <small className="muted">{MEDIA_TEXT.localOnly}</small>}
      {others.map((m, i) => {
        if (m.kind === "link" && m.url) return (
          <a key={"l" + i} className="attach-chip media-chip" href={m.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={16} /><span>{m.name}</span></a>
        );
        if (m.available === false || !m.ref || !sessionKey || !messageId) return (
          <span key={m.ref ?? i} className="attach-chip media-chip unavailable" title="الملف غير متاح"><Icon name="file" size={16} /><span>{m.name}</span><small>غير متاح</small></span>
        );
        // the file route is the same one the viewer uses; PDFs open in the viewer, everything else downloads
        const fileUrl = bashtMediaUrl(sessionKey, messageId, m.ref);
        const pdf = isPdf(m) ? items.find((x) => x.kind === "pdf" && x.id.endsWith(":" + m.ref)) : undefined;
        return (
          <span key={m.ref} className="attach-chip media-chip">
            <Icon name={m.mime === "application/pdf" ? "pdf" : "file"} size={16} /><span>{m.name}</span>{m.size ? <small className="num">{formatBytes(m.size)}</small> : null}
            {pdf && <button type="button" className="icon-btn sm" onClick={() => open(pdf)} aria-label={MEDIA_TEXT.preview + " " + m.name}><Icon name="image" size={16} /></button>}
            <button type="button" className="icon-btn sm" onClick={() => void download(fileUrl, m.name)} aria-label={"تنزيل " + m.name}><Icon name="download" size={16} /></button>
            <button type="button" className="icon-btn sm" onClick={() => void save(fileUrl, m.name)} aria-label={"حفظ " + m.name + " في ملفاتي"}><Icon name="files" size={16} /></button>
          </span>
        );
      })}
      {!onOpen && <MediaViewer items={items} index={own} onIndex={setOwn} onClose={() => setOwn(null)} />}
    </div>
  );
}

/** The owner's photos on the live (still running) turn: shown from this device's memory until the engine's copy is in the history. */
export function LiveImages({ images, onOpen }: { images: LiveImage[] | undefined; onOpen?: (items: ViewerItem[], index: number) => void }) {
  if (!images?.length) return null;
  const items: ViewerItem[] = images.map((m, i) => ({ id: "live:" + i, kind: "image", name: m.name, mime: "image/jpeg", src: m.previewUrl, blob: m.blob, local: true }));
  return (
    <div className={"media-grid n" + Math.min(images.length, 3)}>
      {items.map((it, i) => (
        <button key={it.id} type="button" className="media-thumb" onClick={() => onOpen?.(items, i)} disabled={!onOpen} aria-label={"عرض الصورة " + it.name}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={it.src} alt={it.name} />
        </button>
      ))}
    </div>
  );
}
