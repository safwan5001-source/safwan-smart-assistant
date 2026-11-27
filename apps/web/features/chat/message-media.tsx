"use client";
/**
 * B2 files out: images and files BASHT shows in a message (its replies, or photos the owner sent), served through the owner's own
 * session (/api/basht/media). Images inline (lazy), other files as chips. «حفظ في ملفاتي» puts a copy into the app's existing Files
 * library (lib/files-db, IndexedDB on this device) — no second storage system.
 */
import { useState } from "react";
import Icon from "@/components/icon";
import Modal from "@/components/modal";
import { useDialogs } from "@/components/dialogs";
import { bashtMediaUrl, type BashtMedia } from "@/lib/basht-client";
import { downloadBlob, putFiles } from "@/lib/files-db";
import type { LiveImage } from "./use-basht";
import "./chat-media.css";

export const formatBytes = (n: number | null | undefined) =>
  typeof n !== "number" ? "" : n < 1024 ? `${n} بايت` : n < 1024 * 1024 ? `${Math.round(n / 1024)} ك.ب` : `${(n / 1024 / 1024).toFixed(1)} م.ب`;

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

export default function MessageMedia({ sessionKey, messageId, media }: { sessionKey: string; messageId: string | null | undefined; media: BashtMedia[] | undefined }) {
  const { toast } = useDialogs();
  const [open, setOpen] = useState<{ url: string; name: string } | null>(null);
  if (!media?.length) return null;
  const url = (m: BashtMedia) => (m.ref && messageId ? bashtMediaUrl(sessionKey, messageId, m.ref) : null);
  const save = async (u: string, name: string) => {
    try { await saveToFiles(u, name); toast("حُفظ في ملفاتي"); } catch { toast("تعذّر الحفظ في ملفاتي.", "error"); }
  };
  const download = async (u: string, name: string) => {
    try { downloadBlob(await fetchBlob(u), name); } catch { toast("تعذّر تنزيل الملف.", "error"); }
  };
  const images = media.filter((m) => m.kind === "image" && m.available !== false && url(m));
  const others = media.filter((m) => !images.includes(m));
  return (
    <div className="msg-media">
      {images.length > 0 && (
        <div className={"media-grid n" + Math.min(images.length, 3)}>
          {images.map((m) => (
            <button key={m.ref} type="button" className="media-thumb" onClick={() => setOpen({ url: url(m)!, name: m.name })} aria-label={"عرض الصورة " + m.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url(m)!} alt={m.name} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      {others.map((m, i) => {
        if (m.kind === "link" && m.url) return (
          <a key={"l" + i} className="attach-chip media-chip" href={m.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={16} /><span>{m.name}</span></a>
        );
        const u = url(m);
        if (!u || m.available === false) return (
          <span key={m.ref ?? i} className="attach-chip media-chip unavailable" title="الملف غير متاح"><Icon name="file" size={16} /><span>{m.name}</span><small>غير متاح</small></span>
        );
        return (
          <span key={m.ref} className="attach-chip media-chip">
            <Icon name={m.mime === "application/pdf" ? "pdf" : "file"} size={16} /><span>{m.name}</span>{m.size ? <small className="num">{formatBytes(m.size)}</small> : null}
            <button type="button" className="icon-btn sm" onClick={() => void download(u, m.name)} aria-label={"تنزيل " + m.name}><Icon name="download" size={16} /></button>
            <button type="button" className="icon-btn sm" onClick={() => void save(u, m.name)} aria-label={"حفظ " + m.name + " في ملفاتي"}><Icon name="files" size={16} /></button>
          </span>
        );
      })}
      <Modal open={!!open} onClose={() => setOpen(null)} label={open ? "معاينة " + open.name : "معاينة"}>
        {open && (
          <div className="dialog-card wide">
            <div className="row"><strong style={{ flex: 1, overflowWrap: "anywhere" }}>{open.name}</strong><button className="icon-btn" onClick={() => setOpen(null)} aria-label="إغلاق المعاينة"><Icon name="close" size={20} /></button></div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="preview-img" src={open.url} alt={open.name} />
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => void download(open.url, open.name)}><Icon name="download" size={18} />تنزيل</button>
              <button className="btn" onClick={() => void save(open.url, open.name)}><Icon name="files" size={18} />حفظ في ملفاتي</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** The owner's photos on the live (still running) turn: shown from this device's memory until the engine's copy is in the history. */
export function LiveImages({ images }: { images: LiveImage[] | undefined }) {
  if (!images?.length) return null;
  return (
    <div className={"media-grid n" + Math.min(images.length, 3)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {images.map((m, i) => <span key={i} className="media-thumb"><img src={m.previewUrl} alt={m.name} /></span>)}
    </div>
  );
}
