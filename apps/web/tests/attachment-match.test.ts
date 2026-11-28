import { describe, expect, it } from "vitest";
import { EARLY_UNKNOWN_MS, isPlaceholderOnly, matchAttachments, MATCH_WINDOW_MS, normalizeText, pendingRecords, type MatchRecord, type MatchRow } from "@/lib/attachment-match";

const T0 = 1_700_000_000_000;
const min = 60_000;
const row = (key: string, text: string, at: number, extra: Partial<MatchRow> = {}): MatchRow => ({ key, role: "user", text, at, hasServerMedia: false, ...extra });
const rec = (id: string, text: string, sentAt: number, extra: Partial<MatchRecord> = {}): MatchRecord => ({ clientMsgId: id, text, sentAt, ...extra });
const m = (rows: MatchRow[], recs: MatchRecord[]) => Object.fromEntries(matchAttachments(rows, recs).matches);

describe("text normalisation", () => {
  it("trims, collapses whitespace, drops invisible/bidi marks and the engine's media placeholders", () => {
    expect(normalizeText("  شوف \n  الصورة‏ ")).toBe("شوف الصورة");
    expect(normalizeText("<media:image>")).toBe("");
    expect(normalizeText("[image]")).toBe("");
    expect(normalizeText("[media attached: photo.jpg (image/jpeg)]\nشوف")).toBe("شوف");
    expect(normalizeText("[صورة]")).toBe("");
    expect(normalizeText("User sent image(s) with no text.")).toBe(""); // the sentence an older engine showed as the owner's words
    expect(normalizeText("User sent image with no text")).toBe("");
    expect(normalizeText("(image) هذه")).toBe("هذه");
    expect(normalizeText("شوف [المرفق] هنا")).toBe("شوف [المرفق] هنا"); // an ordinary bracket stays
  });
  it("placeholder-only: has text, but only a media placeholder", () => {
    expect(isPlaceholderOnly("[image]")).toBe(true);
    expect(isPlaceholderOnly("User sent image(s) with no text.")).toBe(true);
    expect(isPlaceholderOnly("<media:image> <media:image>")).toBe(true);
    expect(isPlaceholderOnly("")).toBe(false);
    expect(isPlaceholderOnly("   ")).toBe(false);
    expect(isPlaceholderOnly("شوف")).toBe(false);
  });
});

const unbindIs = (r: { unbind: string[] }, ids: string[]) => expect(r.unbind).toEqual(ids);

