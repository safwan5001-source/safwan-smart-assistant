/**
 * One rule for a picture's «إعادة المحاولة»: it refreshes the AFFECTED MESSAGE wherever it lives — the newest page, a search window,
 * rows paged in through «عرض الرسائل السابقة» (also those paged in while a window is open) — by re-reading a page around that
 * message and replacing only its media metadata in the rows already on screen. It never changes the view: the window, the focus,
 * the cursor and how much is paged in all stay exactly as they were.
 */
import type { BashtMessage } from "./basht-client";

/** The message `id` as the freshly read page has it, or undefined (the engine no longer returns it). */
export const freshRow = (page: { messages: readonly BashtMessage[] }, id: string): BashtMessage | undefined => page.messages.find((m) => m.id === id);

/** `rows` with the media of message `id` replaced; the SAME array when `id` is not in it (so state does not change). */
export function patchRowMedia(rows: BashtMessage[], id: string, fresh: Pick<BashtMessage, "media">): BashtMessage[] {
  const i = rows.findIndex((m) => m.id === id);
  if (i < 0) return rows;
  return rows.map((m, k) => (k === i ? { ...m, media: fresh.media } : m));
}

/**
 * Reads the page around `id` and returns the refreshed row, or null when it cannot be refreshed: no id (a row without an engine id
 * cannot be addressed), or the engine no longer returns it.
 */
export async function refreshMessageMedia(id: string | null | undefined, fetchAround: (id: string) => Promise<{ messages: readonly BashtMessage[] }>): Promise<BashtMessage | null> {
  if (!id) return null;
  return freshRow(await fetchAround(id), id) ?? null;
}

/**
 * The whole refresh, with the state holders injected (the hook gives its setters): reads the page around the message, then patches
 * the freshly read media into BOTH row lists the screen is built from — `messages` (newest page or search window) and `olderRows`
 * (paged in) — touching nothing else. Returns "no-id" (the caller may fall back), "gone" (the engine no longer returns it),
 * "stale" (a load started meanwhile and carries newer data) or "refreshed".
 */
export async function refreshInto(a: {
  id: string | null | undefined;
  fetchAround: (id: string) => Promise<{ messages: readonly BashtMessage[] }>;
  /** The load generation when the retry was pressed, and now. */
  startedAt: number; now: () => number;
  setMessages: (f: (m: BashtMessage[] | null) => BashtMessage[] | null) => void;
  setOlderRows: (f: (o: BashtMessage[]) => BashtMessage[]) => void;
}): Promise<"no-id" | "gone" | "stale" | "refreshed"> {
  if (!a.id) return "no-id";
  const id = a.id;
  const fresh = await refreshMessageMedia(id, a.fetchAround);
  if (!fresh) return "gone";
  if (a.now() !== a.startedAt) return "stale";
  a.setMessages((m) => (m ? patchRowMedia(m, id, fresh) : m));
  a.setOlderRows((o) => patchRowMedia(o, id, fresh));
  return "refreshed";
}
