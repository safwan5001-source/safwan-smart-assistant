import { describe, expect, it } from "vitest";
import type { AssistantStatus } from "@/lib/assistant";
import { parseEngineStatus, unknownEngineStatus, type EngineStatus } from "@/lib/engine-status";
import {
  STATUS_LABEL, STATUS_LEVELS, UNKNOWN_READING, checkedText, isStatusLevel, readApprovals, readEngine, readPush, readServer, readVoice, readingLabel,
  statusIcon, statusTone, worse, type EngineSnapshot, type StatusLevel,
} from "@/lib/status-model";

const NOW = 1_800_000_000_000;
const online = (over: Partial<Extract<AssistantStatus, { server: "online" }>> = {}): AssistantStatus =>
  ({ server: "online", assistant: false, version: "0.4.0", basht: "connected", bashtChat: true, ...over });
const eng = (over: Record<string, unknown> = {}): EngineStatus => parseEngineStatus({ ok: true, link: { state: "up" }, voice: { speak: "ready" }, runs: { approvalsPending: 0, complete: true }, ...over });
const snap = (status: EngineStatus | null, at = NOW - 5000): EngineSnapshot => ({ status, at, observedAt: at }); // observed when asked, unless a test says otherwise
const NO_VOICE = { speak: "unknown" as const, reason: "" as const, at: null };

describe("request signing is information only (HMAC is not yet enabled)", () => {
  it("the engine and voice rows never depend on what the engine says about signing, so tested_ok can never claim a signing success", () => {
    const base = readEngine(online(), NOW, snap(eng())).level;
    const baseVoice = readVoice(snap(eng()), NO_VOICE).level;
    for (const mode of ["off", "optional", "required"]) for (const active of [true, false, null]) {
      const signing = active === null ? { mode } : { mode, active };
      expect(readEngine(online(), NOW, snap(eng({ signing }))).level, `${mode}/${active}`).toBe(base);
      expect(readVoice(snap(eng({ signing })), NO_VOICE).level, `${mode}/${active}`).toBe(baseVoice);
    }
    expect(readEngine(online(), NOW, snap(eng({ signing: { mode: "optional", active: false } }))).level).not.toBe("down");
  });
});

describe("the level vocabulary", () => {
  it("is exactly the six levels, each with a distinct Arabic label, tone and icon rule", () => {
    expect([...STATUS_LEVELS]).toEqual(["unknown", "configured", "reachable", "tested_ok", "degraded", "down"]);
    expect(new Set(STATUS_LEVELS.map((l) => STATUS_LABEL[l])).size).toBe(6);
    expect(isStatusLevel("tested_ok")).toBe(true);
    expect(isStatusLevel("ok")).toBe(false);
  });
  it("success colour and the success icon belong to tested_ok ONLY; unknown and configured are neutral", () => {
    for (const l of STATUS_LEVELS) expect(statusTone(l) === "ok", l).toBe(l === "tested_ok");
    for (const l of STATUS_LEVELS) expect(statusIcon(l) === "check-circle", l).toBe(l === "tested_ok");
    expect(statusTone("unknown")).toBeUndefined();
    expect(statusTone("configured")).toBeUndefined();
    expect(statusTone("down")).toBe("danger");
    expect(statusTone("degraded")).toBe("warn");
  });
  it("a custom label never changes the level or the tone", () => {
    const r = readPush("off", NOW);
    expect(readingLabel(r)).toBe("غير مفعّلة");
    expect(r.level).toBe("unknown");
    expect(statusTone(r.level)).toBeUndefined();
  });
  it("worse() picks the more worrying level and is symmetric", () => {
    for (const a of STATUS_LEVELS) for (const b of STATUS_LEVELS) expect(worse(a, b)).toBe(worse(b, a));
    expect(worse("tested_ok", "degraded")).toBe("degraded");
    expect(worse("degraded", "down")).toBe("down");
    expect(worse("reachable", "unknown")).toBe("unknown");
  });
  it("the default reading has no time and says unknown", () => {
    expect(UNKNOWN_READING).toEqual({ level: "unknown", checkedAt: null });
  });
});

describe("last check text", () => {
  const rel = (ts: number, now: number) => (now - ts < 60_000 ? "الآن" : "قبل 5 دقائق");
  it("null is «لم يُفحص بعد», never a made-up time", () => {
    expect(checkedText(null, NOW, rel)).toBe("لم يُفحص بعد");
    expect(checkedText(NOW - 1000, NOW, rel)).toBe("آخر فحص الآن");
    expect(checkedText(NOW - 300_000, NOW, rel)).toBe("آخر فحص قبل 5 دقائق");
  });
});

