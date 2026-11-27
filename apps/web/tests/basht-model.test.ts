import { describe, expect, it } from "vitest";
import type { BashtModel, BashtModelState } from "@/lib/basht-client";
import { byProvider, capabilities, fellBack, levelLabel, modelName, reasonLabel, replyModelName, seconds, summary, tokens } from "@/lib/basht-model";

const row = (over: Partial<BashtModel>): BashtModel => ({ id: "mock/echo", name: "Echo", provider: "mock", provider_name: null, available: true, unavailable_reason: null,
  unavailable_until: null, context_window: null, reasoning: false, thinking_levels: [], thinking_default: null, fast_mode: false, tools: null, input: ["text"],
  recommended: false, selectable: true, ...over });
const state = (over: Partial<BashtModelState> = {}): BashtModelState => ({
  model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", source: "default" },
  thinking: { level: null, default: "medium", effective: "medium", levels: ["off", "low", "medium", "high"] },
  fast: { supported: false, enabled: false }, usage: { input_tokens: null, output_tokens: null, context_tokens: null, context_window: null },
  last_reply: null, fallback: null, last_run: null, ...over });

describe("model display helpers (M)", () => {
  const models = [row({ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, context_window: 200_000, input: ["text", "image"], tools: true }),
    row({ id: "mock/echo2", name: "Echo 2", recommended: true }), row({ id: "xai/grok-3", name: "Grok 3", provider: "xai", fast_mode: true })];
  it("names come from the catalog, else the id without its provider", () => {
    expect(modelName("anthropic/claude-sonnet-4-5", models)).toBe("Claude Sonnet 4.5");
    expect(modelName("other/thing", models)).toBe("thing");
    expect(replyModelName("mock", "echo2", models)).toBe("Echo 2"); // replies carry a bare model id plus its provider
    expect(replyModelName(null, "mock/echo2", models)).toBe("Echo 2");
    expect(replyModelName("xai", "grok-3-fast", models)).toBe("Grok 3 · سريع"); // the provider's fast variant of a catalog model
    expect(replyModelName("mock", "echo2-fast", models)).toBe("echo2-fast"); // no fast-mode base: shown as recorded
  });
  it("capability badges only reflect flags the engine sent", () => {
    expect(capabilities(models[0])).toEqual(["تفكير", "صور", "أدوات", "سياق 200K"]);
    expect(capabilities(models[1])).toEqual([]);
    expect(capabilities(models[2])).toEqual(["سريع"]);
    expect(capabilities(row({ thinking_levels: ["off", "ultra"], reasoning: false }))).toEqual([]); // levels alone ≠ reasoning (lab finding)
  });
  it("groups by provider with recommended first", () => {
    const g = byProvider([row({ id: "mock/a", name: "A" }), ...models]);
    expect(g.map((x) => x.provider)).toEqual(["mock", "anthropic", "xai"]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["mock/echo2", "mock/a"]);
  });
  it("labels and numbers", () => {
    expect(levelLabel("high")).toBe("عالٍ"); expect(levelLabel("weird")).toBe("weird");
    expect(seconds(812)).toBe("0.8 ث"); expect(seconds(2400)).toBe("2.4 ث"); expect(seconds(86722)).toBe("87 ث"); expect(seconds(null)).toBe("");
    expect(tokens(1500)).toBe("2K"); expect(tokens(1_000_000)).toBe("1M"); expect(tokens(950)).toBe("950");
  });
  it("header summary: model · thinking · fast; fallback is reported only when it happened", () => {
    expect(summary(state(), models)).toBe("Claude Sonnet 4.5 · متوسط");
    expect(summary(state({ fast: { supported: true, enabled: true }, thinking: { level: null, default: null, effective: null, levels: [] } }), models)).toBe("Claude Sonnet 4.5 · سريع");
    expect(summary(null, models)).toBe("");
    // lab findings: a level the model does not offer, or fast on a model without it, is never shown as if it applied
    expect(summary(state({ thinking: { level: "low", default: null, effective: "low", levels: ["off", "ultra"] } }), models)).toBe("Claude Sonnet 4.5");
    expect(summary(state({ fast: { supported: false, enabled: true } }), models)).toBe("Claude Sonnet 4.5 · متوسط");
    expect(summary(state({ model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", source: "fallback" } }), models)).toBe("Claude Sonnet 4.5 · متوسط · احتياطي");
    expect(fellBack(state())).toBe(false);
    expect(fellBack(state({ fallback: { from: "mock/echo", to: "mock/echo2", reason: "server_error" } }))).toBe(true);
  });
  it("catalog unavailable reasons have Arabic labels", () => {
    for (const r of ["missing-auth", "auth-failed", "cooldown", "unsupported-runtime"]) expect(reasonLabel(r), r).not.toBe(r);
  });
});
