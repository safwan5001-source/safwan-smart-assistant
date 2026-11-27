"use client";
/**
 * «النموذج والقدرات» — model control for the app conversation (M), inside the chat. Shows only what the engine reports:
 * the active model and where it comes from, the model that actually answered (and any fallback), measured latency, context use,
 * the agent's allowed models with their real capabilities, and thinking / fast controls only where the current model offers them.
 */
import Icon from "@/components/icon";
import { Badge, Notice } from "@/components/ui";
import type { BashtModel, BashtModelState } from "@/lib/basht-client";
import { byProvider, capabilities, levelLabel, modelName, reasonLabel, replyModelName, seconds, tokens } from "@/lib/basht-model";
import type { ModelChange } from "./use-basht-model";

type Props = { models: BashtModel[] | null; state: BashtModelState | null; busy: boolean; error: string; onApply: (c: ModelChange) => void; onClose: () => void };

export default function ModelPanel({ models, state, busy, error, onApply, onClose }: Props) {
  const current = state?.model.id ?? null;
  const row = models?.find((m) => m.id === current) ?? null;
  const levels = state?.thinking.levels ?? [];
  const usage = state?.usage;
  const pct = usage?.context_tokens != null && usage.context_window ? Math.min(100, Math.round((usage.context_tokens / usage.context_window) * 100)) : null;
  const last = state?.last_reply;
  const lastName = last ? replyModelName(last.provider, last.model, models) : "";
  const fb = state?.fallback;

  return (
    <div className="sheet-card model-panel" style={{ padding: 12, overflowY: "auto" }}>
      <div className="row"><h2 style={{ flex: 1 }}>النموذج والقدرات</h2><button className="icon-btn" onClick={onClose} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>

      {busy && <small role="status" className="model-busy">جارٍ التطبيق على باشت… يظهر الإعداد هنا بعد أن يؤكده المحرك.</small>}
      {!state ? <small className="muted">جارٍ قراءة إعدادات باشت…</small> : (
        <div className="stack" style={{ gap: 14 }}>
          <section className="card card-pad stack" style={{ gap: 8 }} aria-label="النموذج النشط">
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong className="model-name">{modelName(current, models) || "—"}</strong>
                <small className="muted" dir="ltr" style={{ textAlign: "end" }}>{current}</small>
              </span>
              <Badge tone={state.model.source === "override" ? "accent" : undefined}>{state.model.source === "override" ? "مثبّت لهذه المحادثة" : "افتراضي باشت"}</Badge>
            </div>
            {last && lastName && (
              <small className="muted">آخر رد نفّذه: <bdi>{lastName}</bdi>{state.last_run?.total_ms != null && <> · زمن أول حرف {seconds(state.last_run.first_token_ms)} · الإجمالي {seconds(state.last_run.total_ms)}</>}</small>
            )}
            {fb?.to && (
              <Notice tone="warn" role="status">انتقل باشت إلى نموذج احتياطي في آخر رد: <bdi>{replyModelName(null, fb.from, models)}</bdi> ← <bdi>{replyModelName(null, fb.to, models)}</bdi>{fb.reason ? ` (${reasonLabel(fb.reason)})` : ""}.</Notice>
            )}
            {pct != null && (
              <div className="meter-row">
                <div className="meter-head"><span>سياق المحادثة</span><bdi className="num" dir="ltr">{tokens(usage!.context_tokens)} / {tokens(usage!.context_window)}</bdi></div>
                <div className="meter" role="progressbar" aria-label="استخدام سياق المحادثة" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i data-level={pct >= 90 ? "high" : pct >= 70 ? "mid" : "low"} style={{ inlineSize: pct + "%" }} /></div>
              </div>
            )}
          </section>

          {levels.length > 1 && (
            <section className="stack" style={{ gap: 6 }} aria-labelledby="think-h">
              <strong id="think-h">مستوى التفكير</strong>
              <div className="seg seg-wrap" role="group" aria-labelledby="think-h">
                {levels.map((l) => (
                  <button key={l} aria-pressed={state.thinking.level === l} disabled={busy} onClick={() => onApply({ kind: "thinking", value: l })}>{levelLabel(l)}</button>
                ))}
                <button aria-pressed={state.thinking.level == null} disabled={busy} onClick={() => onApply({ kind: "thinking", value: "default" })}>
                  افتراضي{state.thinking.default ? ` (${levelLabel(state.thinking.default)})` : ""}
                </button>
              </div>
              <small className="muted">كلما ارتفع المستوى زادت دقة الاستدلال وزمن الرد والتكلفة.</small>
            </section>
          )}

          {state.fast.supported && (
            <section className="stack" style={{ gap: 6 }} aria-labelledby="fast-h">
              <strong id="fast-h">السرعة</strong>
              <div className="seg" role="group" aria-labelledby="fast-h">
                <button aria-pressed={state.fast.enabled === false} disabled={busy} onClick={() => onApply({ kind: "fast", value: "off" })}>عادي</button>
                <button aria-pressed={state.fast.enabled === true} disabled={busy} onClick={() => onApply({ kind: "fast", value: "on" })}><Icon name="bolt" size={16} />سريع</button>
              </div>
              <small className="muted">الوضع السريع يستخدم مسار المزوّد الأسرع لهذا النموذج.</small>
            </section>
          )}

          <section className="stack" style={{ gap: 8 }} aria-labelledby="models-h">
            <strong id="models-h">النماذج المتاحة لباشت</strong>
            <div role="radiogroup" aria-labelledby="models-h" className="stack" style={{ gap: 8 }}>
              <button role="radio" aria-checked={state.model.source === "default"} className="model-row" disabled={busy} onClick={() => onApply({ kind: "model", value: "default" })}>
                <span className="stack" style={{ gap: 2 }}><strong>افتراضي باشت</strong><small className="muted">النموذج الأساسي في إعدادات باشت، مع النماذج الاحتياطية.</small></span>
              </button>
              {models === null ? <small className="muted">جارٍ تحميل القائمة…</small> : byProvider(models).map((g) => (
                <div key={g.provider} className="stack" style={{ gap: 6 }}>
                  <small className="muted model-group">{g.provider}</small>
                  {g.rows.map((m) => {
                    const on = state.model.source === "override" && m.id === current;
                    return (
                      <button key={m.id} role="radio" aria-checked={on} className="model-row" disabled={busy || !m.selectable} onClick={() => onApply({ kind: "model", value: m.id })}>
                        <span className="stack" style={{ gap: 4, minWidth: 0 }}>
                          <span className="row" style={{ gap: 6 }}><strong>{m.name}</strong>{m.recommended && <Badge tone="gold">موصى به</Badge>}</span>
                          <span className="model-caps">{capabilities(m).map((c) => <span key={c} className="cap">{c}</span>)}</span>
                          {!m.available && <small style={{ color: "var(--danger)" }}>غير متاح{m.unavailable_reason ? `: ${reasonLabel(m.unavailable_reason)}` : ""}</small>}
                          {m.available && !m.selectable && <small className="muted">لا يُختار يدويًا</small>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          {error && <Notice tone="warn" role="alert">{error}</Notice>}
          <small className="muted">التغيير يخص محادثة التطبيق فقط، ويحتفظ بسياقها وبذاكرة باشت المشتركة. لا يغيّر واتساب ولا إعدادات باشت العامة.
            {row && !row.fast_mode && " الوضع السريع غير مدعوم في هذا النموذج."}</small>
        </div>
      )}
    </div>
  );
}