describe("server (the public health)", () => {
  it("checking = unknown, offline = down, online = a live signed check passed", () => {
    expect(readServer({ server: "checking" }, null)).toEqual({ level: "unknown", checkedAt: null });
    expect(readServer({ server: "offline" }, NOW)).toMatchObject({ level: "down", checkedAt: NOW });
    expect(readServer(online(), NOW)).toMatchObject({ level: "tested_ok", checkedAt: NOW, detail: "الإصدار 0.4.0" });
    expect(readServer(online({ version: "?" }), NOW).detail).toBeUndefined();
  });
  it("the legacy Claude key plays no part: the same server reading with it configured or not", () => {
    expect(readServer(online({ assistant: true }), NOW)).toEqual(readServer(online({ assistant: false }), NOW));
  });
});

describe("engine readiness (جاهزية باشت)", () => {
  it("no data is unknown with no success colour: checking, no snapshot at all, an app server that cannot be reached", () => {
    expect(readEngine({ server: "checking" }, null, null).level).toBe("unknown");
    expect(readEngine({ server: "offline" }, NOW, snap(eng())).level).toBe("unknown"); // the app server is down: nothing is known about the engine
    expect(readEngine({ server: "offline" }, NOW, null).level).toBe("unknown");
  });
  it("an engine that is not configured is unknown and says «غير مربوط», not down", () => {
    const r = readEngine(online({ basht: "unconfigured", bashtChat: false }), NOW, null);
    expect(r).toMatchObject({ level: "unknown", label: "غير مربوط" });
  });
  it("without the engine's own status only the public gateway check speaks: connected = reachable (never tested_ok), starting = degraded, offline = down", () => {
    expect(readEngine(online({ basht: "connected" }), NOW, null).level).toBe("reachable");
    expect(readEngine(online({ basht: "connected" }), NOW, snap(null)).level).toBe("reachable");
    expect(readEngine(online({ basht: "starting" }), NOW, null).level).toBe("degraded");
    expect(readEngine(online({ basht: "offline" }), NOW, null).level).toBe("down");
  });
  it("the engine answered through the signed bridge with its link up = tested_ok (and says «جاهز»), stamped with the time of THAT read", () => {
    const r = readEngine(online(), NOW, snap(eng(), NOW - 7000));
    expect(r).toMatchObject({ level: "tested_ok", label: "جاهز", checkedAt: NOW - 7000 });
  });
  it("link states: connecting and down are degraded, off or unreported is only reachable", () => {
    expect(readEngine(online(), NOW, snap(eng({ link: { state: "connecting" } }))).level).toBe("degraded");
    expect(readEngine(online(), NOW, snap(eng({ link: { state: "down" } }))).level).toBe("degraded");
    expect(readEngine(online(), NOW, snap(eng({ link: { state: "off" } }))).level).toBe("reachable");
    expect(readEngine(online(), NOW, snap(eng({ link: undefined }))).level).toBe("reachable"); // an older engine without `link`
    expect(readEngine(online(), NOW, snap(eng({ link: { state: "bogus" } }))).level).toBe("reachable");
  });
  it("asked and not answered: a live gateway means a broken app path (degraded), a dead gateway is down; never tested_ok", () => {
    const none = snap(unknownEngineStatus());
    expect(readEngine(online({ basht: "connected" }), NOW, none).level).toBe("degraded");
    expect(readEngine(online({ basht: "starting" }), NOW, none).level).toBe("degraded");
    expect(readEngine(online({ basht: "offline" }), NOW, none).level).toBe("down");
    expect(readEngine(online({ basht: "unconfigured", bashtChat: true }), NOW, none).level).toBe("down");
  });
  it("a healthy link never hides a gateway that is not ready", () => {
    expect(readEngine(online({ basht: "starting" }), NOW, snap(eng())).level).toBe("degraded");
    expect(readEngine(online({ basht: "unconfigured" }), NOW, snap(eng())).level).toBe("degraded"); // the two checks disagree: never success
    expect(readEngine(online({ basht: "offline" }), NOW, snap(eng())).level).toBe("degraded");
  });
  it("tested_ok is reachable only through ONE path: an answered status with link up and a ready gateway (no other input can show success)", () => {
    const apps: AssistantStatus[] = [{ server: "checking" }, { server: "offline" }, ...(["connected", "starting", "offline", "unconfigured"] as const).flatMap((b) => [online({ basht: b }), online({ basht: b, bashtChat: false })])];
    const snaps: (EngineSnapshot | null)[] = [null, snap(null), snap(unknownEngineStatus()), snap(eng()), snap(eng({ link: { state: "down" } })), snap(eng({ link: undefined }))];
    for (const a of apps) for (const s of snaps) {
      const r = readEngine(a, NOW, s);
      if (r.level === "tested_ok") {
        expect(a).toMatchObject({ server: "online", basht: "connected" });
        expect(s?.status?.reachable).toBe(true);
        expect(s?.status?.link.state).toBe("up");
      }
    }
  });
});

