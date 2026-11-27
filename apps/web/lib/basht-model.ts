/**
 * Model control (M), display side: turns what the engine reports into short Arabic labels. Nothing here invents a model, a level
 * or a capability — every value shown comes from the engine (models.list / sessions.describe through the bridge).
 */
import type { BashtModel, BashtModelState } from "./basht-client";

const LEVELS: Record<string, string> = {
  off: "بدون تفكير", minimal: "أدنى", low: "منخفض", medium: "متوسط", high: "عالٍ", xhigh: "عالٍ جدًا", max: "أقصى", ultra: "أقصى", adaptive: "تكيّفي",
};
/** Arabic label of a thinking level id; an id we do not know is shown as the engine sent it. */
export const levelLabel = (id: string | null | undefined) => (id ? LEVELS[id] ?? id : "");

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