describe("matching a local photo copy to its history row", () => {
  it("one row, one record, same text and time → matched (and reported as fresh, to be persisted)", () => {
    const r = matchAttachments([row("r1", "شوف الصورة", T0 + 5_000)], [rec("c1", "شوف الصورة", T0)]);
    expect([...r.matches]).toEqual([["r1", "c1"]]);
    expect(r.fresh).toEqual([{ rowKey: "r1", clientMsgId: "c1", via: "text", persist: false }]); // not persisted before the record's own turn finished
  });
  it("a photo with no text matches the engine's empty row and its placeholder-only row alike", () => {
    expect(m([row("r1", "", T0 + 1000)], [rec("c1", "", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "[image]", T0 + 1000)], [rec("c1", "", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "<media:image>", T0 + 1000)], [rec("c1", "", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "User sent image(s) with no text.", T0 + 1000)], [rec("c1", "", T0)])).toEqual({ r1: "c1" }); // older engine
    expect(m([row("r1", "", T0 + 1000, { hasServerMedia: false })], [rec("c1", "", T0)])).toEqual({ r1: "c1" }); // current engine: "" + an unavailable media entry
  });
  it("the fallback window: the row may be up to 3 minutes AFTER the send and (skew unknown) at most 60 s BEFORE it; otherwise nothing is guessed", () => {
    expect(m([row("r1", "x", T0 + MATCH_WINDOW_MS)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 + MATCH_WINDOW_MS + 1)], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0 - EARLY_UNKNOWN_MS)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 - EARLY_UNKNOWN_MS - 1)], [rec("c1", "x", T0)])).toEqual({});
  });
  it("clock skew: a phone clock a little BEHIND the engine's still matches; a phone AHEAD by minutes shows nothing (never a guess)", () => {
    expect(m([row("r1", "x", T0 + 2 * min)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 - 2 * min)], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0 + 10 * min)], [rec("c1", "x", T0)])).toEqual({});
  });

  describe("wrong-photo repros (review): clock skew and another device's identical message", () => {
    it("two image-only sends 4 min apart from a phone whose clock is 3.5 min FAST: nothing matches (rowB must not get recA), and recA is not shown twice", () => {
      const rows = [row("rowA", "", T0), row("rowB", "", T0 + 4 * min)];
      const recs = [rec("recA", "", T0 + 3.5 * min, { runId: "run-a" }), rec("recB", "", T0 + 7.5 * min, { runId: "run-b" })];
      const r = matchAttachments(rows, recs);
      expect(r.matches.size).toBe(0);
      expect(r.ambiguous).toContain("recA");
      // recA has a row candidate near it (not a second, pending bubble); recB's row is not there yet → it alone is pending
      expect(pendingRecords(rows, recs, r.matches, { now: T0 + 8 * min }).map((c) => c.clientMsgId)).toEqual(["recB"]);
    });
    it("this device's own row missing: the laptop's row with the same text 90 s EARLIER than the send is not this record's", () => {
      expect(m([row("laptop", "شوف", T0)], [rec("phone", "شوف", T0 + 90_000, { runId: "run-p" })])).toEqual({});
    });
    it("…and a laptop row near the record next to the phone's own row: two rows, one record → ambiguous, nothing shown", () => {
      expect(m([row("laptop", "شوف", T0), row("own", "شوف", T0 + 20_000)], [rec("phone", "شوف", T0 + 10_000)])).toEqual({});
    });
    it("a same-text row ANYWHERE near blocks a 1:1 match: another unclaimed row within 2× the window, with or without server media", () => {
      expect(m([row("r1", "x", T0 + 1000), row("r2", "x", T0 + 5 * min)], [rec("c1", "x", T0)])).toEqual({});
      expect(m([row("r1", "x", T0 + 1000), row("r2", "x", T0 + 5 * min, { hasServerMedia: true })], [rec("c1", "x", T0)])).toEqual({});
      expect(m([row("r1", "x", T0 + 1000), row("r2", "x", T0 + 7 * min)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" }); // beyond 2× the window: not a rival
    });
    it("another unclaimed RECORD with the same text near the pair blocks it too", () => {
      expect(m([row("r1", "x", T0 + 1000)], [rec("c1", "x", T0), rec("c2", "x", T0 + 5 * min)])).toEqual({});
    });
    it("a row already claimed by a runId match (somebody's confirmed message) is not a rival", () => {
      const rows = [row("r1", "x", T0 + 1000), row("r2", "x", T0 + 2 * min, { runId: "run-2" })];
      expect(m(rows, [rec("c1", "x", T0), rec("c2", "x", T0 + 2 * min, { runId: "run-2" })])).toEqual({ r1: "c1", r2: "c2" });
    });
    it("a row stamped with a DIFFERENT run id than the record is another message, and is not a rival for it either", () => {
      expect(m([row("r1", "x", T0 + 1000), row("r2", "x", T0 + 2 * min, { runId: "other" })], [rec("c1", "x", T0, { runId: "run-1" })])).toEqual({ r1: "c1" });
    });
    it("a fallback pairing that would CROSS a known pair matches nothing (records by send time must map monotonically onto rows by time)", () => {
      const known = [row("k", "نص", T0 + 10 * min, { runId: "run-k" })];
      const knownRec = rec("ck", "نص", T0 + 10 * min, { runId: "run-k" });
      // fallback row after the known one, but its record was sent BEFORE it: the two pairs cross
      const crossing = matchAttachments([...known, row("f", "ب", T0 + 11 * min)], [knownRec, rec("cf", "ب", T0 + 9 * min)]);
      expect([...crossing.matches]).toEqual([["k", "ck"]]);
      const fine = matchAttachments([...known, row("f", "ب", T0 + 11 * min)], [knownRec, rec("cf", "ب", T0 + 10.5 * min)]);
      expect([...fine.matches].sort()).toEqual([["f", "cf"], ["k", "ck"]]);
    });
    it("clock skew is estimated from a runId match and applied to the fallback (a fast phone's later messages then match); otherwise it stays strict", () => {
      const rows = [row("k", "أ", T0, { runId: "run-k" }), row("f", "ب", T0 + 4 * min)];
      const recs = [rec("ck", "أ", T0 + 3.5 * min, { runId: "run-k" }), rec("cf", "ب", T0 + 7.5 * min)];
      const r = matchAttachments(rows, recs);
      expect(r.skewMs).toBe(-3.5 * min);
      expect([...r.matches].sort()).toEqual([["f", "cf"], ["k", "ck"]]);
      // without the runId pair the same fallback row/record is 3.5 min apart in the wrong direction: refused
      expect(m([row("f", "ب", T0 + 4 * min)], [rec("cf", "ب", T0 + 7.5 * min)])).toEqual({});
      expect(matchAttachments([row("f", "ب", T0)], [rec("cf", "ب", T0)]).skewMs).toBeNull();
    });
    it("a fallback match is persisted only once the record's own turn has finished", () => {
      const rows = [row("r1", "x", T0 + 1000)];
      expect(matchAttachments(rows, [rec("c1", "x", T0, { runId: "run-1" })]).fresh[0]).toMatchObject({ via: "text", persist: false });
      expect(matchAttachments(rows, [rec("c1", "x", T0, { runId: "run-1", runDone: true })]).fresh[0]).toMatchObject({ via: "text", persist: true });
      expect(matchAttachments([row("r1", "y", T0, { runId: "run-1" })], [rec("c1", "x", T0, { runId: "run-1" })]).fresh[0]).toMatchObject({ via: "runId", persist: true });
    });
  });
  it("different text never matches; assistant and system rows never match", () => {
    expect(m([row("r1", "شيء آخر", T0)], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0, { role: "assistant" })], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0, { role: "system" })], [rec("c1", "x", T0)])).toEqual({});
  });
  it("server media always wins: a row with an available server image never gets a local copy", () => {
    expect(m([row("r1", "x", T0, { hasServerMedia: true })], [rec("c1", "x", T0)])).toEqual({});
  });
  it("the same record is never attached to two rows, nor two records to one row", () => {
    // two identical-text rows, one record: ambiguous → nothing
    const r = matchAttachments([row("r1", "x", T0), row("r2", "x", T0 + min)], [rec("c1", "x", T0)]);
    expect(r.matches.size).toBe(0);
    expect(r.ambiguous).toEqual(["c1"]);
    // one row, two identical records: ambiguous → nothing
    expect(m([row("r1", "x", T0)], [rec("c1", "x", T0), rec("c2", "x", T0 + 30_000)])).toEqual({});
  });

  describe("duplicates and identical texts", () => {
    it("two identical texts sent close together: paired in time order (each photo to its own row)", () => {
      const rows = [row("r1", "شوف", T0 + 3_000), row("r2", "شوف", T0 + 62_000)];
      const recs = [rec("c1", "شوف", T0), rec("c2", "شوف", T0 + 60_000)];
      expect(m(rows, recs)).toEqual({ r1: "c1", r2: "c2" });
    });
    it("…whatever the order the rows / records arrive in (edited order, paging)", () => {
      const rows = [row("r2", "شوف", T0 + 62_000), row("r1", "شوف", T0 + 3_000)];
      const recs = [rec("c2", "شوف", T0 + 60_000), rec("c1", "شوف", T0)];
      expect(m(rows, recs)).toEqual({ r1: "c1", r2: "c2" });
    });
    it("identical text but the first photo's row is missing (not loaded / dropped): ambiguous → nothing, never the wrong photo", () => {
      expect(m([row("r2", "شوف", T0 + 62_000)], [rec("c1", "شوف", T0), rec("c2", "شوف", T0 + 60_000)])).toEqual({});
    });
    it("a text-only message with the same words (no photo) next to the photo message: ambiguous → nothing", () => {
      expect(m([row("r1", "شوف", T0 + 2_000), row("r2", "شوف", T0 + 90_000)], [rec("c2", "شوف", T0 + 88_000)])).toEqual({});
    });
    it("identical texts far apart in time are independent (each in its own window)", () => {
      const rows = [row("r1", "x", T0 + 1000), row("r2", "x", T0 + 30 * min)];
      const recs = [rec("c1", "x", T0), rec("c2", "x", T0 + 30 * min - 2000)];
      expect(m(rows, recs)).toEqual({ r1: "c1", r2: "c2" });
    });
    it("two photo-only messages (no text) close together pair in order; one row for two records does not", () => {
      expect(m([row("r1", "", T0 + 1000), row("r2", "[image]", T0 + 20_000)], [rec("c1", "", T0), rec("c2", "", T0 + 19_000)])).toEqual({ r1: "c1", r2: "c2" });
      expect(m([row("r1", "", T0 + 1000)], [rec("c1", "", T0), rec("c2", "", T0 + 19_000)])).toEqual({});
    });
    it("different texts sent together never cross", () => {
      expect(m([row("r1", "أ", T0), row("r2", "ب", T0 + 1000)], [rec("c2", "ب", T0 + 900), rec("c1", "أ", T0 - 100)])).toEqual({ r1: "c1", r2: "c2" });
    });
  });

  describe("run id / idempotency key (priority 1)", () => {
    it("a row that exposes the run id matches its record exactly, even when the text differs or the clock is far off", () => {
      expect(m([row("r1", "نص مختلف تمامًا", T0 + 60 * min, { runId: "run-1" })], [rec("c1", "x", T0, { runId: "run-1" })])).toEqual({ r1: "c1" });
    });
    it("run ids keep identical texts apart without any guessing", () => {
      const rows = [row("r1", "شوف", T0, { runId: "run-2" }), row("r2", "شوف", T0, { runId: "run-1" })];
      expect(m(rows, [rec("c1", "شوف", T0, { runId: "run-1" }), rec("c2", "شوف", T0, { runId: "run-2" })])).toEqual({ r1: "c2", r2: "c1" });
    });
    it("a row with a DIFFERENT run id is never fuzzy-matched to a record that has its own run id", () => {
      expect(m([row("r1", "x", T0, { runId: "other" })], [rec("c1", "x", T0, { runId: "run-1" })])).toEqual({});
    });
    it("a record whose run id is not exposed by the rows falls back to text and time", () => {
      expect(m([row("r1", "x", T0 + 1000)], [rec("c1", "x", T0, { runId: "run-1" })])).toEqual({ r1: "c1" });
    });
  });

  describe("persisted matches survive reloads", () => {
    it("a record bound to a row stays on it while the row still stands for it: equal text, whatever the time", () => {
      const r = matchAttachments([row("r1", "x", T0 + 30 * min)], [rec("c1", "x", T0, { matchedRowId: "r1" })]);
      expect([...r.matches]).toEqual([["r1", "c1"]]);
      expect(r.fresh).toEqual([]); unbindIs(r, []); // already persisted
    });
    it("…and the binding is DROPPED when the row's text is no longer equal (it was another message), unless the row carries the record's run id", () => {
      const changed = matchAttachments([row("r1", "نص آخر", T0)], [rec("c1", "x", T0, { matchedRowId: "r1" })]);
      expect(changed.matches.size).toBe(0); unbindIs(changed, ["c1"]);
      const exact = matchAttachments([row("r1", "نص آخر", T0, { runId: "run-1" })], [rec("c1", "x", T0, { runId: "run-1", matchedRowId: "r1" })]);
      expect([...exact.matches]).toEqual([["r1", "c1"]]); unbindIs(exact, []);
      const clash = matchAttachments([row("r1", "x", T0, { runId: "other" })], [rec("c1", "x", T0, { runId: "run-1", matchedRowId: "r1" })]);
      expect(clash.matches.size).toBe(0); unbindIs(clash, ["c1"]);
      const assistant = matchAttachments([row("r1", "x", T0, { role: "assistant" })], [rec("c1", "x", T0, { matchedRowId: "r1" })]);
      unbindIs(assistant, ["c1"]);
    });
    it("a freed record (its binding dropped) is matched afresh in the same pass", () => {
      const r = matchAttachments([row("r1", "نص آخر", T0), row("r2", "x", T0 + 1000)], [rec("c1", "x", T0, { matchedRowId: "r1" })]);
      unbindIs(r, ["c1"]);
      expect([...r.matches]).toEqual([["r2", "c1"]]);
    });
    it("a bound record whose row is merely not loaded keeps its binding (nothing is unbound)", () => {
      const r = matchAttachments([row("r9", "x", T0)], [rec("c1", "x", T0, { matchedRowId: "r1" })]);
      unbindIs(r, []);
    });
    it("a bound record is never matched to a second row; its row is not offered to another record", () => {
      const rows = [row("r1", "x", T0), row("r2", "x", T0 + min)];
      expect(m(rows, [rec("c1", "x", T0, { matchedRowId: "r1" })])).toEqual({ r1: "c1" }); // r2 stays without a photo
      expect(m([row("r1", "x", T0)], [rec("c1", "x", T0, { matchedRowId: "r1" }), rec("c2", "x", T0 + 1000)])).toEqual({ r1: "c1" });
    });
    it("a bound record whose row is not loaded (paged out) matches nothing else", () => {
      expect(m([row("r9", "x", T0)], [rec("c1", "x", T0, { matchedRowId: "r1" })])).toEqual({});
    });
    it("the server's media still wins over a persisted local match", () => {
      expect(m([row("r1", "x", T0, { hasServerMedia: true })], [rec("c1", "x", T0, { matchedRowId: "r1" })])).toEqual({});
    });
    it("two records claiming one row: the earlier one keeps it", () => {
      expect(m([row("r1", "x", T0)], [rec("c2", "x", T0 + 5, { matchedRowId: "r1" }), rec("c1", "x", T0, { matchedRowId: "r1" })])).toEqual({ r1: "c1" });
    });
  });
});