describe("voice", () => {
  it("no data = unknown (no snapshot, not answered, an engine that says unknown, an older engine without voice)", () => {
    expect(readVoice(null, NO_VOICE).level).toBe("unknown");
    expect(readVoice(snap(null), NO_VOICE).level).toBe("unknown");
    expect(readVoice(snap(unknownEngineStatus()), NO_VOICE).level).toBe("unknown");
    expect(readVoice(snap(eng({ voice: { speak: "unknown" } })), NO_VOICE).level).toBe("unknown");
    expect(readVoice(snap(eng({ voice: undefined })), NO_VOICE).level).toBe("unknown");
  });
  it("the engine saying «ready» is only `configured`: nothing was spoken yet", () => {
    expect(readVoice(snap(eng()), NO_VOICE)).toMatchObject({ level: "configured", checkedAt: NOW - 5000 });
  });
  it("degraded / mismatch / unconfigured from the engine, with the allowlisted reason's Arabic text", () => {
    expect(readVoice(snap(eng({ voice: { speak: "degraded", reason: "link_down" } })), NO_VOICE)).toMatchObject({ level: "degraded", detail: expect.stringContaining("منقطع") });
    expect(readVoice(snap(eng({ voice: { speak: "mismatch", reason: "identity_mismatch" } })), NO_VOICE).level).toBe("down");
    expect(readVoice(snap(eng({ voice: { speak: "unconfigured" } })), NO_VOICE).level).toBe("down");
  });
  it("a playback that failed (audio fetched, not played) is degraded and beats an older success; never tested_ok", () => {
    expect(readVoice(snap(eng()), { speak: "yes", reason: "", at: NOW - 500, failed: { at: NOW - 100 } })).toMatchObject({ level: "degraded", checkedAt: NOW - 100 });
    expect(readVoice(snap(eng()), { speak: "unknown", reason: "", at: null, failed: { at: NOW } }).level).toBe("degraded");
    expect(readVoice(snap(eng()), { speak: "yes", reason: "", at: NOW, failed: null }).level).toBe("tested_ok");
  });
  it("I2: the NEWER evidence wins: an old real success loses to a newer engine «unconfigured / mismatch / degraded», keeps beating a «ready»", () => {
    const old = { speak: "yes" as const, reason: "" as const, at: NOW - 3_600_000 };
    for (const [speak, level] of [["unconfigured", "down"], ["mismatch", "down"], ["degraded", "degraded"]] as const) {
      expect(readVoice(snap(eng({ voice: { speak } }), NOW), old).level, speak).toBe(level);
    }
    expect(readVoice(snap(eng({ voice: { speak: "ready" } }), NOW), old).level).toBe("tested_ok");
    // an OLDER engine statement does not override a newer real success
    expect(readVoice(snap(eng({ voice: { speak: "unconfigured" } }), NOW - 7_200_000), old).level).toBe("tested_ok");
    // tie: the worse
    expect(readVoice(snap(eng({ voice: { speak: "degraded" } }), old.at), old).level).toBe("degraded");
    // a newer «ready» replaces an older durable failure; an older one does not
    const no = { speak: "no" as const, reason: "provider_error" as const, at: NOW - 1000 };
    expect(readVoice(snap(eng(), NOW), no).level).toBe("configured");
    expect(readVoice(snap(eng(), NOW - 5000), no).level).toBe("down");
  });
  it("a real transient failure is kept against a newer «ready» (only a real success clears it); a newer success beats it", () => {
    const f = { speak: "yes" as const, reason: "" as const, at: NOW - 5000, failed: { at: NOW - 1000, kind: "unavailable", reason: "link_down" as const } };
    expect(readVoice(snap(eng(), NOW), f)).toMatchObject({ level: "degraded", detail: expect.stringContaining("منقطع") });
    expect(readVoice(snap(eng(), NOW), { ...f, at: NOW, failed: null }).level).toBe("tested_ok");
  });
  it("a real transcription failure folds in: never better than «جزئي»; a worse level stays", () => {
    expect(readVoice(snap(eng()), { speak: "yes", reason: "", at: NOW, transcribe: "no" })).toMatchObject({ level: "degraded", detail: expect.stringContaining("تفريغ") });
    expect(readVoice(snap(eng()), { speak: "unknown", reason: "", at: null, transcribe: "no" }).level).toBe("degraded");
    expect(readVoice(snap(eng({ voice: { speak: "mismatch" } })), { speak: "unknown", reason: "", at: null, transcribe: "no" }).level).toBe("down");
    expect(readVoice(snap(eng()), { speak: "yes", reason: "", at: NOW, transcribe: "yes" }).level).toBe("tested_ok");
  });
  it("a real voice reply beats the declaration (tested_ok); a real failure beats it too (down)", () => {
    expect(readVoice(snap(eng()), { speak: "yes", reason: "", at: NOW - 100 })).toMatchObject({ level: "tested_ok", checkedAt: NOW - 100 });
    expect(readVoice(snap(eng()), { speak: "no", reason: "provider_error", at: NOW - 200 })).toMatchObject({ level: "down", checkedAt: NOW - 200 });
    expect(readVoice(null, { speak: "yes", reason: "", at: NOW }).level).toBe("tested_ok"); // learned from a real call even when the status was never read
  });
});

