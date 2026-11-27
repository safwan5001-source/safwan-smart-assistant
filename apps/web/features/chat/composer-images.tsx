"use client";
/**
 * B2 photos in: the composer's attach button (the same clip button and picker — on iPhone it offers Photo Library, Take Photo and
 * Files). With BASHT on, pictures are prepared here (downscaled, re-encoded: no EXIF/location) and wait as thumbnails until send;
 * other files keep the existing on-device behaviour (Files library) with an honest «قريبًا» note — documents do not reach BASHT yet.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Icon from "@/components/icon";
import { IMAGE_LIMITS, type PreparedImage } from "@/lib/image-prep";
import { createComposerPhotos } from "@/lib/composer-photos";
import { formatBytes } from "./message-media";

/** The composer's photos (lib/composer-photos: serialized preparation reconciled with the latest state; previews revoked). */
export function useComposerImages() {
  const [store] = useState(() => createComposerPhotos());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => () => store.dispose(), [store]);
  /** Splits picked files: photos are queued for BASHT, the rest is returned to the caller (kept on the device as before). */
  const take = useCallback(async (files: File[]): Promise<File[]> => store.take(files).rest as File[], [store]);
  const remove = useCallback((id: string) => store.remove(id), [store]);
  /** After a send: the photos now belong to the turn (use-basht adopts their previews for the live bubble and a retry). */
  const clear = useCallback(() => { store.handOff(); }, [store]);
  const setError = useCallback((e: string) => store.setError(e), [store]);
  return { images: state.images, preparing: state.preparing > 0, error: state.error, take, remove, clear, setError };
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
