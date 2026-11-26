"use client";
/**
 * BASHT HQ — المقر التنفيذي الذكي.
 * A visual, explorable headquarters driven by a LOCAL SIMULATION. Nothing on this screen is connected to BASHT/OpenClaw, the
 * API or the owner's real tasks; every status, number and approval is labelled «محاكاة». The 3D view is loaded on demand.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon, { type IconName } from "@/components/icon";
import { Badge } from "@/components/ui";
import { AGENTS, ROSTER, type AgentId } from "@/lib/hq/roster";
import { FRAMES, VIEWS, type ViewId } from "@/lib/hq/layout";
import { SCENARIOS, SCENARIO_BY_ID } from "@/lib/hq/demo-data";
import { HqSim, STAGE_AR, STATUS_AR, type Snapshot, type Status } from "@/lib/hq/sim";
import { normalizeAr } from "@/lib/search";
import { createHqStore, useHq, type HqStore, type Panel } from "./hq-state";
import HqPlan from "./hq-plan";

const HqCanvas = dynamic(() => import("./scene/hq-canvas"), {
  ssr: false,
  loading: () => <div className="hq-loading" role="status"><span className="hq-spinner" aria-hidden="true" />جارٍ تحميل المقر ثلاثي الأبعاد…</div>,
});

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

const STATUS_TONE: Record<Status, "ok" | "warn" | "info" | "accent" | "gold" | undefined> = {
  available: undefined, working: "accent", walking: "info", meeting: "info", awaiting: "warn", done: "ok",
};

function SimTag() {
  return <span className="hq-sim-tag" title="بيانات تجريبية داخل المحاكاة فقط">محاكاة</span>;
}

export default function HqScreen() {
  const [sim] = useState(() => new HqSim(7));
  const [store] = useState(() => createHqStore());
  const ui = useHq(store, (s) => s);
  const [snap, setSnap] = useState<Snapshot>(() => sim.snapshot());
  const [gl, setGl] = useState<boolean | null>(null);
  const [glLost, setGlLost] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { store.hydrate(); setGl(webglAvailable()); }, [store]);

  // Simulation clock: real time, paused when the user pauses motion or the page is hidden.
  useEffect(() => {
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      if (!store.get().paused && !document.hidden) sim.step(Math.min(dt, 0.25));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim, store]);
  // Lists refresh at 4 Hz, only when something they show changed.
  useEffect(() => {
    let rev = -1;
    const id = window.setInterval(() => { if (sim.revision !== rev) { rev = sim.revision; setSnap(sim.snapshot()); } }, 250);
    return () => window.clearInterval(id);
  }, [sim]);
  // Esc leaves the immersive view.
  useEffect(() => {
    if (!ui.immersive) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") store.set({ immersive: false }); };
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("hq-immersive-on");
    return () => { window.removeEventListener("keydown", onKey); document.documentElement.classList.remove("hq-immersive-on"); };
  }, [ui.immersive, store]);

  const select = (id: AgentId | null) => store.set({ selected: id, ...(id ? { panel: "people" as Panel } : {}) });
  const scenario = SCENARIO_BY_ID[ui.scenario];
  const counts = useMemo(() => {
    const v = Object.values(snap.statuses);
    return { working: v.filter((s) => s === "working").length, meeting: v.filter((s) => s === "meeting" || s === "walking").length, awaiting: v.filter((s) => s === "awaiting").length };
  }, [snap]);
  const use3d = ui.mode === "3d" && gl === true && !glLost;

  return (
    <div className="page hq-page">
      <header className="hq-head">
        <span className="hq-head-icon" aria-hidden="true"><Icon name="hq" size={22} /></span>
        <div className="grow">
          <h1>المقر التنفيذي الذكي</h1>
          <p className="muted">باشت وفريقه من 14 شخصية افتراضية، لكل إدارة مكتبها</p>
        </div>
        <Badge tone="warn"><Icon name="info" size={13} />محاكاة تجريبية</Badge>
      </header>


      <div ref={rootRef} className={"hq-stage" + (ui.immersive ? " immersive" : "")}>
        <div className="hq-viewport" data-mode={use3d ? "3d" : "plan"}>
          {gl === null ? <div className="hq-loading" role="status"><span className="hq-spinner" aria-hidden="true" />تهيئة العرض…</div>
            : use3d ? <HqCanvas sim={sim} store={store} onContextLost={() => setGlLost(true)} />
            : <div className="hq-plan-wrap"><HqPlan sim={sim} selected={ui.selected} onSelect={(id) => select(id)} paused={ui.paused} /></div>}
          {(gl === false || glLost) && ui.mode === "3d" && (
            <p className="hq-fallback-note" role="status">
              {glLost ? "توقف العرض ثلاثي الأبعاد (نفدت ذاكرة الرسوميات). نعرض المخطط بدلًا منه." : "هذا المتصفح لا يدعم العرض ثلاثي الأبعاد؛ نعرض مخطط المقر."}
              {glLost && <button className="btn-link" onClick={() => setGlLost(false)}>إعادة المحاولة</button>}
            </p>
          )}
          <Toolbar store={store} has3d={gl === true && !glLost} />
          <nav className="hq-views" aria-label="الانتقال داخل المقر">
            {(Object.keys(VIEWS) as ViewId[]).map((v) => (
              <button key={v} type="button" className={"chip" + (ui.view === v && !ui.selected ? " on" : "")} aria-pressed={ui.view === v && !ui.selected}
                onClick={() => store.set({ view: v, viewNonce: ui.viewNonce + 1, selected: null })}>{VIEWS[v].label}</button>
            ))}
          </nav>
        </div>
      </div>

      <p className="hq-disclaimer" role="note">
        الشخصيات هنا تعريفات بصرية وليست وكلاء فعليين. المقر لا يتصل بباشت ولا بأي نظام، ولا يقرأ مهامك أو ملفاتك ولا يغيّرها. كل الحالات والأرقام والموافقات تجريبية.
      </p>

      <section className="hq-kpis" aria-label="مؤشرات المحاكاة">
        <Kpi icon="user" label="الشخصيات" value={14} />
        <Kpi icon="activity" label="يعملون" value={counts.working} sim />
        <Kpi icon="calendar" label="ينتقلون / في اجتماع" value={counts.meeting} sim />
        <Kpi icon="hourglass" label="بانتظار الاعتماد" value={counts.awaiting} sim />
        <Kpi icon="check-circle" label="اعتمادات تجريبية" value={snap.approvedCount} sim />
      </section>

      <section className="card hq-sim-bar" aria-label="التحكم بالمحاكاة">
        <div className="hq-sim-row">
          <label className="grow hq-field"><span className="sr-only">السيناريو</span>
            <select value={ui.scenario} onChange={(e) => store.set({ scenario: e.target.value as typeof ui.scenario })} disabled={snap.stage !== "idle" && snap.stage !== "approved"}>
              {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => { if (sim.start(ui.scenario)) store.set({ panel: "tasks", paused: false }); }} disabled={snap.stage !== "idle" && snap.stage !== "approved"}>
            <Icon name="play" size={16} />بدء المحاكاة
          </button>
          <button className="btn btn-sm" onClick={() => sim.reset()} disabled={snap.stage === "idle"}><Icon name="repeat" size={16} />إعادة ضبط</button>
        </div>
        <p className="hq-stage-line" role="status"><SimTag /> {STAGE_AR[snap.stage]}{snap.scenario ? ` — ${SCENARIO_BY_ID[snap.scenario].goal}` : ""}</p>
      </section>

      {ui.selected && <AgentCard id={ui.selected} status={snap.statuses[ui.selected]} onClose={() => select(null)} onVisit={() => store.set({ viewNonce: ui.viewNonce + 1 })} />}

      <section className="card hq-panels">
        <div className="hq-tabs" role="tablist" aria-label="أقسام المقر">
          {([["people", "الموظفون"], ["tasks", "المهام"], ["approvals", "الموافقات"], ["reports", "التقارير"], ["log", "السجل"]] as [Panel, string][]).map(([id, label]) => (
            <button key={id} role="tab" id={"hq-tab-" + id} aria-selected={ui.panel === id} aria-controls={"hq-panel-" + id} className={ui.panel === id ? "on" : ""} onClick={() => store.set({ panel: id })}>
              {label}{id === "approvals" && snap.stage === "awaiting" && <span className="hq-dot" aria-label="بند بانتظارك" />}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={"hq-panel-" + ui.panel} aria-labelledby={"hq-tab-" + ui.panel} className="hq-panel-body">
          {ui.panel === "people" && <People store={store} snap={snap} onSelect={(id) => { select(id); store.set({ viewNonce: ui.viewNonce + 1 }); }} />}
          {ui.panel === "tasks" && (
            snap.scenario ? (
              <ul className="hq-list">
                {SCENARIO_BY_ID[snap.scenario].tasks.map((t) => (
                  <li key={t.agent + t.title}><span className="grow"><strong>{t.title}</strong><small className="muted">{AGENTS[t.agent].nameAr} · {AGENTS[t.agent].role}</small></span>
                    <Badge tone={STATUS_TONE[snap.statuses[t.agent]]}>{STATUS_AR[snap.statuses[t.agent]]}</Badge></li>
                ))}
              </ul>
            ) : <p className="muted hq-empty">لا مهام في المحاكاة الآن. اختر سيناريو واضغط «بدء المحاكاة»: يوزّع باشت المهام، ثم يجتمع الفريق ويرفع النتيجة لاعتمادك.</p>
          )}
          {ui.panel === "approvals" && (
            snap.stage === "awaiting" && snap.scenario ? (
              <div className="hq-approval">
                <strong>{SCENARIO_BY_ID[snap.scenario].approval.title}</strong>
                <small className="muted">{SCENARIO_BY_ID[snap.scenario].approval.impact}</small>
                <button className="btn btn-primary btn-sm" onClick={() => { if (sim.approve()) store.set({ panel: "reports" }); }}><Icon name="check" size={16} />اعتماد تجريبي</button>
                <small className="muted">الاعتماد هنا لا يرسل شيئًا ولا ينفّذ أي إجراء؛ ينهي المحاكاة فقط.</small>
              </div>
            ) : <p className="muted hq-empty">لا شيء بانتظار اعتمادك في المحاكاة.</p>
          )}
          {ui.panel === "reports" && (
            snap.approvedCount > 0 || snap.stage === "approved" ? (
              <div className="hq-report">
                <strong>{(snap.scenario ? SCENARIO_BY_ID[snap.scenario] : scenario).report.title}</strong>
                <ul>{(snap.scenario ? SCENARIO_BY_ID[snap.scenario] : scenario).report.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                <small className="muted">تقرير توضيحي من المحاكاة؛ لا يستند إلى بيانات حقيقية.</small>
              </div>
            ) : <p className="muted hq-empty">تظهر التقارير التجريبية هنا بعد اعتماد نتيجة محاكاة.</p>
          )}
          {ui.panel === "log" && (
            snap.events.length ? (
              <ol className="hq-log">
                {snap.events.map((e, i) => <li key={snap.events.length - i}><span className="num muted">{fmtSimTime(e.t)}</span><span className="grow">{e.text}</span></li>)}
              </ol>
            ) : <p className="muted hq-empty">لا أحداث بعد.</p>
          )}
        </div>
      </section>
    </div>
  );
}

const fmtSimTime = (t: number) => { const s = Math.floor(t); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function Kpi({ icon, label, value, sim }: { icon: IconName; label: string; value: number; sim?: boolean }) {
  return <div className="hq-kpi"><span className="ico" aria-hidden="true"><Icon name={icon} size={16} /></span><span className="grow"><small>{label}{sim && <> · <SimTag /></>}</small><strong className="num">{value}</strong></span></div>;
}

function Toolbar({ store, has3d }: { store: HqStore; has3d: boolean }) {
  const ui = useHq(store, (s) => s);
  const btn = (icon: IconName, label: string, on: boolean, onClick: () => void, hidden = false): ReactNode =>
    hidden ? null : <button type="button" className={"hq-tool" + (on ? " on" : "")} aria-pressed={on} aria-label={label} title={label} onClick={onClick}><Icon name={icon} size={19} /></button>;
  return (
    <div className="hq-toolbar" role="toolbar" aria-label="أدوات العرض">
      {btn(ui.mode === "3d" ? "sheet" : "hq", ui.mode === "3d" ? "عرض المخطط" : "عرض ثلاثي الأبعاد", false, () => store.set({ mode: ui.mode === "3d" ? "plan" : "3d" }), !has3d)}
      {btn("user", ui.labels ? "إخفاء الأسماء" : "إظهار الأسماء", ui.labels, () => store.set({ labels: !ui.labels }))}
      {btn(ui.night ? "moon" : "sun", ui.night ? "الوضع النهاري" : "الوضع الليلي", ui.night, () => store.set({ night: !ui.night }), ui.mode !== "3d")}
      {btn(ui.paused ? "play" : "pause", ui.paused ? "استئناف الحركة" : "إيقاف الحركة", ui.paused, () => store.set({ paused: !ui.paused }))}
      {btn(ui.immersive ? "close" : "target", ui.immersive ? "إغلاق ملء الشاشة" : "ملء الشاشة", ui.immersive, () => store.set({ immersive: !ui.immersive }))}
      {btn("bolt", ui.quality === "low" ? "جودة عادية (موفّر للطاقة)" : "وضع توفير الطاقة", ui.quality === "low", () => store.set({ quality: ui.quality === "low" ? "auto" : "low" }), ui.mode !== "3d")}
    </div>
  );
}

function People({ store, snap, onSelect }: { store: HqStore; snap: Snapshot; onSelect: (id: AgentId) => void }) {
  const ui = useHq(store, (s) => s);
  const q = normalizeAr(ui.query.trim());
  const list = ROSTER.filter((a) => !q || normalizeAr(`${a.nameAr} ${a.role} ${a.id}`).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="hq-search"><Icon name="search" size={17} /><span className="sr-only">بحث في دليل الموظفين</span>
        <input type="search" value={ui.query} onChange={(e) => store.set({ query: e.target.value })} placeholder="ابحث بالاسم أو الاختصاص" enterKeyHint="search" />
      </label>
      {list.length ? (
        <ul className="hq-list" aria-label="دليل الموظفين">
          {list.map((a) => (
            <li key={a.id}>
              <button type="button" className={"hq-person" + (ui.selected === a.id ? " on" : "")} aria-pressed={ui.selected === a.id} onClick={() => onSelect(a.id)}>
                <span className={"hq-avatar" + (a.id === "BASHT" ? " exec" : "")} style={{ ["--tint" as string]: a.tint }} aria-hidden="true">{a.nameAr.slice(0, 1)}</span>
                <span className="grow"><strong className={a.id === "BASHT" ? "gold-name" : ""}>{a.nameAr}</strong><small className="muted">{a.role}</small></span>
                <Badge tone={STATUS_TONE[snap.statuses[a.id]]}>{STATUS_AR[snap.statuses[a.id]]}</Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted hq-empty">لا نتائج لـ «{ui.query}».</p>}
    </div>
  );
}

function AgentCard({ id, status, onClose, onVisit }: { id: AgentId; status: Status; onClose: () => void; onVisit: () => void }) {
  const a = AGENTS[id];
  const f = FRAMES[id];
  return (
    <section className="card hq-agent-card" aria-labelledby="hq-agent-name" style={{ ["--tint" as string]: a.tint }}>
      <div className="hq-agent-top">
        <span className={"hq-avatar lg" + (id === "BASHT" ? " exec" : "")} aria-hidden="true">{a.nameAr.slice(0, 1)}</span>
        <div className="grow">
          <h2 id="hq-agent-name" className={id === "BASHT" ? "gold-name" : ""}>{a.nameAr} <small className="muted mono">{a.id}</small></h2>
          <p className="muted">{a.role}{f.office.exec ? " · الجناح التنفيذي" : ""}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="إغلاق البطاقة"><Icon name="close" size={18} /></button>
      </div>
      <ul className="hq-duties">{a.duties.map((d) => <li key={d}>{d}</li>)}</ul>
      <div className="hq-agent-foot">
        <Badge tone={STATUS_TONE[status]}>{STATUS_AR[status]}</Badge><SimTag />
        <span className="grow" />
        <button className="btn btn-sm" onClick={onVisit}><Icon name="target" size={16} />زيارة المكتب</button>
      </div>
      <small className="muted">شخصية افتراضية للعرض؛ ليست وكيلًا فعليًا في باشت.</small>
    </section>
  );
}
