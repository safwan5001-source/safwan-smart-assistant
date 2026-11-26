/**
 * BASHT HQ — deterministic simulation of the virtual headquarters.
 * Nothing here is real work: it animates people between offices and the meeting room so the HQ can be explored.
 * Determinism: the only inputs are `seed` and the dt values passed to `step`, so a test (or a screenshot run) replays exactly.
 * Time is simulation seconds, independent of frame rate: a slow phone sees the same story, only with fewer frames.
 */
import { AGENT_IDS, type AgentId } from "./roster";
import { FRAMES, GRAPH, MEETING_SEATS, type Vec2, yawOf } from "./layout";
import { BODY_R, findRoute, routePoints } from "./path";
import { SCENARIO_BY_ID, type ScenarioId } from "./demo-data";

export type Status = "available" | "working" | "walking" | "meeting" | "awaiting" | "done";
export const STATUS_AR: Readonly<Record<Status, string>> = {
  available: "متاح", working: "يعمل", walking: "ينتقل", meeting: "في اجتماع", awaiting: "بانتظار الاعتماد", done: "أنجز مهمته",
};
/** Animation the renderer should play. */
export type Clip = "sit" | "type" | "walk" | "stand" | "talk";
export type Stage = "idle" | "working" | "gathering" | "meeting" | "returning" | "awaiting" | "approved";
export const STAGE_AR: Readonly<Record<Stage, string>> = {
  idle: "الجميع في مكاتبهم", working: "توزيع المهام والعمل الفردي", gathering: "الانتقال إلى غرفة الاجتماعات", meeting: "اجتماع ومراجعة النتائج",
  returning: "العودة إلى المكاتب", awaiting: "بانتظار اعتمادك (تجريبي)", approved: "اعتُمدت النتيجة تجريبيًا",
};

export type SimEvent = { t: number; text: string; agents: readonly AgentId[] };

export type Walker = {
  readonly id: AgentId;
  pos: [number, number];
  yaw: number;
  clip: Clip;
  status: Status;
  seated: boolean;
  /** current walking polyline and the index of the next point */
  pts: Vec2[];
  next: number;
  /** where this walker sits when it arrives (home desk or a meeting chair) */
  dest: { node: string; yaw: number } | null;
  departAt: number;
  blockedFor: number;
  typingUntil: number;
};

export const WALK_SPEED = 1.35; // m/s
export const MIN_SEP = 2 * BODY_R + 0.15; // closest two walkers may approach
const STEP = 1 / 30;
const DUR = { working: 8, meeting: 9, approvedHold: 5 } as const;

const homeNode = (id: AgentId) => `${id}:seat`;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** mulberry32 — tiny seeded PRNG */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position along a polyline after walking `d` metres (clamped to the ends). */
function along(pts: readonly Vec2[], d: number): Vec2 {
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (d <= seg) { const k = seg ? d / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
    d -= seg;
  }
  return pts[pts.length - 1];
}
const polyLen = (pts: readonly Vec2[]) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);

/**
 * Prioritised planning: everyone walks at the same constant speed, so a trajectory is fully known from its departure time.
 * Delay this walker (in quarter seconds) until its whole walk keeps MIN_SEP from every walker already scheduled. People are
 * only obstacles while on foot — before departure and after arrival they are in a chair.
 */
export function planDeparture(pts: readonly Vec2[], scheduled: readonly { pts: readonly Vec2[]; delay: number }[], minDelay: number): number {
  const len = polyLen(pts), dur = len / WALK_SPEED;
  const others = scheduled.map((o) => ({ ...o, dur: polyLen(o.pts) / WALK_SPEED }));
  for (let delay = minDelay; delay < minDelay + 60; delay += 0.25) {
    let clash = false;
    for (let tau = 0; tau <= dur + 1e-9 && !clash; tau += 0.05) {
      const p = along(pts, tau * WALK_SPEED), t = delay + tau;
      for (const o of others) {
        const ot = t - o.delay;
        if (ot < 0 || ot > o.dur) continue;
        if (dist(p, along(o.pts, ot * WALK_SPEED)) < MIN_SEP + 0.05) { clash = true; break; }
      }
    }
    if (!clash) return delay;
  }
  return minDelay + 60;
}

export type Snapshot = {
  t: number;
  stage: Stage;
  scenario: ScenarioId | null;
  statuses: Readonly<Record<AgentId, Status>>;
  events: readonly SimEvent[];
  approvedCount: number;
  /** the last scenario approved in this visit (its report stays readable after the stage returns to idle) */
  lastApproved: ScenarioId | null;
};

