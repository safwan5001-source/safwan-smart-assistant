/**
 * Where the chat log scrolls after a render (B1). A focus request (a search hit, the first row of an earlier page) scrolls
 * to its message ONCE, as soon as that message is on screen; later renders (a streaming reply, a poll) never pull the
 * owner back to it. Without a focus, the log follows the newest message while the owner is at the bottom, and clearing a
 * focus («العودة إلى الأحدث», a send, a refresh) returns to the end.
 */
export type FocusScroll = { last: string | null; pending: string | null };

export const newFocusScroll = (): FocusScroll => ({ last: null, pending: null });

export function nextScroll(
  s: FocusScroll,
  focusId: string | null,
  onScreen: (id: string) => boolean,
  following: boolean,
): { to: "focus"; id: string } | { to: "bottom" } | null {
  const unfocused = s.last !== null && focusId === null;
  if (focusId !== s.last) s.pending = focusId; // a new focus request (or none)
  s.last = focusId;
  if (s.pending !== null) {
    if (!onScreen(s.pending)) return null; // wait for it: never jump to the end under a pending focus
    const id = s.pending;
    s.pending = null;
    return { to: "focus", id };
  }
  return following || unfocused ? { to: "bottom" } : null;
}
