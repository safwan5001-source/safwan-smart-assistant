/**
 * The life of one <img> in a message: loading → ready, or loading → error (the file is not there / the network dropped) with a
 * bounded «إعادة المحاولة». A retry reloads the SAME address with a cache-busting parameter; after `MAX_IMAGE_RETRIES` failed
 * retries the tile settles on «غير متاحة» with no button (no endless loop). Pure reducer: the component only dispatches the
 * browser's load / error events and the owner's tap.
 */
export const MAX_IMAGE_RETRIES = 3;
export type ImageLoadState = { url: string; attempt: number; status: "loading" | "ready" | "error"; src: string };
export type ImageLoadAction = { type: "load" } | { type: "error" } | { type: "retry" } | { type: "reset"; url: string };

/** The address of attempt n: the original for attempt 0, then `…&_r=n` (a new URL, so a failed response is never reused). */
export function bustUrl(url: string, attempt: number): string {
  if (attempt <= 0 || url.startsWith("blob:") || url.startsWith("data:")) return url;
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash), frag = hash < 0 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}_r=${attempt}${frag}`;
}
export const initImageLoad = (url: string): ImageLoadState => ({ url, attempt: 0, status: "loading", src: url });
export const canRetryImage = (s: ImageLoadState, max = MAX_IMAGE_RETRIES) => s.status === "error" && s.attempt < max;
export function reduceImageLoad(s: ImageLoadState, a: ImageLoadAction, max = MAX_IMAGE_RETRIES): ImageLoadState {
  switch (a.type) {
    case "load": return s.status === "loading" ? { ...s, status: "ready" } : s;
    case "error": return s.status === "loading" ? { ...s, status: "error" } : s;
    case "retry": return canRetryImage(s, max) ? { ...s, attempt: s.attempt + 1, status: "loading", src: bustUrl(s.url, s.attempt + 1) } : s;
    case "reset": return a.url === s.url ? s : initImageLoad(a.url);
  }
}
/** The reducer for `useReducer` (the app's retry bound). */
export const imageLoadReducer = (s: ImageLoadState, a: ImageLoadAction): ImageLoadState => reduceImageLoad(s, a);
