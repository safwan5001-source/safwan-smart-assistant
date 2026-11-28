import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/timeline-items";
import { engineRowView } from "@/lib/engine-row";
import { turnOutcome } from "@/lib/turn-outcome";
import { pendingRecords, type MatchRow, type MatchRecord } from "@/lib/attachment-match";
import { parseVoiceNote } from "@/lib/basht-voice";
import { RATE_LIMIT_IMAGE_TEXT, RATE_LIMIT_TEXT } from "@/lib/run-error";

const T0 = 1_700_000_000_000;
const row = (key: string, text: string, at: number, role: MatchRow["role"] = "user"): MatchRow => ({ key, role, text, at, hasServerMedia: false });
const rec = (id: string, text: string, sentAt: number): MatchRecord => ({ clientMsgId: id, text, sentAt, runId: "run-" + id });

describe("the timeline: a sent photo whose row has not appeared stays in it", () => {
  const timeline = (rows: MatchRow[], recs: MatchRecord[], matched = new Map<string, string>(), liveRunIds: string[] = []) => {
    const pending = pendingRecords(rows, recs, matched, { now: T0 + 60_000, liveRunIds });
    return buildTimeline({ local: [], engine: rows.map((r) => ({ at: r.at, role: r.role })), pending });
  };
  it("the history reloads without the row: the pending message is an item of the timeline, ordered by its send time", () => {
    const rows = [row("a", "قبلها", T0 - 120_000), row("b", "ردّ", T0 + 30_000, "assistant")];
    const items = timeline(rows, [rec("c1", "", T0)]);
    expect(items.map((i) => i.kind)).toEqual(["engine", "pending", "engine"]);
    expect(items[1]).toMatchObject({ kind: "pending", p: { clientMsgId: "c1" } });
  });
  it("once the row is in the history the pending item is gone (no duplicate bubble)", () => {
    const rows = [row("u1", "", T0 + 2000)];
    expect(timeline(rows, [rec("c1", "", T0)]).map((i) => i.kind)).toEqual(["engine"]);
  });
  it("while the run is on screen the live bubble stands for it (no pending twin)", () => {
    expect(timeline([], [rec("c1", "", T0)], new Map(), ["run-c1"])).toEqual([]);
    expect(timeline([], [rec("c1", "", T0)]).map((i) => i.kind)).toEqual(["pending"]);
  });
  it("this device's own events, the engine's rows and pending messages are merged by time", () => {
    const items = buildTimeline({ local: [{ created: T0 + 5 }], engine: [{ at: T0 }, { at: T0 + 10 }], pending: [{ sentAt: T0 + 7 }] });
    expect(items.map((i) => i.kind)).toEqual(["engine", "local", "pending", "engine"]);
    expect(items.filter((i) => i.kind === "engine").map((i) => (i as { i: number }).i)).toEqual([0, 1]);
  });
});

describe("an engine row's bubble text", () => {
  it("an image-only owner row: the engine's bare placeholder is stripped, so the bubble has no words and needs its photo or an honest placeholder", () => {
    for (const text of ["", "[image]", "<media:image>", "User sent image(s) with no text.", "  [صورة]  "]) {
      const v = engineRowView({ role: "user", text }, parseVoiceNote);
      expect(v.text).toBe(""); expect(v.noText).toBe(true);
    }
  });
  it("a caption stays; a voice note is not «no text»; a photo still being read from the device is not flagged either", () => {
    expect(engineRowView({ role: "user", text: "شوف" }, parseVoiceNote)).toMatchObject({ text: "شوف", noText: false });
    expect(engineRowView({ role: "user", text: "[image] شوف" }, parseVoiceNote).text).toBe("[image] شوف"); // not placeholder-ONLY: kept as the engine wrote it
    const voice = engineRowView({ role: "user", text: "[رسالة صوتية] ما مواعيدي؟" }, parseVoiceNote);
    expect(voice.voice).toBe(true); expect(voice.noText).toBe(false);
    expect(engineRowView({ role: "user", text: "" }, parseVoiceNote, true).noText).toBe(false);
  });
  it("assistant rows are never «no text» and show the provider's quota notice as clear Arabic", () => {
    expect(engineRowView({ role: "assistant", text: "" }, parseVoiceNote).noText).toBe(false);
    expect(engineRowView({ role: "assistant", text: "OpenAI Codex image generation failed (HTTP 429) usage_limit_reached" }, parseVoiceNote).assistantText).toBe(RATE_LIMIT_IMAGE_TEXT);
    expect(engineRowView({ role: "assistant", text: "usage_limit_reached" }, parseVoiceNote).assistantText).toBe(RATE_LIMIT_TEXT);
    expect(engineRowView({ role: "assistant", text: "رمز 429 يعني كثرة الطلبات" }, parseVoiceNote).assistantText).toBe("رمز 429 يعني كثرة الطلبات");
  });
});

describe("what a finished turn does to the retry copy", () => {
  const turn = { text: "ولّد صورة", images: [{ id: "i" }], clientMsgId: "c1" };
  it("a rate-limited turn keeps NO retry copy (a resend would hit the limit again) and releases its previews; the voice session gets the clear text", () => {
    const o = turnOutcome({ status: "error", text: "OpenAI Codex image generation failed (HTTP 429) usage_limit_reached", errorCode: "rate_limited" }, turn);
    expect(o.nextLastTurn).toBeNull(); expect(o.failed).toBeNull(); expect(o.finished).toBe(turn);
    expect(o.endText).toBe(RATE_LIMIT_IMAGE_TEXT); expect(o.error).toBe(RATE_LIMIT_IMAGE_TEXT);
    expect(turnOutcome({ status: "error", text: "", errorCode: "rate_limited" }, turn).error).toBe(RATE_LIMIT_TEXT);
  });
  it("any other failure keeps the copy for «إعادة المحاولة»; stopped too; success clears it", () => {
    const err = turnOutcome({ status: "error", text: "boom" }, turn);
    expect(err.nextLastTurn).toBe(turn); expect(err.failed).toBe(turn); expect(err.finished).toBeNull(); expect(err.endText).toBe("boom");
    expect(err.error).toContain("تعذّر إكمال الرد");
    const stopped = turnOutcome({ status: "stopped", text: "جزء" }, turn);
    expect(stopped.failed).toBe(turn); expect(stopped.error).toBe("أُوقف الرد.");
    const done = turnOutcome({ status: "done", text: "تم" }, turn);
    expect(done.nextLastTurn).toBeNull(); expect(done.failed).toBeNull(); expect(done.finished).toBe(turn); expect(done.error).toBe("");
  });
  it("an ordinary error that merely mentions HTTP 429 is NOT treated as a rate limit", () => {
    expect(turnOutcome({ status: "error", text: "request failed with HTTP 429" }, turn).failed).toBe(turn);
  });
  it("no turn in memory: nothing to keep or release", () => {
    expect(turnOutcome({ status: "error", text: "x" }, null)).toMatchObject({ finished: null, nextLastTurn: null, failed: null });
  });
});
