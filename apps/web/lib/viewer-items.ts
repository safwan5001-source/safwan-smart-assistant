/** What the full-screen viewer shows: one entry per image / PDF of a message, from the server's media or a local copy. */
import { bashtMediaUrl, type BashtMedia } from "./basht-client";

export type ViewerItem = {
  id: string; kind: "image" | "pdf"; name: string; mime?: string | null; size?: number | null;
  /** Address to display / fetch: a same-origin server URL, or an object URL of a local copy. */
  src: string;
  /** The bytes, when they are already on the device (a local copy): no fetch, and share/download work at once. */
  blob?: Blob;
  local?: boolean;
};
/** A photo of the owner's message kept on this device (lib/attachment-store), with an object URL for the bubble. */
export type LocalImageView = { id: string; name: string; mime: string; size: number; width: number; height: number; url: string; blob: Blob };

/** The server can serve this image (it says it is available and gave a reference). */
export const serverImage = (m: BashtMedia) => m.kind === "image" && m.available !== false && !!m.ref;
export const isPdf = (m: BashtMedia) => m.kind === "file" && m.mime === "application/pdf";

export function viewerItems(a: { sessionKey: string | null; messageId: string | null | undefined; media: BashtMedia[] | undefined; local?: LocalImageView[] }): ViewerItem[] {
  const out: ViewerItem[] = [];
  const media = a.media ?? [];
  const serverImgs = media.filter(serverImage);
  if (a.sessionKey && a.messageId) {
    for (const m of media) {
      if ((serverImage(m) || (isPdf(m) && m.available !== false && m.ref))) {
        out.push({ id: `s:${a.messageId}:${m.ref}`, kind: m.kind === "image" ? "image" : "pdf", name: m.name, mime: m.mime ?? null, size: m.size ?? null,
          src: bashtMediaUrl(a.sessionKey, a.messageId, m.ref!) });
      }
    }
  }
  // the server's copy always wins; a local copy shows only while the server has no image for this message
  if (!serverImgs.length && a.local?.length) {
    for (const l of a.local) out.push({ id: `l:${l.id}`, kind: "image", name: l.name, mime: l.mime, size: l.size, src: l.url, blob: l.blob, local: true });
  }
  return out;
}
