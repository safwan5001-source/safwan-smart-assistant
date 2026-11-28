/**
 * Model control (M), display side: turns what the engine reports into short Arabic labels. Nothing here invents a model, a level
 * or a capability — every value shown comes from the engine (models.list / sessions.describe through the bridge).
 */
import type { BashtModel, BashtModelState } from "./basht-client";

/**
 * Every label is unique (a test pins it): two levels that read the same would let the owner pick one thinking it were the other.
 * `max` and `ultra` are two different engine levels, so they are two different words; the stored ids and the API are unchanged.
 */
export const LEVELS: Record<string, string> = {
  off: "بدون تفكير", minimal: "أدنى", low: "منخفض", medium: "متوسط", high: "عالٍ", xhigh: "عالٍ جدًا", max: "أقصى", ultra: "فائق", adaptive: "تكيّفي",
};
/** Arabic label of a thinking level id; an id we do not know is shown as the engine sent it. */
export const levelLabel = (id: string | null | undefined) => (id ? LEVELS[id] ?? id : "");

/** Display order of the levels this app knows: weakest first. An id it does not know keeps the engine's order, after the known ones. */
const LEVEL_RANK = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive"];
export const orderLevels = (levels: readonly string[]): string[] => {
  const rank = (l: string) => { const i = LEVEL_RANK.indexOf(l); return i < 0 ? LEVEL_RANK.length : i; };
  return levels.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
};

export type ThinkingOption = { key: string; label: string; value: string; pressed: boolean; isDefault: boolean };
/**
 * The buttons of the thinking-level control. One button per level, in display order; the engine's default is a BADGE on the level it
 * maps to (clicking it clears the owner's override), never a second button that repeats a level. Only when the default maps to none of
 * the levels offered (or is unknown) is there one extra «الافتراضي» button, which then repeats nothing.
 */
export function thinkingOptions(levels: readonly string[], level: string | null, dflt: string | null): ThinkingOption[] {
  const ordered = orderLevels(Array.from(new Set(levels)));
  const mapped = dflt !== null && ordered.includes(dflt);
  const overridden = level !== null && ordered.includes(level);
  const out: ThinkingOption[] = ordered.map((l) => {
    const isDefault = mapped && l === dflt;
    return { key: l, label: levelLabel(l), value: isDefault ? "default" : l, isDefault, pressed: overridden ? level === l : isDefault };
  });
  if (!mapped) out.push({ key: "default", label: "الافتراضي", value: "default", isDefault: true, pressed: !overridden });
  return out;
}

const REASONS: Record<string, string> = {
  server_error: "خطأ في خادم المزوّد", rate_limit: "تجاوز حدّ الاستخدام", rate_limited: "تجاوز حدّ الاستخدام", timeout: "انتهت المهلة",
  overloaded: "المزوّد مزدحم", auth: "مشكلة في مفتاح المزوّد", billing: "مشكلة في رصيد المزوّد", context_length: "تجاوز طول السياق",
  unavailable: "غير متاح", model_not_found: "النموذج غير موجود لدى المزوّد",
  "missing-auth": "لا يوجد مفتاح للمزوّد", "auth-failed": "فشل التحقق من مفتاح المزوّد", cooldown: "متوقف مؤقتًا بعد أخطاء متكررة",
  "unsupported-runtime": "غير مدعوم في بيئة التشغيل",
};
export const reasonLabel = (r: string | null | undefined) => (r ? REASONS[r] ?? r : "");

/** "anthropic/claude-sonnet-4-5" → the catalog's display name when known, else the part after the provider. */
export function modelName(id: string | null | undefined, models: BashtModel[] | null | undefined): string {
  if (!id) return "";
  const row = models?.find((m) => m.id === id || m.id.endsWith("/" + id));
  if (row) return row.name;
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}
/** The id a reply/fallback names may be bare ("echo2") or full ("mock/echo2"): resolve it against the catalog. */
export function replyModelName(provider: string | null | undefined, model: string | null | undefined, models: BashtModel[] | null | undefined) {
  if (!model) return "";
  const id = provider && !model.includes("/") ? `${provider}/${model}` : model;
  // fast mode runs the provider's fast variant (e.g. grok-3 → grok-3-fast): name it after the catalog model it belongs to
  if (!models?.some((m) => m.id === id) && id.endsWith("-fast")) {
    const base = models?.find((m) => m.id === id.slice(0, -5) && m.fast_mode);
    if (base) return `${base.name} · سريع`;
  }
  return modelName(id, models);
}

