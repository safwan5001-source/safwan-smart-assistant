/**
 * Which history row does a device-local photo copy (lib/attachment-store) belong to? Pure functions, no I/O.
 *
 * The engine's history row of the owner's message carries `id`, `text`, `at` and (when the engine kept the photo) `media`; it does not
 * say which `clientMsgId` it came from. Rules, in priority order — and the guiding principle: when in doubt show NOTHING, never a
 * possibly wrong photo.
 *  0. A row with AVAILABLE server media never gets a local copy (the server's copy always wins).
 *  1. An already persisted match (`record.matchedRowId`) holds: the same record is never attached to a second row, and a row that
 *     already has a record never gets another.
 *  2. A `runId` / idempotency key, when the row exposes one and a record has the same.
 *  3. Otherwise: same normalised text AND the row's time within ±3 minutes of the record's `sentAt`. Candidates form groups (rows and
 *     records connected by those two conditions): a group of exactly one row and one record matches; a group with the SAME number of
 *     rows and records (identical texts sent close together) is paired in time order, each pair inside the window; any other group
 *     (a row without a record, a record without a row, more of one side) is ambiguous and matches nothing.
 * Text is compared after trimming, collapsing whitespace, removing invisible/bidi marks and the engine's media placeholders
 * (`<media:image>`, `[image]`, and the sentence older engines put there: «User sent image(s) with no text.»), so an image-only message
 * (the current engine returns text «» plus a media entry), a placeholder row and a caption-less photo all compare equal.
 * Known limits: a device clock more than ±3 minutes off the engine's never matches (nothing is shown); an engine that rewrites a
 * caption beyond the placeholders above never matches; rows paged out of the loaded history cannot match until they are loaded.
 */
export const MATCH_WINDOW_MS = 3 * 60_000;

export type MatchRow = {
  /** The row's stable key (its engine id; a row without an id cannot be persisted). */
  key: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
  /** `runId` or idempotency key, if the engine exposes it on the row. */
  runId?: string | null;
  /** The row already has at least one image the server can serve. */
  hasServerMedia: boolean;
};
export type MatchRecord = { clientMsgId: string; text: string; sentAt: number; runId?: string; matchedRowId?: string };

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
  /** Matches decided in this run: persist them (record.matchedRowId). */
  fresh: { rowKey: string; clientMsgId: string }[];
  /** Records whose candidates were ambiguous (diagnostics/tests). */
  ambiguous: string[];
};

