/**
 * Share / download / open one image or file from the viewer. Order: the system share sheet with the real file
 * (`navigator.share({ files })` when `canShare({ files })` — on iOS this also offers «حفظ الصورة»), else a blob download through
 * `<a download>`, else the file in a new tab. Every failing path ends in a short Arabic message — never silence. The owner
 * dismissing the share sheet (AbortError) is not an error. No markup is ever built from strings here; the object URLs it makes are revoked.
 *
 * The bytes are passed IN (the viewer fetches them as soon as the item is shown): the share sheet must be called from the tap
 * itself, and iOS refuses it after a slow `await fetch()`.
 */
export type ShareHost = {
  navigator?: { share?: (d: { files?: File[]; title?: string }) => Promise<void>; canShare?: (d: { files?: File[] }) => boolean };
  document?: { createElement: (t: "a") => { href: string; download: string; rel: string; style: { display: string }; click: () => void; remove: () => void }; body: { appendChild: (n: never) => unknown } };
  URL?: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
  open?: (url: string, target: string) => unknown;
  File?: typeof File;
  setTimeout?: (f: () => void, ms: number) => unknown;
};
export type ShareOutcome = { status: "shared" | "cancelled" | "downloaded" | "opened" | "failed"; message?: string };

export const SHARE_TEXT = {
  shareFailed: "تعذّرت المشاركة. جرّب التنزيل.",
  downloadFailed: "تعذّر تنزيل الملف.",
  openFailed: "تعذّر فتح الملف. جرّب التنزيل.",
  noFile: "الملف غير جاهز بعد.",
} as const;

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";
const browserHost = (): ShareHost => ({
  navigator: typeof navigator === "undefined" ? undefined : (navigator as unknown as ShareHost["navigator"]),
  document: typeof document === "undefined" ? undefined : (document as unknown as ShareHost["document"]),
  URL: typeof URL === "undefined" ? undefined : URL, open: typeof window === "undefined" ? undefined : window.open.bind(window),
  File: typeof File === "undefined" ? undefined : File, setTimeout: (f, ms) => setTimeout(f, ms),
});
const later = (h: ShareHost, f: () => void, ms: number) => (h.setTimeout ?? setTimeout)(f, ms);

/** Saves through an invisible `<a download>` click. Returns false when the browser cannot do it. */
export function downloadBlobFile(blob: Blob, name: string, host: ShareHost = browserHost()): boolean {
  try {
    if (!host.document || !host.URL) return false;
    const url = host.URL.createObjectURL(blob);
    const a = host.document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
    host.document.body.appendChild(a as never);
    a.click(); a.remove();
    later(host, () => host.URL?.revokeObjectURL(url), 60_000); // the browser reads it after the click: revoke later
    return true;
  } catch { return false; }
}

/** Opens the file in a new tab (last resort). Returns false when blocked or unsupported. */
export function openBlobFile(blob: Blob, host: ShareHost = browserHost()): boolean {
  try {
    if (!host.URL || !host.open) return false;
    const url = host.URL.createObjectURL(blob);
    // no "noopener" feature: it makes window.open() return null even on success, and then a blocked popup cannot be told apart
    const w = host.open(url, "_blank") as { opener?: unknown } | null | undefined;
    if (w) { try { w.opener = null; } catch { /* cross-origin */ } }
    later(host, () => host.URL?.revokeObjectURL(url), 5 * 60_000);
    return !!w;
  } catch { return false; }
}

export async function shareFile(blob: Blob | null | undefined, name: string, host: ShareHost = browserHost()): Promise<ShareOutcome> {
  if (!blob) return { status: "failed", message: SHARE_TEXT.noFile };
  const nav = host.navigator; const FileCtor = host.File;
  let file: File | null = null;
  try { if (FileCtor) file = new FileCtor([blob], name, { type: blob.type }); } catch { file = null; }
  if (file && nav?.share && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title: name }); return { status: "shared" }; }
    catch (e) {
      if (isAbort(e)) return { status: "cancelled" };
      // the share sheet refused (no activation, not allowed): fall through to the download, then the new tab
    }
  }
  return saveFile(blob, name, host, SHARE_TEXT.shareFailed);
}

export async function downloadFile(blob: Blob | null | undefined, name: string, host: ShareHost = browserHost()): Promise<ShareOutcome> {
  if (!blob) return { status: "failed", message: SHARE_TEXT.noFile };
  return saveFile(blob, name, host, SHARE_TEXT.downloadFailed);
}

function saveFile(blob: Blob, name: string, host: ShareHost, failMessage: string): ShareOutcome {
  if (downloadBlobFile(blob, name, host)) return { status: "downloaded" };
  if (openBlobFile(blob, host)) return { status: "opened" };
  return { status: "failed", message: failMessage };
}

export function openFile(blob: Blob | null | undefined, host: ShareHost = browserHost()): ShareOutcome {
  if (!blob) return { status: "failed", message: SHARE_TEXT.noFile };
  return openBlobFile(blob, host) ? { status: "opened" } : { status: "failed", message: SHARE_TEXT.openFailed };
}
