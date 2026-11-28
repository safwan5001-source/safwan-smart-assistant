import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BashtError, createBashtClient, DURABLE_VOICE_REASONS, TRANSIENT_VOICE_REASONS, VOICE_REASONS, VOICE_REASON_TEXT, voiceReasonText } from "@/lib/basht-client";
import { isDurableVoiceFailure, speakGate } from "@/lib/voice-status";
import { createVoicePlayer, voiceAvailability } from "@/lib/basht-voice";

const contract = JSON.parse(readFileSync(resolve(__dirname, "../../../services/api/tests/fixtures/voice-contract.json"), "utf8")) as { reasons: string[] };
const json = (body: unknown, status = 503) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const speakError = (reason?: string) => createBashtClient(async () => json({ error: "voice_unavailable", ...(reason !== undefined ? { reason } : {}) })).speak("x").then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as BashtError);

beforeEach(() => voiceAvailability.reset());

describe("voice reasons: the browser allowlist IS the shared contract", () => {
  it("same tokens, same order; every reason has Arabic text and exactly one class", () => {
    expect([...VOICE_REASONS]).toEqual(contract.reasons);
    for (const r of VOICE_REASONS) {
      expect(VOICE_REASON_TEXT[r]).toMatch(/[؀-ۿ]/);
      expect(Number(DURABLE_VOICE_REASONS.includes(r)) + Number(TRANSIENT_VOICE_REASONS.includes(r))).toBe(1);
    }
  });
  it("classification of every contract reason (as received from /speak)", async () => {
    const durable = ["identity_mismatch", "tool_denied", "unconfigured", "no_tts_config", "config_unreadable", "tool_path_unavailable"];
    for (const r of contract.reasons) {
      const e = await speakError(r);
      expect(e.reason, r + " survives the client").toBe(r);
      expect(isDurableVoiceFailure(e.reason, e.reasonGiven), r).toBe(durable.includes(r));
      expect(e.message).toContain(voiceReasonText(r));
    }
  });
  it("an older engine (no reason) stays durable; an unknown token is transient, never durable", async () => {
    const old = await speakError();
    expect(old.reasonGiven).toBe(false);
    expect(isDurableVoiceFailure(old.reason, old.reasonGiven)).toBe(true);
    const unknown = await speakError("brand_new_reason");
    expect(unknown.reason).toBeUndefined(); expect(unknown.reasonGiven).toBe(true);
    expect(isDurableVoiceFailure(unknown.reason, unknown.reasonGiven)).toBe(false);
  });
  it("a transient failure (engine_error, in_flight, unknown token) leaves «استمع» and the live voice available; retry works", async () => {
    for (const reason of ["engine_error", "in_flight", "per_minute", "brand_new_reason"]) {
      voiceAvailability.reset();
      let fail = true;
      const client = createBashtClient(async () => fail ? json({ error: "voice_unavailable", reason }) : new Response(new Blob(["a"]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
      const el = { src: "", currentTime: 0, muted: false, play: async () => {}, pause: () => {}, addEventListener: () => {} };
      const p = createVoicePlayer({ speak: (t, s) => client.speak(t, s), audio: () => el, url: { create: () => "blob:x", revoke: () => {} } });
      expect(await p.play("m", "نص.")).toBe("error");
      expect(p.getSnapshot().phase).toBe("error");
      expect(voiceAvailability.get().speak, reason).not.toBe("no");
      expect(speakGate(voiceAvailability.get(), { speak: "unknown", features: [] }).show, reason).toBe(true);
      fail = false;
      void p.play("m", "نص."); // the owner's «أعد المحاولة»
      await new Promise((r) => setTimeout(r, 0));
      expect(p.getSnapshot().phase).toBe("preparing");
      expect(voiceAvailability.get().speak, "a fetched blob is not a proven voice").toBe("unknown");
      p.stop();
    }
  });
  it("a configuration failure still hides the controls", async () => {
    const client = createBashtClient(async () => json({ error: "voice_unavailable", reason: "no_tts_config" }));
    const el = { src: "", currentTime: 0, muted: false, play: async () => {}, pause: () => {}, addEventListener: () => {} };
    const p = createVoicePlayer({ speak: (t, s) => client.speak(t, s), audio: () => el, url: { create: () => "blob:x", revoke: () => {} } });
    await p.play("m", "نص.");
    expect(voiceAvailability.get()).toMatchObject({ speak: "no", reason: "no_tts_config" });
    expect(speakGate(voiceAvailability.get(), { speak: "unknown", features: [] }).show).toBe(false);
  });
});
