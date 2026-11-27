import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BashtError, createBashtClient, parseVoiceStatus, voiceReasonText } from "@/lib/basht-client";
import { speakableText, stripMediaMarkers } from "@/lib/speakable";
import { createVoiceStatusStore, isDurableVoiceFailure, speakGate } from "@/lib/voice-status";
import ListenButton, { listenLabel, listenState } from "@/features/chat/listen-button";
import type { PlayerState } from "@/lib/basht-voice";

const WEB = resolve(__dirname, "..");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("speakableText / stripMediaMarkers", () => {
  it("drops MEDIA lines and inline markers, keeping the sentences", () => {
    expect(speakableText("تم إنشاء الصورة.\nMEDIA: /tmp/openclaw/out/a.png\nهل تريد غيرها؟")).toBe("تم إنشاء الصورة.\nهل تريد غيرها؟");
    expect(speakableText("هذه هي MEDIA: /var/data/x.pdf كما طلبت.")).toBe("هذه هي كما طلبت.");
    expect(speakableText("  - media: \"/a b/c.png\"\nتم")).toBe("تم");
  });
  it("drops absolute paths, URLs, code and markdown noise, keeps link labels", () => {
    expect(speakableText("## الخلاصة\n- **الأول**: جاهز\n- _الثاني_ قيد العمل")).toBe("الخلاصة\nالأول: جاهز\nالثاني قيد العمل");
    expect(speakableText("راجع [التقرير](https://example.test/r) أو https://example.test/x الآن.")).toBe("راجع التقرير أو الآن.");
    expect(speakableText("الملف في /home/user/docs/a.txt و C:\\data\\b.txt")).toBe("الملف في و");
    expect(speakableText("مثال:\n```js\nconsole.log(1)\n```\nانتهى")).toBe("مثال:\nانتهى");
    expect(speakableText("| الاسم | الحالة |\n|---|---|\n| أ | تم |")).toBe("الاسم، الحالة\nأ، تم");
    expect(speakableText("و/أو 1/2")).toBe("و/أو 1/2"); // not a path
  });
  it("while streaming, a marker still arriving at the end is hidden (display keeps markdown)", () => {
    expect(stripMediaMarkers("**تم** الحفظ.\nMEDI", { streaming: true })).toBe("**تم** الحفظ.");
    expect(stripMediaMarkers("تم الحفظ.\nMEDIA: /tmp/a", { streaming: true })).toBe("تم الحفظ.");
    expect(stripMediaMarkers("تم الحفظ. M", { streaming: true })).toBe("تم الحفظ.");
    expect(stripMediaMarkers("Mohammed", { streaming: true })).toBe("Mohammed"); // a word, not a marker
    expect(stripMediaMarkers("")).toBe("");
  });
});

