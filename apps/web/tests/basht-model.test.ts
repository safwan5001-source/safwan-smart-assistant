import { describe, expect, it } from "vitest";
import type { BashtModel, BashtModelState } from "@/lib/basht-client";
import { LEVELS, byProvider, capabilities, fellBack, headerModel, levelLabel, modelName, orderLevels, reasonLabel, replyModelName, seconds, summary, thinkingOptions, tokens } from "@/lib/basht-model";

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

describe("effort labels (R14): every level reads differently", () => {
  const ALL = Object.keys(LEVELS);
  it("no two effort levels share a label, and the old duplicate (max / ultra both «أقصى») is gone", () => {
    const labels = ALL.map((l) => levelLabel(l));
    expect(new Set(labels).size).toBe(ALL.length);
    expect(levelLabel("max")).not.toBe(levelLabel("ultra"));
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
  });
  it("the stored ids are unchanged (labels only)", () => {
    expect(ALL).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive"]);
  });
  it("an unknown id is shown as the engine sent it, and never collides with a known label", () => {
    expect(levelLabel("turbo")).toBe("turbo");
    expect(ALL.map(levelLabel)).not.toContain("turbo");
    expect(levelLabel(null)).toBe("");
  });
  it("display order is weakest first, unknown ids keep the engine's order after the known ones", () => {
    expect(orderLevels(["ultra", "off", "high", "low", "max", "medium", "xhigh", "minimal", "adaptive"])).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive"]);
    expect(orderLevels(["zeta", "high", "alpha", "low"])).toEqual(["low", "high", "zeta", "alpha"]);
  });
  it("buttons: one per level; the default is a BADGE on the level it maps to (clicking it clears the override), never a repeated option", () => {
    const o = thinkingOptions(["off", "low", "medium", "high"], null, "high");
    expect(o.map((x) => x.label)).toEqual(["بدون تفكير", "منخفض", "متوسط", "عالٍ"]);
    expect(o.filter((x) => x.isDefault).map((x) => x.key)).toEqual(["high"]);
    expect(o.find((x) => x.key === "high")).toMatchObject({ value: "default", pressed: true });
    expect(o.find((x) => x.key === "low")).toMatchObject({ value: "low", pressed: false });
  });
  it("an owner override presses its own level, not the default's", () => {
    const o = thinkingOptions(["off", "low", "high"], "low", "high");
    expect(o.filter((x) => x.pressed).map((x) => x.key)).toEqual(["low"]);
  });
  it("a default that maps to no offered level (or is unknown) gets one extra «الافتراضي» button, which repeats no level", () => {
    for (const dflt of [null, "xhigh"]) {
      const o = thinkingOptions(["off", "low", "high"], null, dflt);
      expect(o.map((x) => x.key)).toEqual(["off", "low", "high", "default"]);
      expect(o[3]).toMatchObject({ label: "الافتراضي", value: "default", pressed: true });
    }
  });
  it("a stale override (a level this model does not offer) reads as the default, as before", () => {
    const o = thinkingOptions(["off", "low", "high"], "ultra", "low");
    expect(o.filter((x) => x.pressed).map((x) => x.key)).toEqual(["low"]);
  });
  it("labels stay unique for EVERY combination of offered levels and defaults (max/ultra together, default on either, duplicates in the engine list)", () => {
    for (const dflt of [null, ...ALL, "mystery"]) for (const lv of [null, ...ALL]) {
      const o = thinkingOptions([...ALL, ...ALL.slice(0, 3)], lv, dflt);
      expect(new Set(o.map((x) => x.label)).size, `${dflt}/${lv}`).toBe(o.length);
      expect(o.filter((x) => x.pressed).length, `${dflt}/${lv}`).toBe(1);
    }
    const two = thinkingOptions(["max", "ultra"], null, "max");
    expect(two.map((x) => x.label)).toEqual(["أقصى", "فائق"]);
  });
});