export const seconds = (ms: number | null | undefined) =>
  ms == null ? "" : ms < 1000 ? `${Math.max(0.1, Math.round(ms / 100) / 10)} ث` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} ث`;

export function tokens(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Capability badges of a catalog row, only from flags the engine sent. */
export function capabilities(m: BashtModel): string[] {
  const out: string[] = [];
  if (m.reasoning) out.push("تفكير"); // the catalog's own flag: levels alone do not mean the provider reasons
  if (m.fast_mode) out.push("سريع");
  if (m.input.includes("image")) out.push("صور");
  if (m.input.includes("document")) out.push("مستندات");
  if (m.tools) out.push("أدوات");
  if (m.context_window) out.push(`سياق ${tokens(m.context_window)}`);
  return out;
}

/** Models grouped by provider, in the engine's own order (recommended first within a provider). */
export function byProvider(models: BashtModel[]): { provider: string; rows: BashtModel[] }[] {
  const groups = new Map<string, BashtModel[]>();
  for (const m of models) {
    const p = m.provider_name || m.provider || "أخرى";
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }
  return [...groups].map(([provider, rows]) => ({ provider, rows: [...rows].sort((a, b) => Number(b.recommended) - Number(a.recommended)) }));
}

/** One-line summary for the chat header: model · thinking · fast. */
export function summary(state: BashtModelState | null, models: BashtModel[] | null): string {
  if (!state?.model.id) return "";
  const parts = [modelName(state.model.id, models)];
  const eff = state.thinking.effective;
  if (eff && state.thinking.levels.length > 1 && state.thinking.levels.includes(eff)) parts.push(levelLabel(eff)); // only a level this model has
  if (state.fast.enabled && state.fast.supported) parts.push("سريع"); // only where the model really runs fast
  if (state.model.source === "fallback") parts.push("احتياطي");
  return parts.join(" · ");
}

/** True when the last reply came from a different model than the one selected (a fallback really happened). */
export function fellBack(state: BashtModelState | null): boolean {
  return !!state?.fallback?.to;
}

/** The bare/full id a reply names, as one catalog id ("mock" + "echo2" → "mock/echo2"). The gateway's own "openclaw" provider is no model. */
const replyId = (provider: string | null | undefined, model: string | null | undefined): string => {
  if (!model || provider === "openclaw") return "";
  return provider && !model.includes("/") ? `${provider}/${model}` : model;
};
/** Provider prefix and the provider's fast suffix split off: "xai/grok-3-fast" → { p: "xai", name: "grok-3" }; a bare id has p "". */
const splitId = (id: string) => { const i = id.indexOf("/"); const name = (i >= 0 ? id.slice(i + 1) : id).replace(/-fast$/, ""); return { p: i >= 0 ? id.slice(0, i) : "", name }; };
/** The same model (a provider's fast variant of it, or a bare id next to a prefixed one, is not a different model). Two prefixed ids must agree on the provider. */
const sameModel = (a: string, b: string) => { const x = splitId(a), y = splitId(b); return x.name === y.name && (x.p === "" || y.p === "" || x.p === y.p); };

export type HeaderModel = {
  /** Name of the model the owner (or BASHT's default) selected; "" when unknown. */
  selected: string;
  /** Name of the model that executed the LAST reply, as the engine recorded it; "" when it is not known (nothing is then claimed). */
  executed: string;
  /** True only when both are known and they are different models (a fallback really happened). */
  differs: boolean;
  /** Arabic reason of the fallback, only when it differs and the engine gave one. */
  reason: string;
};
/**
 * Chat header: the selected model next to the model that really executed the last reply. `lastMessage` is the newest assistant row of
 * the conversation that carries a model (a fallback when the model state has no `last_reply` yet). Unknown stays unknown.
 */
export function headerModel(state: BashtModelState | null, models: BashtModel[] | null | undefined,
  lastMessage?: { provider?: string | null; model?: string | null; fallback?: { reason?: string | null } | null; at?: number | null } | null): HeaderModel {
  // While the engine says the conversation is on its automatic fallback, `model.id` is the model switched TO; what was selected is `fallback.from`.
  const selectedId = (state?.model.source === "fallback" && state.fallback?.from ? state.fallback.from : state?.model.id) ?? "";
  const lr = state?.last_reply ?? null;
  const lrId = replyId(lr?.provider, lr?.model);
  const msgId = replyId(lastMessage?.provider, lastMessage?.model);
  // the newer of the engine's last_reply and the newest reply row wins (right after a reply the row arrives before the model state reloads)
  const useMsg = !!msgId && (!lrId || (lastMessage?.at != null && lastMessage.at > (lr?.at ?? 0)));
  const executedId = useMsg ? msgId : lrId || replyId(null, state?.fallback?.to) || msgId;
  const selected = selectedId ? modelName(selectedId, models) : "";
  if (!executedId) return { selected, executed: "", differs: false, reason: "" };
  const executed = replyModelName(null, executedId, models);
  const differs = !!selectedId && !sameModel(selectedId, executedId);
  const rawReason = useMsg ? lastMessage?.fallback?.reason ?? null : state?.fallback?.reason ?? lr?.fallback?.reason ?? lastMessage?.fallback?.reason ?? null;
  return { selected, executed, differs, reason: differs ? reasonLabel(rawReason) : "" };
}
