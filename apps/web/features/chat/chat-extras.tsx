"use client";
/** B1 chat basics, as small pieces the conversation screen places: reset divider, tool steps, earlier/latest controls, retry, search. */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import { bashtClient, BashtError, type BashtHit, type BashtStep } from "@/lib/basht-client";
import { formatTime } from "@/lib/format";
import { toolLabel } from "@/lib/tool-labels";
import "./chat-media.css";

/** «محادثة جديدة» in the timeline: where the engine started a fresh context. Everything above stays readable. */
export function ResetDivider({ at }: { at: number }) {
  return (
    <div className="reset-divider" role="separator" aria-label="محادثة جديدة">
      <span><Icon name="spark" size={14} />محادثة جديدة{at > 0 ? <> · <time className="num" dateTime={new Date(at).toISOString()}>{formatTime(at)}</time></> : null}</span>
    </div>
  );
}

/** «يستخدم أداة: …» lines under the live reply (tool names only; the engine never sends their arguments here). */
export function RunSteps({ steps }: { steps: BashtStep[] | undefined }) {
  if (!steps?.length) return null;
  return (
    <ul className="run-steps" aria-label="ما يفعله باشت الآن">
      {steps.map((s, i) => (
        <li key={i} className={s.done ? "done" : "active"}>
          {s.done ? <Icon name="check" size={13} /> : <span className="spinner" aria-hidden="true" />}
          {s.done ? "استخدم أداة: " : "يستخدم أداة: "}<bdi>{toolLabel(s.tool)}</bdi>
        </li>
      ))}
    </ul>
  );
}

export function EarlierButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <div className="earlier-row">
      <button type="button" className="btn btn-sm" onClick={onClick} disabled={busy} aria-busy={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="clock" size={16} />}عرض الرسائل السابقة
      </button>
    </div>
  );
}

export function WindowBanner({ onBack }: { onBack: () => void }) {
  return (
    <div className="window-banner" role="status">
      <span>تعرض رسائل أقدم من نتيجة بحث.</span>
      <button type="button" className="btn-link" onClick={onBack}>العودة إلى الأحدث</button>
    </div>
  );
}

export function RetryBar({ text, images, onRetry, disabled }: { text: string; images: number; onRetry: () => void; disabled: boolean }) {
  return (
    <div className="retry-bar" role="group" aria-label="إعادة المحاولة">
      <small className="muted">لم يكتمل الرد على: <bdi>«{text.length > 60 ? text.slice(0, 60) + "…" : text || "صورة"}»</bdi>{images ? ` · ${images} صورة` : ""}</small>
      <button type="button" className="btn btn-sm" onClick={onRetry} disabled={disabled}><Icon name="repeat" size={16} />إعادة المحاولة</button>
    </div>
  );
}

/**
 * The chat's existing search box also searches BASHT's own conversations (the owner's readable ones), through the engine's
 * search. Runs once the owner pauses typing (2+ characters); results open the conversation at that message.
 */
export function BashtSearchResults({ query, enabled, onPick }: { query: string; enabled: boolean; onPick: (hit: BashtHit) => void }) {
  const [hits, setHits] = useState<BashtHit[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const gen = useRef(0);
  const q = query.trim();
  useEffect(() => {
    if (!enabled || q.length < 2) { setHits(null); setState("idle"); return; }
    const mine = ++gen.current;
    const t = setTimeout(() => {
      setState("loading");
      bashtClient.search(q).then((r) => { if (mine === gen.current) { setHits(r); setState("idle"); } },
        (e: unknown) => { if (mine === gen.current) { setHits(null); setState(e instanceof BashtError && e.code === "rate_limited" ? "error" : "error"); } });
    }, 700);
    return () => clearTimeout(t);
  }, [q, enabled]);
  if (!enabled || q.length < 2) return null;
  return (
    <section className="basht-search" aria-label="نتائج البحث في محادثات باشت">
      <h2 className="muted">في محادثات باشت</h2>
      {state === "loading" && <p className="muted"><span className="spinner" aria-hidden="true" /> يبحث…</p>}
      {state === "error" && <p className="muted">تعذّر البحث في محادثات باشت الآن.</p>}
      {state === "idle" && hits && !hits.length && <p className="muted">لا نتائج في محادثات باشت.</p>}
      {hits && hits.length > 0 && (
        <ul className="threads">
          {hits.map((h) => (
            <li key={h.key + h.message_id} className="thread-item">
              <button className="thread-open" onClick={() => onPick(h)}>
                <strong>{h.snippet}</strong>
                <small className="num">{h.label} · {h.role === "assistant" ? "باشت" : "أنت"}{h.at ? " · " + formatTime(h.at) : ""}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
