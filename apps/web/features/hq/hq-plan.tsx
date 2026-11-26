"use client";
/**
 * 2D floor plan of the HQ — the same data as the 3D scene. Shown when WebGL is unavailable, when the user prefers it, and as the
 * accessible alternative (every office is a real button). Character dots move with the simulation via direct DOM updates.
 */
import { useEffect, useRef } from "react";
import { AGENTS, AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import { BUILDING, OFFICES, WALLS, ZONES, FURNITURE, footprint } from "@/lib/hq/layout";
import type { HqSim } from "@/lib/hq/sim";
import { STATUS_AR } from "@/lib/hq/sim";

const PAD = 1;
const VB = `${BUILDING.x0 - PAD} ${BUILDING.z0 - PAD} ${BUILDING.x1 - BUILDING.x0 + PAD * 2} ${BUILDING.z1 - BUILDING.z0 + PAD * 2}`;

export default function HqPlan({ sim, selected, onSelect, paused }: { sim: HqSim; selected: AgentId | null; onSelect: (id: AgentId) => void; paused: boolean }) {
  const dots = useRef<Partial<Record<AgentId, SVGGElement | null>>>({});
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      for (const id of AGENT_IDS) {
        const g = dots.current[id], w = sim.walkers[id];
        if (g) g.setAttribute("transform", `translate(${w.pos[0].toFixed(3)} ${w.pos[1].toFixed(3)})`);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [sim, paused]);

  return (
    <svg className="hq-plan" viewBox={VB} role="group" aria-label="مخطط المقر من الأعلى">
      <rect x={BUILDING.x0} y={BUILDING.z0} width={BUILDING.x1 - BUILDING.x0} height={BUILDING.z1 - BUILDING.z0} rx={0.4} className="hq-plan-floor" />
      {Object.values(ZONES).filter((z) => "rect" in z).map((z) => {
        const r = (z as { rect: { x0: number; x1: number; z0: number; z1: number } }).rect;
        return <rect key={z.label} x={r.x0} y={r.z0} width={r.x1 - r.x0} height={r.z1 - r.z0} className="hq-plan-zone" />;
      })}
      <circle cx={ZONES.lounge.center[0]} cy={ZONES.lounge.center[1]} r={ZONES.lounge.radius} className="hq-plan-zone" />
      {FURNITURE.filter((f) => f.solid && f.kind !== "plant").map((f, i) => {
        const r = footprint(f);
        return <rect key={i} x={r.x0} y={r.z0} width={r.x1 - r.x0} height={r.z1 - r.z0} rx={0.08} className="hq-plan-furniture" />;
      })}
      {WALLS.map((w, i) => <rect key={i} x={w.x0} y={w.z0} width={w.x1 - w.x0} height={w.z1 - w.z0} className={"hq-plan-wall " + w.kind} />)}
      {OFFICES.map((o) => {
        const a = AGENTS[o.id];
        const cx = (o.rect.x0 + o.rect.x1) / 2, cz = (o.rect.z0 + o.rect.z1) / 2;
        return (
          <g key={o.id}>
            <rect
              x={o.rect.x0 + 0.08} y={o.rect.z0 + 0.08} width={o.rect.x1 - o.rect.x0 - 0.16} height={o.rect.z1 - o.rect.z0 - 0.16} rx={0.25}
              className={"hq-plan-office" + (selected === o.id ? " selected" : "")} style={{ ["--tint" as string]: a.tint }}
              role="button" tabIndex={0} aria-label={`مكتب ${a.nameAr} — ${a.role}`} aria-pressed={selected === o.id}
              onClick={() => onSelect(o.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(o.id); } }}
            />
            <text x={cx} y={cz - (o.exec ? 1.4 : 0.6)} className={"hq-plan-name" + (o.exec ? " exec" : "")}>{a.nameAr}</text>
            <text x={cx} y={cz + (o.exec ? -0.4 : 0.35)} className="hq-plan-role">{a.role}</text>
          </g>
        );
      })}
      <text x={(ZONES.meeting.rect.x0 + ZONES.meeting.rect.x1) / 2} y={ZONES.meeting.rect.z1 - 0.5} className="hq-plan-role">{ZONES.meeting.label}</text>
      <text x={(ZONES.library.rect.x0 + ZONES.library.rect.x1) / 2} y={ZONES.library.rect.z1 - 0.5} className="hq-plan-role">{ZONES.library.label}</text>
      <text x={(ZONES.reception.rect.x0 + ZONES.reception.rect.x1) / 2} y={ZONES.reception.rect.z1 - 0.5} className="hq-plan-role">{ZONES.reception.label}</text>
      <text x={0} y={ZONES.command.rect.z0 + 0.1} className="hq-plan-role">{ZONES.command.label}</text>
      {AGENT_IDS.map((id) => (
        <g key={id} ref={(el) => { dots.current[id] = el; }} aria-hidden="true">
          <circle r={id === "BASHT" ? 0.5 : 0.38} className={"hq-plan-dot" + (id === "BASHT" ? " exec" : "") + (selected === id ? " selected" : "")} style={{ ["--tint" as string]: AGENTS[id].tint }}>
            <title>{AGENTS[id].nameAr} · {STATUS_AR[sim.walkers[id].status]}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}
