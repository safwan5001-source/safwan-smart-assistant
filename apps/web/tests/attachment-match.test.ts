import { describe, expect, it } from "vitest";
import { EARLY_KNOWN_MS, EARLY_UNKNOWN_MS, isPlaceholderOnly, LATE_MS, matchAttachments, MATCH_WINDOW_MS, normalizeText, pendingRecords, type MatchRecord, type MatchRow } from "@/lib/attachment-match";

const T0 = 1_700_000_000_000;
const min = 60_000;
const row = (key: string, text: string, at: number, extra: Partial<MatchRow> = {}): MatchRow => ({ key, role: "user", text, at, hasServerMedia: false, ...extra });
// a record whose send the engine confirmed (a run id came back); tests that need the runId-less kinds pass `runId: undefined`
const rec = (id: string, text: string, sentAt: number, extra: Partial<MatchRecord> = {}): MatchRecord => ({ clientMsgId: id, text, sentAt, runId: "run-" + id, ...extra });
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
  it("the fallback window: the row may be up to 60 s AFTER the send (the engine writes the row when the run starts) and (skew unknown) at most 60 s BEFORE it; otherwise nothing is guessed", () => {
    expect(m([row("r1", "x", T0 + LATE_MS)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 + LATE_MS + 1)], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0 - EARLY_UNKNOWN_MS)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 - EARLY_UNKNOWN_MS - 1)], [rec("c1", "x", T0)])).toEqual({});
    expect(MATCH_WINDOW_MS).toBe(3 * min); // the rival / pending window stays wider than the fallback's own
  });
  it("clock skew: a phone a little BEHIND the engine's still matches; ahead by a minute or more, or a row minutes later, shows nothing (never a guess)", () => {
    expect(m([row("r1", "x", T0 + 45_000)], [rec("c1", "x", T0)])).toEqual({ r1: "c1" });
    expect(m([row("r1", "x", T0 - 2 * min)], [rec("c1", "x", T0)])).toEqual({});
    expect(m([row("r1", "x", T0 + 2 * min)], [rec("c1", "x", T0)])).toEqual({});
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
    it("S4: when the engine stamps run ids on owner rows near the record, a row WITHOUT one is never paired by text (a row of this turn would have carried it)", () => {
      const rows = [row("rB", "hi", T0 + 100_000, { runId: "run-B" }), row("rX", "hi", T0 + 150_000)];
      const r = matchAttachments(rows, [rec("A", "hi", T0), rec("B", "hi", T0 + 100_000)]);
      expect(Object.fromEntries(r.matches)).toEqual({ rB: "B" }); // B by its run id only; A and rX are not paired
      expect(matchAttachments([row("old", "x", T0 - 11 * min, { runId: "run-old" }), row("r1", "x", T0 + 1000)], [rec("c1", "x", T0)]).matches.size).toBe(1); // a stamped row far away does not disable it
    });
    it("F6/S9: a record WITHOUT a run id never matches by text a row that carries a (different) run id", () => {
      const r = matchAttachments([row("rZ", "", T0 + 20_000, { runId: "rz" })], [rec("X", "", T0, { runId: undefined, uncertain: true })]);
      expect(r.matches.size).toBe(0);
      expect(matchAttachments([row("r1", "", T0 + 20_000)], [rec("X", "", T0, { runId: undefined })]).matches.size).toBe(0); // …and one that never had a run id has no fallback at all
    });
    it("a fallback pairing that would CROSS a known pair matches nothing (records by send time must map monotonically onto rows by time)", () => {
      const known = row("k", "نص", T0 + 10 * min); const knownRec = rec("ck", "نص", T0 + 10 * min, { matchedRowId: "k" });
      // the fallback row is dated after the known row, but its record was sent BEFORE the known record: the two pairs cross
      const crossing = matchAttachments([known, row("f", "ب", T0 + 10.2 * min)], [knownRec, rec("cf", "ب", T0 + 9.8 * min)]);
      expect([...crossing.matches]).toEqual([["k", "ck"]]);
      const fine = matchAttachments([known, row("f", "ب", T0 + 10.2 * min)], [knownRec, rec("cf", "ب", T0 + 10.1 * min)]);
      expect([...fine.matches].sort()).toEqual([["f", "cf"], ["k", "ck"]]);
    });
    describe("clock skew (estimated from exact run-id pairs only)", () => {
      const pairAt = (ago: number, diff: number, id = "p") => ({ row: row("pr" + id, "z" + id, T0 - ago + diff, { runId: "run-" + id }), rec: rec(id, "z" + id, T0 - ago) });
      const run = (pairs: ReturnType<typeof pairAt>[], f: MatchRow, c: MatchRecord) => matchAttachments([...pairs.map((p) => p.row), f], [...pairs.map((p) => p.rec), c]);
      it("a known skew is applied: a phone BEHIND by 40 s whose row looks 95 s late still matches; with no pair it is refused", () => {
        const f = row("f", "ب", T0 + 95_000), c = rec("cf", "ب", T0);
        expect(run([pairAt(30 * min, 40_000)], f, c).matches.get("f")).toBe("cf");
        expect(run([], f, c).matches.has("f")).toBe(false);
      });
      it("a known skew TIGHTENS the early bound to 30 s: the same row 55 s early matches without a sample and is refused with one", () => {
        const f = row("f", "ب", T0 - 55_000), c = rec("cf", "ب", T0);
        expect(run([], f, c).matches.get("f")).toBe("cf");
        expect(run([pairAt(30 * min, -20_000)], f, c).matches.has("f")).toBe(false); // known skew −20 s → the row is 35 s before the corrected send
        expect(EARLY_KNOWN_MS).toBeLessThan(EARLY_UNKNOWN_MS);
      });
      it("S10: an OLD pair (days ago, an 8-minute-off clock) does not shift today's matches; neither does a pair that is itself far off or that disagrees", () => {
        const f = row("f", "ب", T0 + 8 * min - 20_000), c = rec("cf", "ب", T0);
        expect(run([pairAt(48 * 3600_000, 8 * min)], f, c).matches.has("f")).toBe(false);   // outside the one-hour window
        expect(run([pairAt(30 * min, 8 * min)], f, c).matches.has("f")).toBe(false);        // a shift above 2 minutes is never applied
        const disagree = run([pairAt(20 * min, 30_000, "a"), pairAt(40 * min, -3 * min, "b")], row("g", "ب", T0 + 100_000), c);
        expect(disagree.matches.has("g")).toBe(false);                                       // samples that disagree: strict
        expect(disagree.skewFor(T0)).toBeNull(); expect(run([], f, c).skewFor(T0)).toBeNull();
        expect(run([pairAt(30 * min, 40_000)], f, c).skewFor(T0)).toBe(40_000);
      });
    });
    it("a fallback match is persisted only for an unambiguous 1:1 of a turn that ENDED SUCCESSFULLY", () => {
      const rows = [row("r1", "x", T0 + 1000)];
      expect(matchAttachments(rows, [rec("c1", "x", T0)]).fresh[0]).toMatchObject({ via: "text", persist: false });                          // run not ended yet
      expect(matchAttachments(rows, [rec("c1", "x", T0, { runDone: true, runEnd: "done" })]).fresh[0]).toMatchObject({ via: "text", persist: true });
      expect(matchAttachments([row("r1", "y", T0, { runId: "run-c1" })], [rec("c1", "x", T0)]).fresh[0]).toMatchObject({ via: "runId", persist: true });
    });
    it("F1c: a pairing made inside an equal-count group of 2+ is shown but NEVER persisted (re-derived each load)", () => {
      const r = matchAttachments([row("r1", "شوف", T0 + 3000), row("r2", "شوف", T0 + 62_000)],
        [rec("c1", "شوف", T0, { runEnd: "done" }), rec("c2", "شوف", T0 + 60_000, { runEnd: "done" })]);
      expect(Object.fromEntries(r.matches)).toEqual({ r1: "c1", r2: "c2" });
      expect(r.fresh.map((f) => f.persist)).toEqual([false, false]);
    });
    describe("records that cannot have a row take no part in the text fallback (review F1/F3)", () => {
      it("S2: a turn that ended in ERROR or was STOPPED (no row written) is not paired with an unrelated same-text row", () => {
        for (const runEnd of ["error", "stopped"] as const) {
          const r = matchAttachments([row("rX", "hi", T0 + 40_000)], [rec("A", "hi", T0, { runEnd, runDone: true })]);
          expect(r.matches.size).toBe(0);
        }
        expect(matchAttachments([row("rX", "hi", T0 + 40_000)], [rec("A", "hi", T0, { runEnd: "done" })]).matches.size).toBe(1);
      });
      it("…but its own exact run id still matches (the row carries it)", () => {
        const r = matchAttachments([row("rA", "hi", T0 + 40_000, { runId: "run-A" })], [rec("A", "hi", T0, { runEnd: "error", runDone: true })]);
        expect([...r.matches]).toEqual([["rA", "A"]]);
      });
      it("S1: A (no row, failed) and B (100 s later) with rows rB and another device's rX: neither photo lands on the wrong row", () => {
        const rows = [row("rB", "hi", T0 + 100_000), row("rX", "hi", T0 + 150_000)];
        const r = matchAttachments(rows, [rec("A", "hi", T0, { runEnd: "error", runDone: true }), rec("B", "hi", T0 + 100_000, { runEnd: "done", runDone: true })]);
        expect(Object.fromEntries(r.matches)).toEqual({}); // rX within the rival window of rB: ambiguous, nothing shown
      });
      it("S11: the same with image-only («») messages", () => {
        const r = matchAttachments([row("r2", "", T0 + 50_000), row("r3", "", T0 + 170_000)],
          [rec("A", "", T0, { runEnd: "error", runDone: true }), rec("B", "", T0 + 60_000, { runEnd: "done", runDone: true })]);
        expect(r.matches.get("r3")).not.toBe("B"); expect(r.matches.get("r2")).not.toBe("A");
      });
      it("S3/F3: a retry after a turn that left no row — the superseded or failed first attempt does not block B's own 1:1 match", () => {
        const rows = [row("rB", "hi", T0 + 30_000)];
        const a = rec("A", "hi", T0, { superseded: true, runEnd: "error", runDone: true });
        const r = matchAttachments(rows, [a, rec("B", "hi", T0 + 30_000, { runEnd: "done" })]);
        expect([...r.matches]).toEqual([["rB", "B"]]);
        expect(r.fresh).toEqual([{ rowKey: "rB", clientMsgId: "B", via: "text", persist: true }]);
      });
      it("a send cut off by the network (uncertain, no run id) is tried only AFTER the confirmed records, 1:1 only, and never persisted", () => {
        const u = rec("U", "hi", T0, { runId: undefined, uncertain: true });
        const solo = matchAttachments([row("r1", "hi", T0 + 5000)], [u]);
        expect([...solo.matches]).toEqual([["r1", "U"]]); expect(solo.fresh).toEqual([{ rowKey: "r1", clientMsgId: "U", via: "text", persist: false }]);
        const both = matchAttachments([row("r1", "hi", T0 + 40_000)], [u, rec("B", "hi", T0 + 35_000, { runEnd: "done" })]);
        expect(Object.fromEntries(both.matches)).toEqual({ r1: "B" }); // the confirmed record keeps the row; the uncertain one shows nothing
      });
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
    describe("an exact run id overrides a stale text-only binding (review: wrong photo kept after the real row arrived)", () => {
      it("repro: the photo was bound by text to ANOTHER device's image-only row; the real run-stamped row then arrives → the photo moves to it", () => {
        const stale = rec("c1", "", T0, { runId: "run-1", matchedRowId: "other", runDone: true });
        const rows = [row("other", "", T0 + 3000), row("real", "", T0 + 6000, { runId: "run-1" })];
        const r = matchAttachments(rows, [stale]);
        expect([...r.matches]).toEqual([["real", "c1"]]);                       // not on the other device's message any more
        expect(r.fresh).toEqual([{ rowKey: "real", clientMsgId: "c1", via: "runId", persist: true }]); // bind() overwrites the stale binding
        unbindIs(r, []);                                                          // (an unbind after the bind would erase it: none is asked for)
      });
      it("sequence: first load has only the other row (fallback binds it, persisted once the turn finished), the next load brings the run-stamped row", () => {
        const first = matchAttachments([row("other", "", T0 + 3000)], [rec("c1", "", T0, { runId: "run-1", runDone: true, runEnd: "done" })]);
        expect(first.fresh).toEqual([{ rowKey: "other", clientMsgId: "c1", via: "text", persist: true }]);
        const second = matchAttachments([row("other", "", T0 + 3000), row("real", "", T0 + 6000, { runId: "run-1" })],
          [rec("c1", "", T0, { runId: "run-1", runDone: true, runEnd: "done", matchedRowId: "other" })]);
        expect([...second.matches]).toEqual([["real", "c1"]]);
        expect(second.fresh.map((f) => f.rowKey)).toEqual(["real"]);
      });
      it("two records, one bound by text to the wrong row: only that one moves, the other keeps its correct row", () => {
        const rows = [row("wrong", "x", T0 + 1000), row("right2", "x", T0 + 61_000), row("x1", "x", T0 + 2000, { runId: "run-1" })];
        const recs = [rec("c1", "x", T0, { runId: "run-1", matchedRowId: "wrong", runDone: true }), rec("c2", "x", T0 + 60_000, { runId: "run-2", matchedRowId: "right2", runDone: true })];
        const r = matchAttachments(rows, recs);
        expect(Object.fromEntries(r.matches)).toEqual({ x1: "c1", right2: "c2" });
        unbindIs(r, []);
      });
      it("a record WITHOUT a run id bound by text to a row that another record claimed by run id is unbound", () => {
        const r = matchAttachments([row("r1", "x", T0 + 1000, { runId: "run-1" })], [rec("c1", "x", T0, { runId: "run-1" }), rec("c2", "x", T0, { matchedRowId: "r1" })]);
        expect([...r.matches]).toEqual([["r1", "c1"]]);
        unbindIs(r, ["c2"]);
      });
      it("a persisted binding whose record's run id matches a DIFFERENT loaded row is dropped; a row stamped with some other run id never keeps it", () => {
        const dropped = matchAttachments([row("a", "x", T0), row("b", "x", T0 + 1000, { runId: "run-1" })], [rec("c1", "x", T0, { runId: "run-1", matchedRowId: "a" })]);
        expect([...dropped.matches]).toEqual([["b", "c1"]]);
        const clash = matchAttachments([row("a", "x", T0, { runId: "other" })], [rec("c1", "x", T0, { runId: "run-1", matchedRowId: "a" })]);
        expect(clash.matches.size).toBe(0); unbindIs(clash, ["c1"]);
      });
      it("exact matches do not depend on time or order (records sent out of row order still land on their own rows)", () => {
        const rows = [row("r2", "", T0 + 10 * min, { runId: "run-2" }), row("r1", "", T0 + 1000, { runId: "run-1" })];
        const r = matchAttachments(rows, [rec("c1", "", T0 + 9 * min, { runId: "run-1" }), rec("c2", "", T0, { runId: "run-2" })]);
        expect(Object.fromEntries(r.matches)).toEqual({ r1: "c1", r2: "c2" });
      });
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
    expect(pendingRecords([], [rec("c1", "x", T0, { runId: undefined })], new Map(), opts)).toEqual([]);
  });
  it("a row's run id decides whether it stands for the record: the same run id does, a DIFFERENT one never does (even with equal text), and one without a run id falls back to text and time", () => {
    const c = rec("c1", "x", T0, { runId: "run-1" });
    expect(pendingRecords([row("r1", "other text", T0 + 1000, { runId: "run-1" })], [c], new Map(), opts)).toEqual([]);     // same run id: stands for it whatever the text
    expect(pendingRecords([row("r1", "x", T0 + 1000, { runId: "run-9" })], [c], new Map(), opts).map((x) => x.clientMsgId)).toEqual(["c1"]); // another run's row: not this record's
    expect(pendingRecords([row("r1", "x", T0 + 1000)], [c], new Map(), opts)).toEqual([]);                                  // no run id: text + time
  });
  it("the known skew tightens the early bound for «stands for it» too", () => {
    const c = rec("c1", "x", T0, { runId: "run-1" }); const r = row("r1", "x", T0 - 55_000);
    expect(pendingRecords([r], [c], new Map(), opts)).toEqual([]);
    expect(pendingRecords([r], [c], new Map(), { ...opts, skewFor: () => -20_000 }).map((x) => x.clientMsgId)).toEqual(["c1"]);
  });
  it("not when it is bound to a row elsewhere (paged out), and not after 6 hours", () => {
    expect(pendingRecords([], [rec("c1", "x", T0, { runId: "r", matchedRowId: "r9" })], new Map(), opts)).toEqual([]);
    expect(pendingRecords([], [rec("c1", "x", T0, { runId: "r" })], new Map(), { now: T0 + 6 * 60 * min + 1 })).toEqual([]);
  });
  it("a record superseded by a retry is not a separate pending bubble (its row, if any, still shows its photo)", () => {
    expect(pendingRecords([], [{ ...rec("c1", "x", T0, { runId: "run-1" }), superseded: true }], new Map(), opts)).toEqual([]);
    expect(matchAttachments([row("r1", "x", T0 + 1000)], [{ ...rec("c1", "x", T0, { runId: "run-1" }), superseded: true }]).matches.size).toBe(0); // …and takes no part in the text fallback
    expect(matchAttachments([row("r1", "x", T0 + 1000, { runId: "run-1" })], [{ ...rec("c1", "x", T0, { runId: "run-1" }), superseded: true }]).matches.size).toBe(1); // (its exact run id still matches)
  });
  it("ordered by send time", () => {
    const recs = [rec("c2", "b", T0 + 5000, { runId: "r2" }), rec("c1", "a", T0, { runId: "r1" })];
    expect(pendingRecords([], recs, new Map(), opts).map((c) => c.clientMsgId)).toEqual(["c1", "c2"]);
  });
});