describe("BashtError.reason and voiceStatus()", () => {
  it("a voice error keeps its allowlisted reason (speak and transcribe); unknown reasons are dropped", async () => {
    const c = createBashtClient(async (url) => String(url).includes("speak")
      ? json({ error: "voice_unavailable", reason: "identity_mismatch" }, 503)
      : json({ error: "voice_unavailable", reason: "<script>" }, 503));
    const e = await c.speak("x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BashtError);
    expect((e as BashtError).reason).toBe("identity_mismatch");
    expect((e as BashtError).message).toContain(voiceReasonText("identity_mismatch"));
    const t = await c.transcribe(new Blob(["a"], { type: "audio/webm" })).catch((x: unknown) => x);
    expect((t as BashtError).code).toBe("voice_unavailable");
    expect((t as BashtError).reason).toBeUndefined();
    expect(new BashtError("network").reason).toBeUndefined();
  });
  it("voiceStatus never throws: any failure is { speak: unknown, features: [] }", async () => {
    expect(await createBashtClient(async () => json({ speak: "degraded", reason: "provider_error", features: ["voice.speak.v2", 3] })).voiceStatus())
      .toEqual({ speak: "degraded", reason: "provider_error", features: ["voice.speak.v2"] });
    expect(await createBashtClient(async () => json({ speak: "mismatch", reason: "nope" })).voiceStatus()).toEqual({ speak: "mismatch", features: [] });
    for (const f of [async () => json({ error: "x" }, 500), async () => { throw new TypeError("offline"); }, async () => new Response("<html>", { status: 200 }), async () => json({ speak: "yes" })]) {
      expect(await createBashtClient(f as typeof fetch).voiceStatus()).toEqual({ speak: "unknown", features: [] });
    }
    expect(parseVoiceStatus(null)).toEqual({ speak: "unknown", features: [] });
  });
});

describe("voice-status gating", () => {
  const learned = (speak: "unknown" | "yes" | "no", reason: "" | "provider_error" | "unconfigured" = "") => ({ speak, reason });
  it("mismatch / unconfigured hide «استمع» with a note; degraded / ready / unknown show it", () => {
    expect(speakGate(learned("unknown"), { speak: "mismatch", features: [] })).toMatchObject({ show: false });
    expect(speakGate(learned("yes"), { speak: "unconfigured", reason: "unconfigured", features: [] }).note).toBe(voiceReasonText("unconfigured"));
    expect(speakGate(learned("unknown"), { speak: "degraded", features: [] }).show).toBe(true);
    expect(speakGate(learned("unknown"), { speak: "ready", features: [] })).toEqual({ show: true, note: "" });
    expect(speakGate(learned("unknown"), { speak: "unknown", features: [] }).show).toBe(true);
    expect(speakGate(learned("no", "unconfigured"), { speak: "ready", features: [] })).toMatchObject({ show: false }); // a real failure wins
    expect(isDurableVoiceFailure("provider_error")).toBe(false);
    expect(isDurableVoiceFailure("tool_denied")).toBe(true);
    expect(isDurableVoiceFailure(undefined)).toBe(true); // an old engine without reasons: as before
  });
  it("fetched once, refreshed at most every 60 s (focus), deduplicated while in flight, never failing", async () => {
    let now = 0, calls = 0;
    const store = createVoiceStatusStore({ fetch: async () => { calls++; if (calls === 3) throw new Error("x"); return { speak: "ready", features: [] }; }, now: () => now });
    await Promise.all([store.refresh(), store.refresh()]);
    expect(calls).toBe(1);
    now = 59_000; await store.refresh(); expect(calls).toBe(1);
    now = 60_001; await store.refresh(); expect(calls).toBe(2);
    await store.refresh({ force: true }); expect(calls).toBe(3);
    expect(store.get().status).toEqual({ speak: "unknown", features: [] });
  });
  it("the conversation fetches it while BASHT is open", () => {
    expect(src("features/chat/chat-screen.tsx")).toMatch(/useVoiceStatus\(voiceOn\);/);
    expect(src("lib/voice-status.ts")).toMatch(/window\.addEventListener\("focus", again\)/);
  });
});

describe("«استمع»: states, labels and a stable id", () => {
  const base: PlayerState = { id: null, phase: "idle", error: "", code: "", errorKind: "", errorReason: "", canResume: false };
  it("maps the player's honest phases for THIS reply only", () => {
    expect(listenState(base, "a")).toBe("ready");
    expect(listenState({ ...base, id: "a", phase: "preparing" }, "a")).toBe("preparing");
    expect(listenState({ ...base, id: "a", phase: "playing" }, "a")).toBe("playing");
    expect(listenState({ ...base, id: "a", phase: "playing" }, "b")).toBe("ready");
    expect(listenState({ ...base, id: "a", phase: "error" }, "a")).toBe("error");
  });
  it("labels: ready · preparing · stop · retry (or «شغّل الصوت» to continue the same audio)", () => {
    expect(listenLabel("ready", false).text).toBe("استمع");
    expect(listenLabel("preparing", false).text).toBe("يجهّز الصوت…");
    expect(listenLabel("playing", false)).toEqual({ text: "إيقاف", aria: "إيقاف صوت باشت" });
    expect(listenLabel("error", false).text).toBe("أعد المحاولة");
    expect(listenLabel("error", true).text).toBe("شغّل الصوت");
  });
  it("renders an accessible button (server render: ready)", () => {
    const html = renderToStaticMarkup(createElement(ListenButton, { id: "row-1", text: "مرحبا" }));
    expect(html).toContain('aria-label="استمع إلى الرد بصوت باشت"');
    expect(html).toContain('data-state="ready"');
    expect(renderToStaticMarkup(createElement(ListenButton, { id: "row-1", text: "  " }))).toBe("");
  });
  it("the timeline keys and ids engine rows by their engine id (index + time only as a fallback)", () => {
    const chat = src("features/chat/chat-screen.tsx");
    expect(chat).toMatch(/<ListenButton id=\{m\.id \|\| key\}/);
    expect(chat).not.toMatch(/engineBubble\(it\.m, `e-\$\{it\.i\}-\$\{it\.at\}`\)/);
  });
  it("the tap enters the playback session and unlocks inside the gesture, never re-requests by itself", () => {
    const btn = src("features/chat/listen-button.tsx");
    expect(btn).toMatch(/enterVoiceSession\("playback"\);[\s\S]*?p\.unlock\(\);\s*void p\.play\(id, text\)/);
    expect(btn).not.toMatch(/setTimeout|setInterval/);
  });
});

describe("honest labels: browser dictation vs BASHT's engine transcription", () => {
  const chat = src("features/chat/chat-screen.tsx");
  it("the composer mic says which one it is (visible tag + accessible name)", () => {
    expect(chat).toMatch(/data-kind="engine"[\s\S]*?يُفرَّغ في محرك باشت[\s\S]*?<span className="mic-kind" aria-hidden="true">باشت<\/span>/);
    expect(chat).toMatch(/data-kind="dictation"[\s\S]*?ليس تفريغ باشت[\s\S]*?<span className="mic-kind" aria-hidden="true">إملاء<\/span>/);
  });
  it("the streaming bubble never shows a MEDIA marker", () => {
    expect(chat).toMatch(/const liveText = live \? stripMediaMarkers\(live\.text, \{ streaming: true \}\) : "";/);
  });
});
