/**
 * Photos for BASHT (B2): every picture the owner attaches is decoded and re-encoded HERE, on the device, before it is sent:
 * - downscaled (longest edge <= 2048 px) and compressed to a small JPEG (target <= 1.5 MB each), so a turn stays light on mobile data;
 * - re-encoding through a canvas keeps only pixels: EXIF (including GPS location), maker notes and thumbnails are dropped;
 * - limits match the engine (<= 8 images, <= 10 MB each, <= 14 MB per message, so the request stays under its 20 MB cap).
 * Nothing here is stored: the bytes live in memory until the turn is sent (or retried).
 */
export const IMAGE_LIMITS = {
  maxImages: 8,
  maxEdge: 2048,
  targetBytes: 1.5 * 1024 * 1024,
  maxBytesEach: 10 * 1024 * 1024,
  maxTotalBytes: 14 * 1024 * 1024,
  /** a source file larger than this is not even decoded (memory on older phones) */
  maxSourceBytes: 40 * 1024 * 1024,
} as const;

const EDGES = [2048, 1600, 1280, 1024];
const QUALITIES = [0.82, 0.72, 0.62, 0.5];

export type PreparedImage = { id: string; name: string; mime: "image/jpeg"; bytes: number; width: number; height: number; data: string; previewUrl: string };
export type Decoded = { width: number; height: number; source: unknown; close?: () => void };
export type Codec = {
  decode: (file: Blob) => Promise<Decoded>;
  encode: (img: Decoded, width: number, height: number, quality: number) => Promise<Blob>;
  previewUrl: (blob: Blob) => string;
};

/** The size to draw at: the longest edge capped at `maxEdge`, aspect kept, never upscaled, at least 1 px. */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Base64 of raw bytes, encoded in 32 KiB chunks (a single String.fromCharCode(...bytes) overflows the stack on photos). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export const looksLikeImage = (f: { type?: string; name?: string }) =>
  (f.type ?? "").startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(f.name ?? "");

export class ImagePrepError extends Error { constructor(public code: "too_many" | "too_large" | "unreadable" | "total_too_large") { super(IMAGE_ERROR_TEXT[code]); } }
export const IMAGE_ERROR_TEXT = {
  too_many: `يمكن إرسال ${IMAGE_LIMITS.maxImages} صور كحد أقصى في الرسالة.`,
  too_large: "الصورة كبيرة جدًا حتى بعد ضغطها.",
  unreadable: "تعذّرت قراءة هذه الصورة على هذا الجهاز.",
  total_too_large: "الصور كبيرة جدًا معًا؛ أرسل عددًا أقل.",
} as const;

let seq = 0;
/** Decodes, downscales and re-encodes one photo; tries smaller sizes/qualities until it fits the target (or the hard cap). */
export async function prepareImage(file: Blob & { name?: string }, codec: Codec = browserCodec()): Promise<PreparedImage> {
  if (file.size > IMAGE_LIMITS.maxSourceBytes) throw new ImagePrepError("too_large");
  let img: Decoded;
  try { img = await codec.decode(file); } catch { throw new ImagePrepError("unreadable"); }
  try {
    let best: Blob | null = null; let dims = { width: 0, height: 0 };
    outer: for (const edge of EDGES) {
      const d = fitSize(img.width, img.height, Math.min(edge, IMAGE_LIMITS.maxEdge));
      for (const q of QUALITIES) {
        const blob = await codec.encode(img, d.width, d.height, q);
        if (!best || blob.size < best.size) { best = blob; dims = d; }
        if (blob.size <= IMAGE_LIMITS.targetBytes) break outer;
      }
    }
    if (!best || best.size > IMAGE_LIMITS.maxBytesEach) throw new ImagePrepError("too_large");
    const data = bytesToBase64(new Uint8Array(await best.arrayBuffer()));
    return { id: `img-${Date.now().toString(36)}-${++seq}`, name: (file.name || "صورة").replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg",
      bytes: best.size, ...dims, data, previewUrl: codec.previewUrl(best) };
  } finally { img.close?.(); }
}

/** Adds photos to the ones already waiting in the composer, enforcing the per-message count and total size. */
export async function addImages(current: PreparedImage[], files: (Blob & { name?: string })[], codec?: Codec): Promise<PreparedImage[]> {
  if (current.length + files.length > IMAGE_LIMITS.maxImages) throw new ImagePrepError("too_many");
  const out = [...current];
  for (const f of files) {
    const p = await prepareImage(f, codec);
    if (out.reduce((n, x) => n + x.bytes, 0) + p.bytes > IMAGE_LIMITS.maxTotalBytes) throw new ImagePrepError("total_too_large");
    out.push(p);
  }
  return out;
}

/** The browser codec: createImageBitmap (honours EXIF orientation, then forgets EXIF) -> canvas on white -> JPEG. */
export function browserCodec(): Codec {
  return {
    async decode(file) {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    },
    async encode(img, width, height, quality) {
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); // transparent PNGs become white, not black
      ctx.drawImage(img.source as CanvasImageSource, 0, 0, width, height);
      if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
      return new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality));
    },
    previewUrl: (blob) => URL.createObjectURL(blob),
  };
}

/** Does the app conversation's current model read images? true / false / null (unknown: the engine did not say). */
export function modelReadsImages(modelId: string | null | undefined, models: { id: string; input: string[] }[] | null | undefined): boolean | null {
  if (!modelId || !models?.length) return null;
  const row = models.find((m) => m.id === modelId);
  if (!row || !row.input.length) return null;
  return row.input.includes("image");
}