export function matchAttachments(rows: readonly MatchRow[], records: readonly MatchRecord[], opts: { windowMs?: number } = {}): MatchResult {
  const windowMs = opts.windowMs ?? MATCH_WINDOW_MS;
  const matches = new Map<string, string>();
  const fresh: MatchResult["fresh"] = [];
  const usedRows = new Set<string>(); const usedRecs = new Set<string>();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const sortedRecs = [...records].sort((a, b) => a.sentAt - b.sentAt || a.clientMsgId.localeCompare(b.clientMsgId));

  // 1. persisted matches (first record by time wins a row two records both claim; a record claims one row)
  for (const rec of sortedRecs) {
    if (!rec.matchedRowId || usedRecs.has(rec.clientMsgId)) continue;
    usedRecs.add(rec.clientMsgId);
    if (usedRows.has(rec.matchedRowId)) continue;
    usedRows.add(rec.matchedRowId);
    const row = byKey.get(rec.matchedRowId);
    if (row && row.role === "user" && !row.hasServerMedia) matches.set(row.key, rec.clientMsgId);
  }
  const eligible = (r: MatchRow) => r.role === "user" && !r.hasServerMedia && !usedRows.has(r.key);

  // 2. the exact run id / idempotency key
  for (const rec of sortedRecs) {
    if (!rec.runId || usedRecs.has(rec.clientMsgId)) continue;
    const row = rows.find((r) => eligible(r) && r.runId === rec.runId);
    if (!row) continue;
    usedRecs.add(rec.clientMsgId); usedRows.add(row.key);
    matches.set(row.key, rec.clientMsgId); fresh.push({ rowKey: row.key, clientMsgId: rec.clientMsgId });
  }

  // 3. text + time window, resolved per group of mutually possible rows and records
  const rs = rows.map((r, i) => ({ r, i })).filter(({ r }) => eligible(r));
  const cs = sortedRecs.filter((c) => !usedRecs.has(c.clientMsgId));
  const edge = (r: MatchRow, c: MatchRecord) =>
    normalizeText(r.text) === normalizeText(c.text) && Math.abs(r.at - c.sentAt) <= windowMs && !(r.runId && c.runId && r.runId !== c.runId);
  const parent = new Map<string, string>();
  const find = (x: string): string => { let p = parent.get(x) ?? x; while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p; parent.set(x, p); return p; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const linked = new Set<string>();
  for (const { r } of rs) for (const c of cs) if (edge(r, c)) { union("r:" + r.key, "c:" + c.clientMsgId); linked.add("r:" + r.key); linked.add("c:" + c.clientMsgId); }
  const groups = new Map<string, { rows: { r: MatchRow; i: number }[]; recs: MatchRecord[] }>();
  const grp = (id: string) => { let g = groups.get(id); if (!g) groups.set(id, (g = { rows: [], recs: [] })); return g; };
  for (const x of rs) if (linked.has("r:" + x.r.key)) grp(find("r:" + x.r.key)).rows.push(x);
  for (const c of cs) if (linked.has("c:" + c.clientMsgId)) grp(find("c:" + c.clientMsgId)).recs.push(c);
  const ambiguous: string[] = [];
  for (const g of groups.values()) {
    const rowsSorted = [...g.rows].sort((a, b) => a.r.at - b.r.at || a.i - b.i);
    const recs = [...g.recs].sort((a, b) => a.sentAt - b.sentAt || a.clientMsgId.localeCompare(b.clientMsgId));
    const paired = rowsSorted.length === recs.length && rowsSorted.every(({ r }, k) => edge(r, recs[k]));
    if (!paired) { ambiguous.push(...recs.map((c) => c.clientMsgId)); continue; }
    rowsSorted.forEach(({ r }, k) => { matches.set(r.key, recs[k].clientMsgId); fresh.push({ rowKey: r.key, clientMsgId: recs[k].clientMsgId }); });
  }
  return { matches, fresh, ambiguous };
}

/**
 * Sent photos whose row has NOT appeared in the history (yet, or the engine dropped an image-only message): they are shown as the
 * owner's own bubble so the message never vanishes. A record qualifies only if the engine ACCEPTED the turn (it has a `runId`: a send
 * that was cut off is never shown as sent), it is not matched, not bound to a row elsewhere, has NO candidate row at all (any user row with the same text near its time — that row stands for it, even when the match was
 * ambiguous), is not the run still on screen (`liveRunIds`), and is younger than `maxAgeMs`.
 */
export function pendingRecords(rows: readonly MatchRow[], records: readonly MatchRecord[], matched: Map<string, string>, opts: { now: number; maxAgeMs?: number; liveRunIds?: string[]; windowMs?: number }): MatchRecord[] {
  const windowMs = opts.windowMs ?? MATCH_WINDOW_MS;
  const maxAge = opts.maxAgeMs ?? PENDING_MAX_AGE_MS;
  const claimed = new Set(matched.values());
  return records.filter((c) =>
    !!c.runId && !claimed.has(c.clientMsgId) && !c.matchedRowId && opts.now - c.sentAt <= maxAge && c.sentAt <= opts.now + windowMs
    && !(c.runId && opts.liveRunIds?.includes(c.runId))
    && !rows.some((r) => r.role === "user" && !(r.runId && c.runId && r.runId !== c.runId)
      && (r.runId && c.runId ? r.runId === c.runId : normalizeText(r.text) === normalizeText(c.text) && Math.abs(r.at - c.sentAt) <= windowMs)))
    .sort((a, b) => a.sentAt - b.sentAt);
}
/** How long an unmatched sent photo stays visible as the owner's own message while no history row stands for it. */
export const PENDING_MAX_AGE_MS = 6 * 60 * 60_000;
