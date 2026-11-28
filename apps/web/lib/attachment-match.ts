/**
 * Which history row does a device-local photo copy (lib/attachment-store) belong to? Pure functions, no I/O.
 *
 * The engine's history row of the owner's message carries `id`, `text`, `at`, (when the engine kept the photo) `media`, and — newer
 * engines — the `runId` of the turn it started. Guiding principle: when in doubt show NOTHING, never a possibly wrong photo.
 *  0. A row with AVAILABLE server image media never gets a local copy (the server's copy always wins).
 *  1. `runId` FIRST: the row exposes the run id /send returned for the record. This is the only exact key; it overrides any earlier
 *     text-only binding of that record (the stale row is dropped by re-binding) and claims its row before anything else can. Its
 *     samples (row time − send time) feed a clock-skew estimate, used only from pairs within an hour of the record, only when they
 *     agree, and never above 2 minutes.
 *  2. A persisted text binding (`record.matchedRowId`) of the remaining records holds while the bound row still stands for the
 *     record: its normalised text is still equal and it is not stamped with another run id nor claimed by another record. Otherwise
 *     the binding is dropped (`unbind`). A record never goes to two rows and a row never to two records.
 *  3. FALLBACK — same normalised text, a row WITHOUT a run id, and a plausible time: not more than 60 s after the send (the engine
 *     writes the user row when the run starts) and not earlier than 60 s before it (30 s with a known skew). Only records that can
 *     have a row take part: a run id from /send, not superseded by a retry, and a run that did not end in error/stopped (a turn
 *     that never produced a row would otherwise be paired with somebody else's identical message). A record is skipped when the
 *     engine stamps run ids on its recent rows (a row of this turn would have carried one). A group of exactly one row and one record
 *     matches; a group with equal counts pairs in time order (display only). It is REFUSED when
 *       - any other user row with the same text (whatever its media, wherever it came from) sits within 6 minutes of the record or
 *         of the row, or another candidate record with the same text does, or
 *       - the pairing would cross a known pair (records sorted by send time must map monotonically onto rows by time).
 *     A fallback match is PERSISTED only for an unambiguous 1:1 whose turn ended successfully; a pairing inside a group of 2+ is
 *     re-derived on every load, never stored. A record whose send was cut off by the network (`uncertain`: the engine may or may not
 *     have the turn) is tried only AFTER the confirmed records, and is never persisted.
 * A record WITHOUT a run id never matches a row that carries one (that row belongs to some run).
 * Text is compared after trimming, collapsing whitespace, removing invisible/bidi marks and the engine's media placeholders
 * (`<media:image>`, `[image]`, the sentence older engines used: «User sent image(s) with no text.»); the current engine returns
 * text «» for an image-only message.
 * Known limits (nothing is shown rather than a guess): a phone clock more than ~1 minute AHEAD of the engine's (rows then look
 * earlier than the send) or a slow upload (row later than 60 s after the send) matches nothing without a runId; failed or stopped
 * turns show no photo on their row unless the row carries the runId; identical texts sent within 6 minutes of each other with a
 * missing row on either side; rows paged out of the loaded history; an engine that rewrites captions beyond the placeholders above.
 */
export const MATCH_WINDOW_MS = 3 * 60_000;
/** The user row is written when the run starts: a fallback row may be at most this long AFTER the send. */
export const LATE_MS = 60_000;
/** How far BEFORE the send a row may be dated while the clock skew is unknown / known. */
export const EARLY_UNKNOWN_MS = 60_000;
export const EARLY_KNOWN_MS = 30_000;
/** Clock skew is estimated only from exact pairs this close (in send time) to the record, and only if they agree. */
export const SKEW_SAMPLE_WINDOW_MS = 60 * 60_000;
export const SKEW_SPREAD_MAX_MS = 2 * 60_000;
export const SKEW_MAX_MS = 2 * 60_000;
/** When the engine stamped a run id on an owner row this close to a record, a row of that record's turn would have carried one too. */
export const STAMPED_WINDOW_MS = 10 * 60_000;