export class HqSim {
  readonly walkers: Readonly<Record<AgentId, Walker>>;
  t = 0;
  stage: Stage = "idle";
  scenario: ScenarioId | null = null;
  events: SimEvent[] = [];
  approvedCount = 0;
  lastApproved: ScenarioId | null = null;
  private stageT = 0;
  private acc = 0;
  private rand: () => number;
  private version = 0;

  constructor(seed = 7) {
    this.rand = rng(seed);
    const w = {} as Record<AgentId, Walker>;
    for (const id of AGENT_IDS) {
      const seat = FRAMES[id].seat;
      w[id] = {
        id, pos: [seat.at[0], seat.at[1]], yaw: seat.yaw, clip: "sit", status: "available", seated: true,
        pts: [], next: 0, dest: null, departAt: 0, blockedFor: 0, typingUntil: this.rand() * 6,
      };
    }
    this.walkers = w;
  }

  /** Monotonic counter that changes whenever something the UI lists (statuses, stage, events) changes. */
  get revision() { return this.version; }

  private log(text: string, agents: readonly AgentId[] = []) {
    this.events.unshift({ t: this.t, text, agents });
    if (this.events.length > 60) this.events.length = 60;
    this.version++;
  }
  private setStatus(w: Walker, s: Status) { if (w.status !== s) { w.status = s; this.version++; } }
  private setStage(s: Stage) { this.stage = s; this.stageT = 0; this.version++; }

  start(id: ScenarioId) {
    if (this.stage !== "idle" && this.stage !== "approved") return false;
    this.reset(false);
    const sc = SCENARIO_BY_ID[id];
    this.scenario = id;
    this.setStage("working");
    for (const a of sc.team) { const w = this.walkers[a]; this.setStatus(w, "working"); w.clip = "type"; }
    this.log(`باشت وزّع «${sc.goal}» على ${sc.team.length - 1} من الإدارات`, sc.team);
    for (const task of sc.tasks) this.log(`${task.title}`, [task.agent]);
    return true;
  }

  approve() {
    if (this.stage !== "awaiting" || !this.scenario) return false;
    const sc = SCENARIO_BY_ID[this.scenario];
    for (const a of sc.team) this.setStatus(this.walkers[a], "done");
    this.approvedCount++;
    this.lastApproved = this.scenario;
    this.setStage("approved");
    this.log("اعتمدتَ النتيجة تجريبيًا — لم يُنفَّذ أي إجراء خارج المحاكاة", sc.team);
    return true;
  }

  reset(log = true) {
    for (const id of AGENT_IDS) {
      const w = this.walkers[id], seat = FRAMES[id].seat;
      w.pos = [seat.at[0], seat.at[1]]; w.yaw = seat.yaw; w.seated = true; w.clip = "sit";
      w.pts = []; w.next = 0; w.dest = null; w.blockedFor = 0;
      this.setStatus(w, "available");
    }
    this.scenario = null;
    this.setStage("idle");
    if (log) this.log("أُعيد ضبط المحاكاة");
  }

  /** Advance by dt seconds (any size; integrated in fixed sub-steps). */
  step(dt: number) {
    this.acc += Math.min(Math.max(dt, 0), 1);
    while (this.acc >= STEP) { this.acc -= STEP; this.tick(STEP); }
  }

  private send(ids: readonly AgentId[], to: (id: AgentId, i: number) => { node: string; yaw: number }) {
    const planned: { pts: Vec2[]; delay: number }[] = [];
    ids.forEach((id, i) => {
      const w = this.walkers[id];
      const from = w.dest?.node ?? homeNode(id);
      const target = to(id, i);
      const route = findRoute(GRAPH, from, target.node);
      if (!route) throw new Error(`no route ${from} → ${target.node}`);
      const pts = routePoints(GRAPH, route);
      const delay = planDeparture(pts, planned, i * 0.6);
      planned.push({ pts, delay });
      w.pts = pts;
      w.next = 1;
      w.dest = target;
      w.departAt = this.t + delay;
      w.blockedFor = 0;
    });
  }

