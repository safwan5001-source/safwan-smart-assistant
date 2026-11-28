/**
 * Which history row does a device-local photo copy (lib/attachment-store) belong to? Pure functions, no I/O.
 *
 * The engine's history row of the owner's message carries `id`, `text`, `at`, (when the engine kept the photo) `media`, and — newer
 * engines — the `runId` of the turn it started. Guiding principle: when in doubt show NOTHING, never a possibly wrong photo.
 *  0. A row with AVAILABLE server image media never gets a local copy (the server's copy always wins).
 *  1. A persisted binding (`record.matchedRowId`) holds while the bound row still stands for the record: the row carries the same
 *     `runId`, or (no run id on it) its normalised text is still equal. Otherwise the binding is dropped (`unbind`). A record never
 *     goes to two rows and a row never to two records.
 *  2. `runId`: the row exposes the run id /send returned for the record. This is the only exact key. It also yields a clock-skew
 *     estimate (median of row time − send time) used to adjust the fallback below.
 *  3. FALLBACK — same normalised text and a plausible time: the row is not earlier than the send by more than 60 s (30 s when the
 *     skew is known) and not later than 3 min, after shifting by the estimated skew (unknown skew = 0, and we stay strict). A group of
 *     exactly one row and one record matches; a group with equal counts pairs in time order. It is REFUSED when
 *       - any other user row with the same text (whatever its media, wherever it came from: this device or another) sits within
 *         2× the window of the record or of the row, or another unclaimed record with the same text does, or
 *       - the pairing would cross an already known pair (records sorted by send time must map monotonically onto rows by time).
 *     A fallback match is only PERSISTED once that record's own turn has finished (`persist`), and re-checked on every later load.
 * Text is compared after trimming, collapsing whitespace, removing invisible/bidi marks and the engine's media placeholders
 * (`<media:image>`, `[image]`, the sentence older engines used: «User sent image(s) with no text.»); the current engine returns
 * text «» for an image-only message.
 * Known limits (nothing is shown rather than a guess): a phone clock more than ~1 minute AHEAD of the engine's (rows then look
 * earlier than the send) or more than 3 minutes behind it matches nothing until a runId match gives the skew; identical texts sent
 * within 6 minutes of each other with a missing row on either side; rows paged out of the loaded history; an engine that rewrites
 * captions beyond the placeholders above.
 */
