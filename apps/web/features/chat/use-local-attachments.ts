"use client";
/**
 * Connects the device-local photo copies to the conversation on screen: which history row each copy belongs to (lib/attachment-match;
 * decisions are persisted when safe, and dropped when the bound row no longer stands for the record), the photos for those bubbles
 * (lib/local-image-views: loading → ready | failed, URLs revoked when no longer shown), and the sent photos whose row has not
 * appeared in the history (shown as the owner's own bubble, so the message never vanishes).
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { BashtMessage } from "@/lib/basht-client";
import { localAttachments } from "@/lib/local-attachments";
import { matchAttachments, pendingRecords, type MatchRow } from "@/lib/attachment-match";
import { createImageViews, pendingState, rowLocalState, type PendingView } from "@/lib/local-image-views";
import { serverImage } from "@/lib/viewer-items";

/** The key a history row is matched and persisted under: its engine id; a row without one only matches for this view. */
export const localRowKey = (m: { id?: string | null }, i: number) => m.id ?? `idx:${i}`;
export type PendingLocal = PendingView;

export function useLocalAttachments(rows: BashtMessage[] | null, opts: { enabled: boolean; liveRunId: string | null; windowed: boolean }) {
  const mgr = localAttachments();
  const records = useSyncExternalStore(mgr.subscribe, mgr.getSnapshot, mgr.getSnapshot);
  // (re)reads the saved copies: once on open, and again on a history load while the last read had failed (cool-down inside; cheap otherwise)
  useEffect(() => { if (opts.enabled) void mgr.load(); }, [mgr, opts.enabled, rows]);
  const views = useRef<ReturnType<typeof createImageViews> | null>(null);
  if (!views.current) views.current = createImageViews(mgr);
  const snap = useSyncExternalStore(views.current.subscribe, views.current.getSnapshot, views.current.getSnapshot);

  const plan = useMemo(() => {
    const none = { matches: new Map<string, string>(), fresh: [] as ReturnType<typeof matchAttachments>["fresh"], unbind: [] as string[], pending: [] as { clientMsgId: string; text: string; sentAt: number }[] };
    if (!opts.enabled || !rows || !records.length) return none;
    const mrows: MatchRow[] = rows.map((m, i) => ({ key: localRowKey(m, i), role: m.role, text: m.text, at: m.at, hasServerMedia: (m.media ?? []).some(serverImage), runId: m.runId ?? null }));
    const r = matchAttachments(mrows, records);
    const pending = opts.windowed ? [] : pendingRecords(mrows, records, r.matches, { now: Date.now(), liveRunIds: opts.liveRunId ? [opts.liveRunId] : [], skewFor: r.skewFor });
    return { matches: r.matches, fresh: r.fresh, unbind: r.unbind, pending };
  }, [rows, records, opts.enabled, opts.windowed, opts.liveRunId]);

  // persist what is safe to persist (a row without an engine id has a positional key: never persisted); drop bindings that no longer hold
  useEffect(() => {
    for (const f of plan.fresh) if (f.persist && !f.rowKey.startsWith("idx:")) mgr.bind(f.clientMsgId, f.rowKey);
    for (const id of plan.unbind) mgr.unbind(id);
  }, [plan.fresh, plan.unbind, mgr]);

  // the photos of the records shown (matched or pending)
  const wanted = useMemo(() => [...new Set([...plan.matches.values(), ...plan.pending.map((p) => p.clientMsgId)])], [plan.matches, plan.pending]);
  useEffect(() => { views.current!.want(wanted); }, [wanted]);
  useEffect(() => () => views.current?.dispose(), []);

  const local = useMemo(() => rowLocalState(plan.matches, snap), [plan.matches, snap]);
  const pending = useMemo(() => pendingState(plan.pending, snap), [plan.pending, snap]);
  /** «إعادة المحاولة» on an unavailable tile: read the saved-copies list again if that failed, and the failed device photos (once per press). */
  const retry = useCallback(() => { void mgr.load({ force: true }); views.current?.retryFailed(); }, [mgr]);
  return { byRow: local.byRow, loadingRows: local.loadingRows, failedRows: local.failedRows, pending, retry };
}