export type MatchRow = {
  /** The row's stable key (its engine id; a row without an id cannot be persisted). */
  key: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
  /** `runId` of the turn this owner row started, if the engine exposes it. */
  runId?: string | null;
  /** The row already has at least one image the server can serve. */
  hasServerMedia: boolean;
};
export type MatchRecord = {
  clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string;
  /** The turn reached a terminal state (any) / how it ended. */
  runDone?: boolean; runEnd?: "done" | "error" | "stopped";
  superseded?: boolean;
  /** The send was cut off by the network: the engine may or may not have the turn (no run id was received). */
  uncertain?: boolean;
};

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const PLACEHOLDER = /User sent images?(?:\(s\))? with no text\.?|<media:[a-z0-9_-]+>|\[(?:media attached|image|images|photo|photos|attachment|صورة|صور|مرفق)[^\]\n]{0,200}\]|\((?:image|photo|صورة)\)/gi;
const squash = (t: string) => t.replace(INVISIBLE, "").normalize("NFC").replace(/\s+/g, " ").trim();
/** Text without the engine's media placeholders, whitespace collapsed. */
export const normalizeText = (t: string): string => squash(String(t ?? "").replace(PLACEHOLDER, " "));
/** The row has text, but only a media placeholder («[image]», «<media:image>»): no caption to show. */
export const isPlaceholderOnly = (t: string): boolean => squash(String(t ?? "")) !== "" && normalizeText(t) === "";

export type MatchResult = {
  /** row key → clientMsgId, for every row that shows a local copy (persisted matches included). */
  matches: Map<string, string>;
  /** Matches decided in this run. `persist`: store them (a runId match always; a text match only an unambiguous 1:1 of a finished turn). */
  fresh: { rowKey: string; clientMsgId: string; via: "runId" | "text"; persist: boolean }[];
  /** Persisted bindings that no longer hold (row text changed / another row claimed it): clear them. */
  unbind: string[];
  /** Records whose candidates were ambiguous (diagnostics/tests). */
  ambiguous: string[];
  /** Estimated clock skew (row time − send time, ms) for a record sent at `sentAt`, or null when unknown / unreliable. */
  skewFor: (sentAt: number) => number | null;
};

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
/** The skew of the exact pairs near `sentAt`, when they exist, agree and are small; otherwise null (stay strict). */
function skewOf(samples: readonly { sentAt: number; diff: number }[], sentAt: number): number | null {
  const near = samples.filter((x) => Math.abs(x.sentAt - sentAt) <= SKEW_SAMPLE_WINDOW_MS).map((x) => x.diff);
  if (!near.length || Math.max(...near) - Math.min(...near) > SKEW_SPREAD_MAX_MS) return null;
  const m = median(near);
  return Math.abs(m) > SKEW_MAX_MS ? null : m;
}

