"use client";
/**
 * Connects the device-local photo copies to the conversation on screen: which history row each copy belongs to (lib/attachment-match;
 * new matches are persisted), the object URLs for those bubbles (revoked when no longer shown), and the sent photos whose row has
 * not appeared in the history (shown as the owner's own bubble, so the message never vanishes).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BashtMessage } from "@/lib/basht-client";
import { localAttachments } from "@/lib/local-attachments";
import { matchAttachments, pendingRecords, type MatchRow } from "@/lib/attachment-match";
import { serverImage, type LocalImageView } from "@/lib/viewer-items";

/** The key a history row is matched and persisted under: its engine id; a row without one only matches for this view. */
export const localRowKey = (m: { id?: string | null }, i: number) => m.id ?? `idx:${i}`;

export type PendingLocal = { clientMsgId: string; text: string; sentAt: number; images: LocalImageView[] };

export function useLocalAttachments(rows: BashtMessage[] | null, opts: { enabled: boolean; liveRunId: string | null; windowed: boolean }) {
  const mgr = localAttachments();
  const records = useSyncExternalStore(mgr.subscribe, mgr.getSnapshot, mgr.getSnapshot);
  useEffect(() => { if (opts.enabled) void mgr.load(); }, [mgr, opts.enabled]);

  const plan = useMemo(() => {
    if (!opts.enabled || !rows || !records.length) return { matches: new Map<string, string>(), fresh: [] as { rowKey: string; clientMsgId: string }[], pending: [] as string[] };
    const mrows: MatchRow[] = rows.map((m, i) => ({ key: localRowKey(m, i), role: m.role, text: m.text, at: m.at, hasServerMedia: (m.media ?? []).some(serverImage),
      runId: (m as { runId?: string | null }).runId ?? null }));
    const r = matchAttachments(mrows, records);
    const pending = opts.windowed ? [] : pendingRecords(mrows, records, r.matches, { now: Date.now(), liveRunIds: opts.liveRunId ? [opts.liveRunId] : [] }).map((c) => c.clientMsgId);
    return { matches: r.matches, fresh: r.fresh, pending };
  }, [rows, records, opts.enabled, opts.windowed, opts.liveRunId]);

  // persist the matches decided now (a row without an engine id is not persisted: its key is positional)
  useEffect(() => { for (const f of plan.fresh) if (!f.rowKey.startsWith("idx:")) mgr.bind(f.clientMsgId, f.rowKey); }, [plan.fresh, mgr]);

  // object URLs for the records shown (matched or pending), made when first needed and revoked when no longer shown / on unmount
  const wanted = useMemo(() => [...new Set([...plan.matches.values(), ...plan.pending])], [plan.matches, plan.pending]);
  const urls = useRef(new Map<string, LocalImageView[]>());
  const claims = useRef(new Map<string, symbol>()); // one load per record; a stale load never lands after its claim was dropped
  const mounted = useRef(true);
  const [version, bump] = useState(0);
  const drop = (id: string) => { urls.current.get(id)?.forEach((i) => URL.revokeObjectURL(i.url)); urls.current.delete(id); claims.current.delete(id); };
  useEffect(() => {
    mounted.current = true;
    for (const id of [...claims.current.keys()]) if (!wanted.includes(id)) drop(id);
    for (const id of wanted) {
      if (claims.current.has(id)) continue;
      const claim = Symbol(id);
      claims.current.set(id, claim);
      void mgr.images(id).then((imgs) => {
        if (!mounted.current || claims.current.get(id) !== claim) return;
        if (!imgs?.length) { claims.current.delete(id); return; }
        urls.current.set(id, imgs.map((i) => ({ id: `${id}:${i.id}`, name: i.name, mime: i.mime, size: i.size, width: i.width, height: i.height, blob: i.blob, url: URL.createObjectURL(i.blob) })));
        bump((n) => n + 1);
      }, () => { if (claims.current.get(id) === claim) claims.current.delete(id); });
    }
  }, [wanted, mgr]);
  useEffect(() => () => { mounted.current = false; for (const id of [...claims.current.keys()]) drop(id); }, []);

  const byRow = useMemo(() => {
    const out = new Map<string, LocalImageView[]>();
    for (const [rowKey, id] of plan.matches) { const v = urls.current.get(id); if (v?.length) out.set(rowKey, v); }
    return out;
  }, [plan.matches, version]); // eslint-disable-line react-hooks/exhaustive-deps -- `version` = a record's object URLs were made
  /** Rows matched to a copy whose photos are still being read from the device (no «unavailable» flash meanwhile). */
  const loadingRows = useMemo(() => new Set([...plan.matches].filter(([, id]) => !urls.current.get(id)?.length && claims.current.has(id)).map(([k]) => k)),
    [plan.matches, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo((): PendingLocal[] => {
    const byId = new Map(records.map((r) => [r.clientMsgId, r]));
    return plan.pending.flatMap((id) => { const r = byId.get(id); return r ? [{ clientMsgId: id, text: r.text, sentAt: r.sentAt, images: urls.current.get(id) ?? [] }] : []; });
  }, [plan.pending, records, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { byRow, pending, loadingRows };
}