export const MATCH_WINDOW_MS = 3 * 60_000;
/** How far BEFORE the send a row may be dated while the clock skew is unknown / known. */
export const EARLY_UNKNOWN_MS = 60_000;
export const EARLY_KNOWN_MS = 30_000;

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
export type MatchRecord = { clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string; runDone?: boolean; superseded?: boolean };

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
  /** Matches decided in this run. `persist`: store them (a runId match always; a text match only once the record's turn finished). */
  fresh: { rowKey: string; clientMsgId: string; via: "runId" | "text"; persist: boolean }[];
  /** Persisted bindings that no longer hold (row text changed / another row claimed it): clear them. */
  unbind: string[];
  /** Records whose candidates were ambiguous (diagnostics/tests). */
  ambiguous: string[];
  /** Estimated clock skew (row time − send time, ms) from runId matches, or null when unknown. */
  skewMs: number | null;
};

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

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
  const skewSamples: number[] = [];
  const pairs: { row: MatchRow; rec: MatchRecord; exact: boolean }[] = [];
  const show = (row: MatchRow, rec: MatchRecord) => { if (!row.hasServerMedia) matches.set(row.key, rec.clientMsgId); };

  // 1. persisted bindings: kept while the bound row still stands for the record
  for (const rec of sortedRecs) {
    const id = rec.matchedRowId;
    if (!id) continue;
    const row = byKey.get(id);
    if (usedRows.has(id)) { unbind.push(rec.clientMsgId); continue; } // an earlier record already holds that row
    if (!row) { usedRows.add(id); usedRecs.add(rec.clientMsgId); continue; } // not loaded (paged out): the binding waits
    const exact = !!rec.runId && !!row.runId && row.runId === rec.runId;
    const clash = !!rec.runId && !!row.runId && row.runId !== rec.runId;
    if (row.role !== "user" || clash || (!exact && rowText.get(row.key) !== recText.get(rec.clientMsgId))) { unbind.push(rec.clientMsgId); continue; }
    usedRows.add(id); usedRecs.add(rec.clientMsgId);
    if (exact) skewSamples.push(row.at - rec.sentAt);
    pairs.push({ row, rec, exact });
    show(row, rec);
  }

  // 2. the exact key: the run id /send returned
  for (const rec of sortedRecs) {
    if (!rec.runId || usedRecs.has(rec.clientMsgId)) continue;
    const row = rows.find((r) => r.role === "user" && !usedRows.has(r.key) && r.runId === rec.runId);
    if (!row) continue;
    usedRecs.add(rec.clientMsgId); usedRows.add(row.key);
    skewSamples.push(row.at - rec.sentAt);
    pairs.push({ row, rec, exact: true });
    show(row, rec);
    fresh.push({ rowKey: row.key, clientMsgId: rec.clientMsgId, via: "runId", persist: true });
  }
  const skew = skewSamples.length ? median(skewSamples) : null;
  const shift = skew ?? 0;
  const early = skew === null ? EARLY_UNKNOWN_MS : EARLY_KNOWN_MS;

  // 3. fallback: text + a plausible time, per normalised text, refused whenever it could be someone else's row
  const userRows = rows.filter((r) => r.role === "user" && !usedRows.has(r.key)); // every unclaimed owner row competes (any media, any device)
  const recsLeft = sortedRecs.filter((c) => !usedRecs.has(c.clientMsgId));
  const rowsByText = new Map<string, MatchRow[]>();
  for (const r of userRows) { const t = rowText.get(r.key)!; (rowsByText.get(t) ?? rowsByText.set(t, []).get(t)!).push(r); }
  const recsByText = new Map<string, MatchRecord[]>();
  for (const c of recsLeft) { const t = recText.get(c.clientMsgId)!; (recsByText.get(t) ?? recsByText.set(t, []).get(t)!).push(c); }
  const plausible = (r: MatchRow, c: MatchRecord) => {
    if (r.runId && c.runId && r.runId !== c.runId) return false;
    const d = r.at - (c.sentAt + shift);
    return d >= -early && d <= W;
  };
  const decided: { row: MatchRow; rec: MatchRecord }[] = [];
  for (const [text, recs] of recsByText) {
    const sameRows = rowsByText.get(text) ?? [];
    const cand = sameRows.filter((r) => !r.hasServerMedia); // only these can show a local copy
    // connected groups over plausible (row, record) edges
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
      const near = (t: number, c: MatchRecord[], r: MatchRow[]) => c.some((x) => Math.abs(t - (x.sentAt + shift)) <= 2 * W) || r.some((x) => Math.abs(t - x.at) <= 2 * W);
      // a row stamped with a DIFFERENT run id than every record here is somebody else's message and cannot be this record's row
      const mayBeMine = (r: MatchRow) => !r.runId || gc.some((c) => !c.runId || c.runId === r.runId);
      const otherRow = sameRows.some((r) => !gr.includes(r) && mayBeMine(r) && near(r.at, gc, gr));
      const otherRec = recs.some((c) => !gc.includes(c) && near(c.sentAt + shift, gc, gr));
      const ok = gr.length === gc.length && gr.every((r, k) => plausible(r, gc[k])) && !otherRow && !otherRec;
      if (!ok) { ambiguous.push(...gc.map((c) => c.clientMsgId)); continue; }
      gr.forEach((r, k) => decided.push({ row: r, rec: gc[k] }));
    }
  }
  // the pairing must never cross a known pair: records by send time map monotonically onto rows by time
  const crosses = (a: { row: MatchRow; rec: MatchRecord }, b: { row: MatchRow; rec: MatchRecord }) =>
    (a.row.at - b.row.at) * (a.rec.sentAt - b.rec.sentAt) < 0;
  const known = pairs.map(({ row, rec }) => ({ row, rec }));
  const dropped = new Set<string>();
  for (const d of decided) {
    if ([...known, ...decided].some((o) => o !== d && o.rec !== d.rec && crosses(d, o))) dropped.add(d.rec.clientMsgId);
  }
  for (const d of decided) {
    if (dropped.has(d.rec.clientMsgId)) { ambiguous.push(d.rec.clientMsgId); continue; }
    matches.set(d.row.key, d.rec.clientMsgId);
    fresh.push({ rowKey: d.row.key, clientMsgId: d.rec.clientMsgId, via: "text", persist: !!recById.get(d.rec.clientMsgId)?.runDone });
  }
  return { matches, fresh, unbind, ambiguous, skewMs: skew };
}

/**
 * Sent photos whose row has NOT appeared in the history (yet, or the engine dropped an image-only message): shown as the owner's own
 * bubble so the message never vanishes. A record qualifies only if the engine ACCEPTED the turn (it has a `runId`), it is not matched,
 * not bound to a row elsewhere, not superseded by a retry, has NO plausible candidate row (same text, near its time: that row stands
 * for it even when the match was ambiguous), is not the run still on screen (`liveRunIds`), and is younger than `maxAgeMs`.
 */
export function pendingRecords(rows: readonly MatchRow[], records: readonly MatchRecord[], matched: Map<string, string>,
  opts: { now: number; maxAgeMs?: number; liveRunIds?: string[]; windowMs?: number; skewMs?: number | null }): MatchRecord[] {
  const W = opts.windowMs ?? MATCH_WINDOW_MS;
  const maxAge = opts.maxAgeMs ?? PENDING_MAX_AGE_MS;
  const shift = opts.skewMs ?? 0;
  const early = opts.skewMs == null ? EARLY_UNKNOWN_MS : EARLY_KNOWN_MS;
  const claimed = new Set(matched.values());
  return records.filter((c) =>
    !!c.runId && !c.superseded && !claimed.has(c.clientMsgId) && !c.matchedRowId && opts.now - c.sentAt <= maxAge && c.sentAt <= opts.now + W
    && !(opts.liveRunIds?.includes(c.runId))
    && !rows.some((r) => {
      if (r.role !== "user") return false;
      if (r.runId && c.runId) return r.runId === c.runId;
      const d = r.at - (c.sentAt + shift);
      return normalizeText(r.text) === normalizeText(c.text) && d >= -early && d <= W;
    }))
    .sort((a, b) => a.sentAt - b.sentAt);
}
/** How long an unmatched sent photo stays visible as the owner's own message while no history row stands for it. */
export const PENDING_MAX_AGE_MS = 6 * 60 * 60_000;
