/**
 * B2 photo state outside React (testable in node):
 * - `createComposerPhotos`: the photos waiting in the composer. Preparation runs one batch at a time and every prepared photo is
 *   reconciled with the LATEST state when it lands (a photo removed meanwhile stays removed; batches never overwrite each other;
 *   the 8-image cap and the 14 MB total hold). Every preview URL it creates is revoked by it, unless it was handed off to a turn.
 * - `turnPreviews`: the preview URLs of photos already SENT. They belong to the live bubble and to «إعادة المحاولة»; they are
 *   revoked once neither needs them (the turn finished, a newer turn replaced it, or «محادثة جديدة»).
 */
import { ImagePrepError, IMAGE_LIMITS, looksLikeImage, prepareImage, type Codec, type PreparedImage } from "./image-prep";

export type ComposerPhotosState = { images: PreparedImage[]; preparing: number; error: string };
type Deps = { codec?: Codec; revoke?: (url: string) => void };

const defaultRevoke = (url: string) => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } };

export function createComposerPhotos({ codec, revoke = defaultRevoke }: Deps = {}) {
  let state: ComposerPhotosState = { images: [], preparing: 0, error: "" };
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ComposerPhotosState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
  const total = (l: PreparedImage[]) => l.reduce((n, i) => n + i.bytes, 0);

  return {
    getSnapshot: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    /** Splits picked files: photos are queued for preparation (one batch at a time); the rest is returned to the caller. */
    take(files: (Blob & { name?: string; type?: string })[]): { rest: typeof files; done: Promise<void> } {
      const pics = files.filter((f) => looksLikeImage(f));
      const rest = files.filter((f) => !looksLikeImage(f));
      if (!pics.length) return { rest, done: Promise.resolve() };
      if (state.images.length + state.preparing + pics.length > IMAGE_LIMITS.maxImages) {
        set({ error: new ImagePrepError("too_many").message });
        return { rest, done: Promise.resolve() };
      }
      set({ preparing: state.preparing + pics.length, error: "" });
      const run = async () => {
        for (const f of pics) {
          let p: PreparedImage | null = null; let error = "";
          try { p = await prepareImage(f, codec); } catch (e) { error = e instanceof ImagePrepError ? e.message : "تعذّر تجهيز الصورة."; }
          if (p && disposed) { revoke(p.previewUrl); continue; }
          // reconcile with what is on screen NOW (removals and other batches since this one started)
          if (p && state.images.length >= IMAGE_LIMITS.maxImages) { revoke(p.previewUrl); p = null; error = new ImagePrepError("too_many").message; }
          if (p && total(state.images) + p.bytes > IMAGE_LIMITS.maxTotalBytes) { revoke(p.previewUrl); p = null; error = new ImagePrepError("total_too_large").message; }
          set({ images: p ? [...state.images, p] : state.images, preparing: Math.max(0, state.preparing - 1), ...(error ? { error } : {}) });
        }
      };
      const done = queue.then(run, run);
      queue = done.catch(() => {});
      return { rest, done };
    },
    remove(id: string) {
      const x = state.images.find((i) => i.id === id);
      if (x) revoke(x.previewUrl);
      set({ images: state.images.filter((i) => i.id !== id) });
    },
    /** After a send: the photos now belong to the turn (turnPreviews); they leave the composer WITHOUT being revoked here. */
    handOff(): PreparedImage[] { const out = state.images; set({ images: [], error: "" }); return out; },
    setError(error: string) { set({ error }); },
    /** The composer is gone: revoke what is still waiting, and whatever a running preparation still produces. */
    dispose() { disposed = true; state.images.forEach((i) => revoke(i.previewUrl)); state = { images: [], preparing: 0, error: "" }; },
  };
}
export type ComposerPhotos = ReturnType<typeof createComposerPhotos>;

/** Preview URLs of sent photos (module scope, like the run in flight: a turn survives navigating away and back). */
export function createTurnPreviews(revoke: (url: string) => void = defaultRevoke) {
  const owned = new Set<string>();
  return {
    adopt(urls: string[]) { urls.forEach((u) => owned.add(u)); },
    /** Revokes `urls` that are still owned and not in `keep` (the turn that still shows/retries them). */
    release(urls: string[], keep: string[] = []) {
      for (const u of urls) if (owned.has(u) && !keep.includes(u)) { owned.delete(u); revoke(u); }
    },
    size: () => owned.size,
  };
}
export const turnPreviews = createTurnPreviews();