export function matchAttachments(rows: readonly MatchRow[], records: readonly MatchRecord[], opts: { windowMs?: number } = {}): MatchResult {
  const W = opts.windowMs ?? MATCH_WINDOW_MS;
  const matches = new Map<string, string>();
  const fresh: MatchResult["fresh"] = [];
  const unbind: string[] = [];
  const ambiguous: string[] = [];
  const usedRows = new Set<string>(); const usedRecs = new Set<string>();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const recById = new Map(records.map((c) => [c.clientMsgId, c]));
  const sortedRecs = [...records].sort((a, b) => a.sentAt - b.sentAt || a.clientMsgId.localeCompare(b.clientMsgId));
  const rowText = new Map(rows.map((r) => [r.key, normalizeText(r.text)]));
  const recText = new Map(records.map((c) => [c.clientMsgId, normalizeText(c.text)]));
  const samples: { sentAt: number; diff: number }[] = [];
  const pairs: { row: MatchRow; rec: MatchRecord }[] = [];
  const show = (row: MatchRow, rec: MatchRecord) => { if (!row.hasServerMedia) matches.set(row.key, rec.clientMsgId); };

  // 1. the exact key FIRST: the run id /send returned. It overrides any earlier text-only binding of that record (the old row is
  //    dropped by re-binding to the run-stamped row) and claims its row before any text binding can.
  for (const rec of sortedRecs) {
    if (!rec.runId) continue;
    const row = rows.find((r) => r.role === "user" && !usedRows.has(r.key) && r.runId === rec.runId);
    if (!row) continue;
    usedRecs.add(rec.clientMsgId); usedRows.add(row.key);
    samples.push({ sentAt: rec.sentAt, diff: row.at - rec.sentAt });
    pairs.push({ row, rec });
    show(row, rec);
    if (rec.matchedRowId !== row.key) fresh.push({ rowKey: row.key, clientMsgId: rec.clientMsgId, via: "runId", persist: true }); // (bind() replaces a stale binding)
  }

  // 2. persisted text bindings of the other records: kept while the bound row still stands for the record
  for (const rec of sortedRecs) {
    const id = rec.matchedRowId;
    if (!id || usedRecs.has(rec.clientMsgId)) continue;
    const row = byKey.get(id);
    if (usedRows.has(id)) { unbind.push(rec.clientMsgId); continue; } // another record already holds that row (an exact run id match, or an earlier binding)
    if (!row) { usedRows.add(id); usedRecs.add(rec.clientMsgId); continue; } // not loaded (paged out): the binding waits
    // a row stamped with some other run id than the record's (or any run id, for a record without one) is somebody else's message
    const clash = !!row.runId && row.runId !== rec.runId;
    if (row.role !== "user" || clash || rowText.get(row.key) !== recText.get(rec.clientMsgId)) { unbind.push(rec.clientMsgId); continue; }
    usedRows.add(id); usedRecs.add(rec.clientMsgId);
    pairs.push({ row, rec });
    show(row, rec);
  }
  const skewFor = (sentAt: number) => skewOf(samples, sentAt);

  // 3. fallback: text + a plausible time, per normalised text, refused whenever it could be someone else's row
  const stampedRows = rows.filter((r) => r.role === "user" && !!r.runId);
  const confirmedOk = (c: MatchRecord) => !!c.runId && !c.superseded && c.runEnd !== "error" && c.runEnd !== "stopped"
    && !stampedRows.some((r) => Math.abs(r.at - c.sentAt) <= STAMPED_WINDOW_MS);
  const uncertainOk = (c: MatchRecord) => !c.runId && !!c.uncertain && !c.superseded && !stampedRows.some((r) => Math.abs(r.at - c.sentAt) <= STAMPED_WINDOW_MS);
  const free = sortedRecs.filter((c) => !usedRecs.has(c.clientMsgId));
  const decided: { row: MatchRow; rec: MatchRecord; solo: boolean }[] = [];

  const fallback = (recsAll: MatchRecord[], rivalRecs: MatchRecord[]) => {
    // an unclaimed owner row WITH a run id belongs to some run; every other unclaimed owner row competes (any media, any device)
    const pool = rows.filter((r) => r.role === "user" && !usedRows.has(r.key) && !r.runId && !decided.some((d) => d.row === r));
    const poolByText = new Map<string, MatchRow[]>();
    for (const r of pool) { const t = rowText.get(r.key)!; (poolByText.get(t) ?? poolByText.set(t, []).get(t)!).push(r); }
    const byText = new Map<string, MatchRecord[]>();
    for (const c of recsAll) { const t = recText.get(c.clientMsgId)!; (byText.get(t) ?? byText.set(t, []).get(t)!).push(c); }
    const shiftOf = (c: MatchRecord) => skewFor(c.sentAt);
    const plausible = (r: MatchRow, c: MatchRecord) => {
      const k = shiftOf(c);
      const d = r.at - (c.sentAt + (k ?? 0));
      return d >= -(k === null ? EARLY_UNKNOWN_MS : EARLY_KNOWN_MS) && d <= LATE_MS;
    };
    for (const [text, recs] of byText) {
      const sameRows = poolByText.get(text) ?? [];
      const cand = sameRows.filter((r) => !r.hasServerMedia); // only these can show a local copy
      const parent = new Map<string, string>();
      const find = (x: string): string => { let p = parent.get(x) ?? x; while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p; parent.set(x, p); return p; };
      const linked = new Set<string>();
      for (const r of cand) for (const c of recs) if (plausible(r, c)) {
        const a = find("r:" + r.key), b = find("c:" + c.clientMsgId); if (a !== b) parent.set(a, b);
        linked.add("r:" + r.key); linked.add("c:" + c.clientMsgId);
      }
      const groups = new Map<string, { rows: MatchRow[]; recs: MatchRecord[] }>();
      const grp = (id: string) => groups.get(id) ?? groups.set(id, { rows: [], recs: [] }).get(id)!;
      for (const r of cand) if (linked.has("r:" + r.key)) grp(find("r:" + r.key)).rows.push(r);
      for (const c of recs) if (linked.has("c:" + c.clientMsgId)) grp(find("c:" + c.clientMsgId)).recs.push(c);
      for (const g of groups.values()) {
        const gr = [...g.rows].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
        const gc = [...g.recs].sort((a, b) => a.sentAt - b.sentAt || a.clientMsgId.localeCompare(b.clientMsgId));
        const near = (t: number, c: MatchRecord[], r: MatchRow[]) => c.some((x) => Math.abs(t - (x.sentAt + (shiftOf(x) ?? 0))) <= 2 * W) || r.some((x) => Math.abs(t - x.at) <= 2 * W);
        const otherRow = sameRows.some((r) => !gr.includes(r) && near(r.at, gc, gr));
        const otherRec = rivalRecs.some((c) => recText.get(c.clientMsgId) === text && !gc.includes(c) && near(c.sentAt + (shiftOf(c) ?? 0), gc, gr));
        const ok = gr.length === gc.length && gr.every((r, k) => plausible(r, gc[k])) && !otherRow && !otherRec;
        if (!ok) { ambiguous.push(...gc.map((c) => c.clientMsgId)); continue; }
        gr.forEach((r, k) => decided.push({ row: r, rec: gc[k], solo: gr.length === 1 }));
      }
    }
  };
  const confirmed = free.filter(confirmedOk);
  fallback(confirmed, confirmed);
  // a record whose send was cut off: only after the confirmed ones, and the confirmed unmatched ones still count as rivals
  const unsure = free.filter(uncertainOk);
  fallback(unsure, [...unsure, ...confirmed.filter((c) => !decided.some((d) => d.rec === c))]);

  // the pairing must never cross a known pair: records by send time map monotonically onto rows by time
  const crosses = (a: { row: MatchRow; rec: MatchRecord }, b: { row: MatchRow; rec: MatchRecord }) => (a.row.at - b.row.at) * (a.rec.sentAt - b.rec.sentAt) < 0;
  const dropped = new Set<string>();
  for (const d of decided) {
    if ([...pairs, ...decided].some((o) => o !== d && o.rec !== d.rec && crosses(d, o))) dropped.add(d.rec.clientMsgId);
  }
  for (const d of decided) {
    if (dropped.has(d.rec.clientMsgId)) { ambiguous.push(d.rec.clientMsgId); continue; }
    matches.set(d.row.key, d.rec.clientMsgId);
    // stored only when unambiguous (1:1), the turn ended successfully, and the send was confirmed
    fresh.push({ rowKey: d.row.key, clientMsgId: d.rec.clientMsgId, via: "text", persist: d.solo && !!d.rec.runId && recById.get(d.rec.clientMsgId)?.runEnd === "done" });
  }
  return { matches, fresh, unbind, ambiguous, skewFor };
}