  private tick(dt: number) {
    this.t += dt;
    this.stageT += dt;
    const sc = this.scenario ? SCENARIO_BY_ID[this.scenario] : null;

    if (sc && this.stage === "working" && this.stageT >= DUR.working) {
      this.setStage("gathering");
      this.send(sc.team, (id, i) => ({ node: `M:seat${i}`, yaw: MEETING_SEATS[i].yaw }));
      this.log("بدء الانتقال إلى غرفة الاجتماعات", sc.team);
    } else if (sc && this.stage === "gathering" && sc.team.every((id) => this.walkers[id].seated)) {
      this.setStage("meeting");
      this.log("اكتمل الحضور وبدأ الاجتماع", sc.team);
    } else if (sc && this.stage === "meeting" && this.stageT >= DUR.meeting) {
      this.setStage("returning");
      // leave nearest-to-the-door first so nobody walks head-on into a colleague between the chairs
      const door = GRAPH.nodes["M:in"];
      const order = [...sc.team].sort((a, b) => dist(this.walkers[a].pos, door) - dist(this.walkers[b].pos, door));
      this.send(order, (id) => ({ node: homeNode(id), yaw: FRAMES[id].seat.yaw }));
      this.log("انتهى الاجتماع؛ العودة إلى المكاتب", sc.team);
    } else if (sc && this.stage === "returning" && sc.team.every((id) => this.walkers[id].seated)) {
      this.setStage("awaiting");
      for (const a of sc.team) this.setStatus(this.walkers[a], "awaiting");
      this.log(`النتيجة جاهزة: ${sc.approval.title}`, ["BASHT"]);
    } else if (this.stage === "approved" && this.stageT >= DUR.approvedHold) {
      for (const id of AGENT_IDS) this.setStatus(this.walkers[id], "available");
      this.scenario = null;
      this.setStage("idle");
    }

    for (const id of AGENT_IDS) this.move(this.walkers[id], dt);
  }

  private move(w: Walker, dt: number) {
    if (w.next === 0 || w.next >= w.pts.length) {
      // seated: ambient typing at the desk (visual only — status stays as it is)
      if (w.seated && (w.status === "available" || w.status === "done")) {
        if (this.t >= w.typingUntil) w.typingUntil = this.t + 4 + this.rand() * 9;
        w.clip = this.t < w.typingUntil - 2.5 ? "type" : "sit";
      } else if (w.seated && w.status === "meeting") w.clip = "talk";
      return;
    }
    if (this.t < w.departAt) return;
    if (w.seated) { w.seated = false; this.setStatus(w, "walking"); }
    w.clip = "walk";
    let budget = WALK_SPEED * dt;
    while (budget > 0 && w.next < w.pts.length) {
      const target = w.pts[w.next];
      const d = dist(w.pos, target);
      const stepLen = Math.min(budget, d);
      const nx = d > 1e-9 ? w.pos[0] + ((target[0] - w.pos[0]) / d) * stepLen : target[0];
      const nz = d > 1e-9 ? w.pos[1] + ((target[1] - w.pos[1]) / d) * stepLen : target[1];
      if (this.blocked(w, [nx, nz])) {
        w.blockedFor += dt;
        return;
      }
      w.blockedFor = 0;
      if (d > 1e-6) w.yaw = yawOf([target[0] - w.pos[0], target[1] - w.pos[1]]);
      w.pos = [nx, nz];
      budget -= stepLen;
      if (stepLen >= d - 1e-9) w.next++;
    }
    if (w.next >= w.pts.length) this.arrive(w);
  }

  /** Safety net only (departures are planned so this should not trigger): never step closer than MIN_SEP to someone on foot. */
  private blocked(w: Walker, p: Vec2) {
    for (const id of AGENT_IDS) {
      const o = this.walkers[id];
      if (o === w || o.seated) continue;
      const then = dist(p, o.pos);
      if (then < MIN_SEP && then < dist(w.pos, o.pos)) return true;
    }
    return false;
  }

  private arrive(w: Walker) {
    const dest = w.dest!;
    const at = GRAPH.nodes[dest.node];
    w.pos = [at[0], at[1]];
    w.yaw = dest.yaw;
    w.seated = true;
    w.pts = []; w.next = 0;
    const home = dest.node === homeNode(w.id);
    if (home) w.dest = null;
    w.clip = home ? "sit" : "talk";
    this.setStatus(w, home ? (this.stage === "returning" ? "awaiting" : "available") : "meeting");
  }

  snapshot(): Snapshot {
    const statuses = {} as Record<AgentId, Status>;
    for (const id of AGENT_IDS) statuses[id] = this.walkers[id].status;
    return { t: this.t, stage: this.stage, scenario: this.scenario, statuses, events: [...this.events], approvedCount: this.approvedCount, lastApproved: this.lastApproved };
  }
}