describe("a sent photo whose row has not appeared (the message must not vanish)", () => {
  const now = T0 + min;
  const opts = { now };
  it("shown as pending while the history has no row for it", () => {
    const rows = [row("r0", "قديمة", T0 - 60 * min)];
    expect(pendingRecords(rows, [rec("c1", "x", T0, { runId: "run-1" })], new Map(), opts).map((c) => c.clientMsgId)).toEqual(["c1"]);
    expect(pendingRecords([], [rec("c1", "", T0, { runId: "run-1" })], new Map(), opts)).toHaveLength(1);
  });
  it("not pending once its row is there (matched), or when a row stands for it even though the match was ambiguous", () => {
    const rows = [row("r1", "x", T0 + 2000)];
    const recs = [rec("c1", "x", T0, { runId: "run-1" })];
    expect(pendingRecords(rows, recs, new Map([["r1", "c1"]]), opts)).toEqual([]);
    expect(pendingRecords(rows, recs, new Map(), opts)).toEqual([]); // a candidate row exists: no duplicate bubble
  });
  it("a server row with media also stands for it (no second bubble next to the server's)", () => {
    expect(pendingRecords([row("r1", "x", T0 + 1000, { hasServerMedia: true })], [rec("c1", "x", T0, { runId: "run-1" })], new Map(), opts)).toEqual([]);
  });
  it("not while the run is still on screen (the live bubble shows it), nor when the send was never accepted (no run id)", () => {
    const recs = [rec("c1", "x", T0, { runId: "run-1" })];
    expect(pendingRecords([], recs, new Map(), { ...opts, liveRunIds: ["run-1"] })).toEqual([]);
    expect(pendingRecords([], [rec("c1", "x", T0)], new Map(), opts)).toEqual([]);
  });
  it("not when it is bound to a row elsewhere (paged out), and not after 6 hours", () => {
    expect(pendingRecords([], [rec("c1", "x", T0, { runId: "r", matchedRowId: "r9" })], new Map(), opts)).toEqual([]);
    expect(pendingRecords([], [rec("c1", "x", T0, { runId: "r" })], new Map(), { now: T0 + 6 * 60 * min + 1 })).toEqual([]);
  });
  it("ordered by send time", () => {
    const recs = [rec("c2", "b", T0 + 5000, { runId: "r2" }), rec("c1", "a", T0, { runId: "r1" })];
    expect(pendingRecords([], recs, new Map(), opts).map((c) => c.clientMsgId)).toEqual(["c1", "c2"]);
  });
});
