"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { Badge, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { aiReady, useAssistant } from "@/components/assistant-context";
import { AssistantRequestError, assistantService, type ClaudeState } from "@/lib/assistant";
import { ensureClaudeSession } from "@/lib/claude-session";
import { threadsStore } from "@/lib/stores";
import type { Thread } from "@/lib/domain";

type Phase = "checking" | "off" | "locked" | "ready";
type Probe = "idle" | "testing" | "ok" | "fail";
const usd = (n: number) => "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));

function Meter({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
  return (
    <div className="meter-row">
      <div className="meter-head"><span>{label}</span><bdi className="num" dir="ltr">{usd(spent)} / {usd(cap)}</bdi></div>
      <div className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i data-level={pct >= 90 ? "high" : pct >= 70 ? "mid" : "low"} style={{ inlineSize: pct + "%" }} /></div>
    </div>
  );
}

/** Claude management inside the settings screen. It only ever shows configuration state and counters: no key, no account id, no upstream text. */
export default function ClaudeSettings() {
  const { status, refresh } = useAssistant();
  const { prompt, toast, confirm } = useDialogs();
  const selectId = useId();
  const [phase, setPhase] = useState<Phase>("checking");
  const [state, setState] = useState<ClaudeState | null>(null);
  const [probe, setProbe] = useState<Probe>("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const s = await assistantService.sessionStatus();
    if (!s.enabled) { setPhase("off"); setState(null); return; }
    if (!s.authenticated) { setPhase("locked"); setState(null); return; }
    try { setState(await assistantService.state()); setPhase("ready"); }
    catch (e) {
      if (e instanceof AssistantRequestError && e.code === "unauthorized") { setPhase("locked"); return; }
      setPhase("ready"); setState(null); setError(e instanceof Error ? e.message : "تعذر تحميل حالة Claude.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const unlock = async () => {
    setBusy(true);
    try { await ensureClaudeSession(prompt); await load(); } catch (e) { setError(e instanceof Error ? e.message : "تعذر فتح الجلسة."); } finally { setBusy(false); }
  };
  const lock = async () => { await assistantService.lock(); setProbe("idle"); await load(); };
  const test = async () => {
    setProbe("testing");
    try { const r = await assistantService.probe(); setProbe(r.reachable ? "ok" : "fail"); } catch (e) { setProbe("fail"); setError(e instanceof Error ? e.message : ""); }
  };
  const choose = async (model: string) => {
    if (!state || model === state.default_model) return;
    setBusy(true);
    try { await assistantService.setDefaultModel(model); setState({ ...state, default_model: model }); setProbe("idle"); toast("تم حفظ النموذج الافتراضي"); }
    catch (e) { toast(e instanceof Error ? e.message : "تعذر الحفظ", "error"); } finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true);
    try {
      const have = new Set(threadsStore.getSnapshot().map((t) => t.id));
      const missing = (await assistantService.conversations()).filter((c) => !have.has(c.id));
      if (!missing.length) { toast("كل محادثات Claude موجودة على هذا الجهاز"); return; }
      const restored: Thread[] = [];
      for (const c of missing.slice(0, 20)) {
        const full = await assistantService.conversation(c.id);
        const created = Date.parse(full.messages[0]?.created ?? full.updated) || Date.now();
        restored.push({ id: full.id, title: full.title.slice(0, 80) || "محادثة", created, updated: Date.parse(full.updated) || created,
          messages: full.messages.filter((m) => m.content).map((m) => ({ id: m.id, text: m.content, created: Date.parse(m.created) || created, role: m.role })) });
      }
      threadsStore.set((old) => [...restored, ...old]);
      toast(`استُعيدت ${restored.length} محادثة من الخادم`);
    } catch (e) { toast(e instanceof Error ? e.message : "تعذرت الاستعادة", "error"); } finally { setBusy(false); }
  };
  const wipe = async () => {
    if (!(await confirm({ title: "حذف كل محادثات Claude من الخادم؟", message: "تُحذف نسخ المحادثات المحفوظة على الخادم نهائياً (لا تتأثر النسخ المحلية على هذا الجهاز).", confirmLabel: "حذف من الخادم", tone: "danger", requireText: "حذف" }))) return;
    setBusy(true);
    try {
      const all = await assistantService.conversations();
      await Promise.all(all.map((c) => assistantService.removeConversation(c.id)));
      toast(`حُذفت ${all.length} محادثة من الخادم`);
    } catch (e) { toast(e instanceof Error ? e.message : "تعذر الحذف", "error"); } finally { setBusy(false); }
  };

  const configured = aiReady(status);
  const tone = phase === "ready" && configured ? (probe === "fail" ? "warn" : "ok") : undefined;
  const label = phase === "off" ? "غير مفعّل" : phase === "locked" ? "مقفل" : probe === "ok" ? "متصل ✓" : probe === "fail" ? "تعذر الاتصال" : configured ? "مهيأ" : "ينتظر التهيئة";

  return (
    <section className="card card-pad stack" aria-labelledby="claude-h">
      <div className="section-head"><h2 id="claude-h">Claude (Anthropic)</h2><Badge tone={tone}>{label}</Badge></div>
      <p className="muted" style={{ fontSize: 14 }}>المزود الأساسي لمساعد صفوان. المفتاح محفوظ على الخادم فقط ولا يظهر هنا ولا يصل إلى الآيفون.</p>

      {phase === "off" && <Notice tone="warn">بوابة Claude غير مفعّلة على الخادم (AI_CHAT_ACCESS_CODE). تفاصيل التهيئة في docs/CHAT-AI-1.md.</Notice>}
      {phase === "locked" && (
        <div className="stack">
          <Notice>افتح جلسة المالك لإدارة Claude. الرمز لا يُحفظ على الجهاز؛ تبقى الجلسة 8 ساعات.</Notice>
          <button className="btn btn-primary" onClick={() => void unlock()} disabled={busy} style={{ justifySelf: "start", minHeight: 44 }}>فتح جلسة Claude</button>
        </div>
      )}
      {error && <Notice tone="warn" role="alert">{error}</Notice>}

      {phase === "ready" && state && (
        <>
          <div className="stack">
            <label htmlFor={selectId}><strong>النموذج الافتراضي</strong></label>
            <select id={selectId} className="input select-lg" value={state.default_model ?? ""} disabled={busy} onChange={(e) => void choose(e.target.value)}>
              {state.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <small className="muted">يُستخدم في المحادثات الجديدة والقادمة. القائمة والأسعار تحددها إعدادات الخادم.</small>
          </div>

          <div className="stack">
            <strong>التكلفة وحدود الاستخدام</strong>
            <Meter label="اليوم (UTC)" spent={state.usage.day.spent_usd} cap={state.limits.daily_usd} />
            <Meter label="هذا الشهر (UTC)" spent={state.usage.month.spent_usd} cap={state.limits.monthly_usd} />
            <small className="muted">الحدّان إلزاميان على الخادم: عند بلوغهما يُرفض الطلب قبل الاتصال بـClaude. الحد الأقصى <bdi className="num">{state.limits.per_minute}</bdi> طلبًا في الدقيقة · طلبات اليوم <bdi className="num">{state.usage.day.requests}</bdi>.</small>
          </div>

          <div className="status-line">
            <span><strong>حالة الاتصال</strong><small>{probe === "ok" ? "نجح فحص المفتاح والنموذج لدى Anthropic" : probe === "fail" ? "فشل الفحص: راجع المفتاح أو النموذج أو الشبكة على الخادم" : probe === "testing" ? "جارٍ الفحص…" : "لم يُفحص بعد في هذه الجلسة (الفحص مجاني)"}</small></span>
            <button className="btn btn-sm" onClick={() => void test()} disabled={probe === "testing"} style={{ minHeight: 44 }}>اختبار الاتصال</button>
          </div>

          <div className="row-wrap">
            <button className="btn" onClick={() => void restore()} disabled={busy} style={{ minHeight: 44 }}>استعادة المحادثات من الخادم</button>
            <button className="btn" onClick={() => void wipe()} disabled={busy} style={{ minHeight: 44 }}>حذف نسخ الخادم</button>
            <button className="btn" onClick={() => void lock()} style={{ minHeight: 44 }}>قفل الجلسة</button>
          </div>
        </>
      )}
      {phase !== "off" && <button className="btn btn-sm" onClick={() => { void load(); refresh(); }} style={{ justifySelf: "start", minHeight: 44 }}>تحديث</button>}
    </section>
  );
}
