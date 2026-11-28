/**
 * A picture's «إعادة المحاولة» re-reads the history. It must refresh what is ON SCREEN: inside a search-result window that is the
 * window around the picked message (its media metadata is refreshed in place — the window, its focus and the paged-in rows stay),
 * never the newest page (that would silently leave the window and scroll the owner away from the message). On the newest page it is the
 * ordinary latest-page load.
 */
import type { BashtMessage, BashtPage } from "./basht-client";

export type ReloadOutcome = { kind: "latest" } | { kind: "window"; messages: BashtMessage[] };

export async function reloadCurrentView(a: {
  /** A search window (not the newest page) is on screen, and the message it was opened around. */
  windowed: boolean; anchor: string | null;
  fetchAround: (messageId: string) => Promise<Pick<BashtPage, "messages">>;
  loadLatest: () => void | Promise<void>;
}): Promise<ReloadOutcome> {
  if (a.windowed && a.anchor) return { kind: "window", messages: (await a.fetchAround(a.anchor)).messages };
  await a.loadLatest();
  return { kind: "latest" };
}