/**
 * Sent photos whose row has NOT appeared in the history (yet, or the engine dropped an image-only message): shown as the owner's own
 * bubble so the message never vanishes. A record qualifies only if the engine ACCEPTED the turn (it has a `runId`), it is not matched,
 * not bound to a row elsewhere, not superseded by a retry, has NO plausible candidate row (same text, near its time: that row stands
 * for it even when the match was ambiguous), is not the run still on screen (`liveRunIds`), and is younger than `maxAgeMs`.
 */
export function pendingRecords(rows: readonly MatchRow[], records: readonly MatchRecord[], matched: Map<string, string>,
  opts: { now: number; maxAgeMs?: number; liveRunIds?: string[]; windowMs?: number; skewFor?: (sentAt: number) => number | null }): MatchRecord[] {
  const W = opts.windowMs ?? MATCH_WINDOW_MS;
  const maxAge = opts.maxAgeMs ?? PENDING_MAX_AGE_MS;
  const claimed = new Set(matched.values());
  return records.filter((c) =>
    !!c.runId && !c.superseded && !claimed.has(c.clientMsgId) && !c.matchedRowId && opts.now - c.sentAt <= maxAge && c.sentAt <= opts.now + W
    && !(opts.liveRunIds?.includes(c.runId))
    && !rows.some((r) => {
      if (r.role !== "user") return false;
      if (r.runId && c.runId) return r.runId === c.runId;
      const k = opts.skewFor?.(c.sentAt) ?? null;
      const d = r.at - (c.sentAt + (k ?? 0));
      // (wider than the fallback's own window on purpose: a row that merely arrived late still stands for the record, no twin bubble)
      return normalizeText(r.text) === normalizeText(c.text) && d >= -(k === null ? EARLY_UNKNOWN_MS : EARLY_KNOWN_MS) && d <= W;
    }))
    .sort((a, b) => a.sentAt - b.sentAt);
}
/** How long an unmatched sent photo stays visible as the owner's own message while no history row stands for it. */
export const PENDING_MAX_AGE_MS = 6 * 60 * 60_000;
