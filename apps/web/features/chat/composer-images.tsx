"use client";
/**
 * B2 photos in: the composer's attach button (the same clip button and picker — on iPhone it offers Photo Library, Take Photo and
 * Files). With BASHT on, pictures are prepared here (downscaled, re-encoded: no EXIF/location) and wait as thumbnails until send;
 * other files keep the existing on-device behaviour (Files library) with an honest «قريبًا» note — documents do not reach BASHT yet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import { addImages, ImagePrepError, IMAGE_LIMITS, looksLikeImage, type PreparedImage } from "@/lib/image-prep";
import { formatBytes } from "./message-media";

export function useComposerImages() {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef(images);
  ref.current = images;
  useEffect(() => () => { ref.current.forEach((i) => URL.revokeObjectURL(i.previewUrl)); }, []);

  /** Splits picked files: photos are prepared for BASHT, the rest is returned to the caller (kept on the device as before). */
  const take = useCallback(async (files: File[]): Promise<File[]> => {
    const pics = files.filter(looksLikeImage);
    const rest = files.filter((f) => !looksLikeImage(f));
    if (!pics.length) return rest;
    setPreparing(true); setError("");
    try { setImages(await addImages(ref.current, pics)); }
    catch (e) { setError(e instanceof ImagePrepError ? e.message : "تعذّر تجهيز الصورة."); }
    finally { setPreparing(false); }
    return rest;
  }, []);
  const remove = useCallback((id: string) => setImages((l) => { const x = l.find((i) => i.id === id); if (x) URL.revokeObjectURL(x.previewUrl); return l.filter((i) => i.id !== id); }), []);
  /** After a send: the previews stay alive for the live bubble (and a retry); they are released when the page goes away. */
  const clear = useCallback(() => { setImages([]); setError(""); }, []);
  return { images, preparing, error, take, remove, clear, setError };
}

export function ComposerImages({ images, preparing, onRemove, modelReads, modelName }: {
  images: PreparedImage[]; preparing: boolean; onRemove: (id: string) => void; modelReads: boolean | null; modelName: string;
}) {
  if (!images.length && !preparing) return null;
  const total = images.reduce((n, i) => n + i.bytes, 0);
  return (
    <div className="composer-images">
      <div className="row-wrap">
        {images.map((i) => (
          <span key={i.id} className="composer-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={i.previewUrl} alt={i.name} />
            <button type="button" className="icon-btn sm" aria-label={"إزالة الصورة " + i.name} onClick={() => onRemove(i.id)}><Icon name="close" size={14} /></button>
          </span>
        ))}
        {preparing && <span className="composer-thumb pending" aria-live="polite"><span className="spinner" aria-hidden="true" />تجهيز…</span>}
      </div>
      <small className="muted num">{images.length}/{IMAGE_LIMITS.maxImages} · {formatBytes(total)} · تُضغط على جهازك وتُزال منها بيانات الموقع</small>
      {modelReads === false && (
        <small role="alert" className="model-note">النموذج الحالي ({modelName || "غير معروف"}) لا يقرأ الصور، فلن يراها باشت. اختر نموذجًا يقرأ الصور من زر النموذج، أو أرسلها على أي حال.</small>
      )}
    </div>
  );
}