describe("chat header: selected vs executed model (B04)", () => {
  const models = [row({ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" }), row({ id: "openai/gpt-x", name: "GPT X", provider: "openai" }),
    row({ id: "xai/grok-3", name: "Grok 3", provider: "xai", fast_mode: true })];
  const st = (over: Partial<BashtModelState> = {}) => state({ model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", source: "override" }, ...over });
  it("the executed model equal to the selected one: both named, no difference claimed", () => {
    const h = headerModel(st({ last_reply: { provider: "anthropic", model: "claude-sonnet-4-5", at: 1 } }), models);
    expect(h).toEqual({ selected: "Claude Sonnet 4.5", executed: "Claude Sonnet 4.5", differs: false, reason: "" });
  });
  it("a different executed model is flagged, with the reason's Arabic label when the engine gave one", () => {
    const h = headerModel(st({ last_reply: { provider: "openai", model: "gpt-x", at: 1 }, fallback: { from: "anthropic/claude-sonnet-4-5", to: "openai/gpt-x", reason: "rate_limit" } }), models);
    expect(h).toEqual({ selected: "Claude Sonnet 4.5", executed: "GPT X", differs: true, reason: "تجاوز حدّ الاستخدام" });
  });
  it("different with no reason: flagged, reason empty (nothing invented)", () => {
    const h = headerModel(st({ last_reply: { provider: "openai", model: "gpt-x", at: 1 } }), models);
    expect(h).toMatchObject({ differs: true, reason: "", executed: "GPT X" });
  });
  it("an unknown reason token is shown as sent, never dropped into a made-up one", () => {
    expect(headerModel(st({ last_reply: { provider: "openai", model: "gpt-x", at: 1, fallback: { from: null, to: null, reason: "weird_code" } } }), models).reason).toBe("weird_code");
  });
  it("executed unknown: only the selected model, no claim, no difference", () => {
    for (const s of [st(), st({ last_reply: null }), st({ last_reply: { provider: null, model: null, at: null } })]) {
      expect(headerModel(s, models)).toEqual({ selected: "Claude Sonnet 4.5", executed: "", differs: false, reason: "" });
    }
    expect(headerModel(null, null)).toEqual({ selected: "", executed: "", differs: false, reason: "" });
  });
  it("the gateway's own «openclaw» rows are not a model", () => {
    expect(headerModel(st(), models, { provider: "openclaw", model: "gateway-notice" }).executed).toBe("");
  });
  it("falls back to the newest assistant row when the model state has no last reply yet", () => {
    expect(headerModel(st(), models, { provider: "openai", model: "gpt-x" })).toMatchObject({ executed: "GPT X", differs: true });
    expect(headerModel(st(), models, { provider: "anthropic", model: "claude-sonnet-4-5" })).toMatchObject({ executed: "Claude Sonnet 4.5", differs: false });
    // the engine's own last_reply wins over an older row
    expect(headerModel(st({ last_reply: { provider: "anthropic", model: "claude-sonnet-4-5", at: 2 } }), models, { provider: "openai", model: "gpt-x" }).differs).toBe(false);
  });
  it("a provider's fast variant of the selected model is the same model running fast, not a fallback", () => {
    const s = st({ model: { id: "xai/grok-3", provider: "xai", source: "override" }, last_reply: { provider: "xai", model: "grok-3-fast", at: 1 } });
    expect(headerModel(s, models)).toMatchObject({ executed: "Grok 3 · سريع", differs: false });
  });
  it("a bare model id with its provider and a full id name the same model", () => {
    expect(headerModel(st({ last_reply: { provider: null, model: "anthropic/claude-sonnet-4-5", at: 1 } }), models).differs).toBe(false);
  });
  it("no selected model known but an executed one: the executed one is shown and nothing is called different", () => {
    expect(headerModel(null, models, { provider: "openai", model: "gpt-x" })).toEqual({ selected: "", executed: "GPT X", differs: false, reason: "" });
  });
});