describe("push registration", () => {
  it("not read yet = unknown with no time", () => {
    expect(readPush(null, null)).toEqual({ level: "unknown", checkedAt: null });
    expect(readPush("loading", NOW)).toEqual({ level: "unknown", checkedAt: null });
  });
  it("registered is `configured` (never tested_ok, no test push was sent); off, unsupported, needs_install say what they are but stay unknown", () => {
    expect(readPush("on", NOW)).toMatchObject({ level: "configured", checkedAt: NOW });
    for (const s of ["off", "needs_install", "unsupported"] as const) expect(readPush(s, NOW), s).toMatchObject({ level: "unknown", checkedAt: NOW });
  });
  it("denied, unconfigured server and errors are down", () => {
    for (const s of ["denied", "unconfigured", "error"] as const) expect(readPush(s, NOW).level, s).toBe("down");
  });
});

describe("approvals", () => {
  it("unknown unless the engine answered with its link up and a count", () => {
    expect(readApprovals(null).level).toBe("unknown");
    expect(readApprovals(snap(unknownEngineStatus())).level).toBe("unknown");
    expect(readApprovals(snap(eng({ link: { state: "off" }, runs: undefined }))).level).toBe("unknown");
    expect(readApprovals(snap(eng({ link: { state: "up" }, runs: undefined }))).level).toBe("unknown"); // no count at all: nothing is invented
  });
  it("a link that is not up is degraded, never an empty «all clear»", () => {
    expect(readApprovals(snap(eng({ link: { state: "down" } }))).level).toBe("degraded");
    expect(readApprovals(snap(eng({ link: { state: "connecting" } }))).level).toBe("degraded");
  });
  it("a counted list is `reachable` with the count in the label; 0 says nothing is waiting", () => {
    expect(readApprovals(snap(eng()))).toMatchObject({ level: "reachable", label: "لا شيء" });
    expect(readApprovals(snap(eng({ runs: { approvalsPending: 3, complete: true } })))).toMatchObject({ level: "reachable", label: "3 بانتظارك" });
    expect(readApprovals(snap(eng({ runs: undefined, link: { state: "up", pendingApprovals: 2 } }))).label).toBe("2 بانتظارك");
  });
});

describe("no transition ever invents a success", () => {
  it("across every source, tested_ok needs data: with every input empty or unknown, no reading is ok", () => {
    const empty: StatusLevel[] = [
      readServer({ server: "checking" }, null).level, readEngine({ server: "checking" }, null, null).level, readVoice(null, NO_VOICE).level,
      readPush(null, null).level, readApprovals(null).level, readVoice(snap(unknownEngineStatus()), NO_VOICE).level,
      readEngine(online({ basht: "unconfigured", bashtChat: false }), null, null).level,
    ];
    for (const l of empty) expect(statusTone(l), l).toBeUndefined();
  });
});
