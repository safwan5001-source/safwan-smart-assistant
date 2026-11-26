import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@/lib/hq/roster";
import { COLLIDERS, FRAMES } from "@/lib/hq/layout";
import { BODY_R, pointRectDistance } from "@/lib/hq/path";
import { SCENARIOS } from "@/lib/hq/demo-data";
import { HqSim, MIN_SEP } from "@/lib/hq/sim";

/** Runs one scenario end to end, checking spacing and walls every frame. */
function runScenario(id: (typeof SCENARIOS)[number]["id"], fps = 30) {
  const sim = new HqSim(11);
  expect(sim.start(id)).toBe(true);
  let minSep = Infinity, worstWall = Infinity;
  const stages = new Set<string>();
  for (let f = 0; f < fps * 240 && sim.stage !== "awaiting"; f++) {
    sim.step(1 / fps);
    stages.add(sim.stage);
    const moving = AGENT_IDS.map((a) => sim.walkers[a]).filter((w) => !w.seated);
    for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++)
      minSep = Math.min(minSep, Math.hypot(moving[i].pos[0] - moving[j].pos[0], moving[i].pos[1] - moving[j].pos[1]));
    for (const w of moving) for (const c of COLLIDERS) worstWall = Math.min(worstWall, pointRectDistance(w.pos, c));
  }
  return { sim, minSep, worstWall, stages };
}

describe("HQ simulation", () => {
  for (const sc of SCENARIOS) {
    it(`«${sc.label}»: everyone reaches the meeting and returns, never colliding or touching a wall`, () => {
      const { sim, minSep, worstWall, stages } = runScenario(sc.id);
      expect(sim.stage).toBe("awaiting");
      expect([...stages]).toEqual(expect.arrayContaining(["working", "gathering", "meeting", "returning", "awaiting"]));
      expect(minSep).toBeGreaterThanOrEqual(MIN_SEP - 0.12); // a sub-step of overlap tolerance, never two bodies in one place
      expect(worstWall).toBeGreaterThanOrEqual(BODY_R - 1e-6);
      for (const id of AGENT_IDS) {
        const w = sim.walkers[id];
        expect(w.seated, id).toBe(true);
        expect(w.pos[0]).toBeCloseTo(FRAMES[id].seat.at[0], 6);
        expect(w.pos[1]).toBeCloseTo(FRAMES[id].seat.at[1], 6);
      }
      for (const id of sc.team) expect(sim.walkers[id].status).toBe("awaiting");
      expect(sim.approve()).toBe(true);
      expect(sim.snapshot().approvedCount).toBe(1);
    });
  }

  it("is deterministic and frame-rate independent", () => {
    const a = runScenario("fleet", 30), b = runScenario("fleet", 30), c = runScenario("fleet", 12);
    expect(a.sim.t).toBe(b.sim.t);
    expect(a.sim.events.map((e) => e.text)).toEqual(b.sim.events.map((e) => e.text));
    expect(Math.abs(a.sim.t - c.sim.t)).toBeLessThan(0.2);
  });

  it("only approves while awaiting, and approval changes nothing outside the simulation", () => {
    const sim = new HqSim();
    expect(sim.approve()).toBe(false);
    expect(sim.start("tech")).toBe(true);
    expect(sim.start("finance")).toBe(false); // one scenario at a time
    expect(sim.approve()).toBe(false);
    expect(sim.events[0].text).toBeTruthy();
  });

  it("keeps idle agents seated at their own desks (ambient typing is visual only)", () => {
    const sim = new HqSim(3);
    sim.step(60);
    for (const id of AGENT_IDS) {
      expect(sim.walkers[id].seated).toBe(true);
      expect(sim.walkers[id].status).toBe("available");
    }
  });
});
