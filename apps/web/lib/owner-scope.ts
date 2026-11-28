/**
 * Which owner is signed in on this device, as an opaque id the server derived (GET /api/auth/status → `owner_scope`). Device-local
 * data that belongs to one owner (the saved photo copies) is kept per scope, so a different owner on the same browser never sees it.
 * `null` = not known (status not loaded yet, signed out, the server could not be asked, or the gate is off): nothing scoped is read
 * or written then — there is NO unscoped fallback.
 */
import { parseOwnerScope } from "./owner-auth";

let current: string | null = null;
const listeners = new Set<() => void>();
export const getOwnerScope = (): string | null => current;
/** Sets the scope from a server answer (anything that is not a well-formed id means "unknown"). */
export function setOwnerScope(v: unknown): void {
  const next = parseOwnerScope(v);
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}
export const subscribeOwnerScope = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const resetOwnerScopeForTests = () => { current = null; listeners.clear(); };
