/**
 * BASHT HQ — the single source of truth for the floor plan.
 * Everything spatial derives from here: the 3D scene, the 2D plan, the walking graph, the colliders the tests check against,
 * and `tools/hq-assets/layout.json`, which the Blender generator reads so the art can never drift from the collision data.
 *
 * Units are metres. World axes: x → east (screen right in the default view), z → south (towards the default camera), y up.
 */
import { AGENT_IDS, ROSTER, type AgentId } from "./roster";

export type Vec2 = readonly [number, number]; // [x, z]
export type Rect = { x0: number; x1: number; z0: number; z1: number };
export type Side = "n" | "s" | "e" | "w";

export const BUILDING: Rect = { x0: -22, x1: 22, z0: -16, z1: 16 };
export const EXTERIOR_T = 0.3;
export const WALL_T = 0.12;
export const WALL_H = 2.7;
export const EXTERIOR_H = 3.1;
/** Inner face of the exterior wall: rooms end exactly here. */
const IN: Rect = { x0: BUILDING.x0 + EXTERIOR_T, x1: BUILDING.x1 - EXTERIOR_T, z0: BUILDING.z0 + EXTERIOR_T, z1: BUILDING.z1 - EXTERIOR_T };
/** Main entrance: gap in the south exterior wall. */
export const ENTRANCE = { x0: -10.5, x1: -7.5 };

export type Office = {
  id: AgentId;
  rect: Rect;
  door: Side;
  /** Door centre, measured along the door wall (x for n/s doors, z for e/w doors). */
  doorAt: number;
  doorW: number;
  exec: boolean;
};

const N_Z0 = IN.z0, N_Z1 = -10.5; // north row depth
const COL_W = 6; // west/east column office width (x)
const colZ = [-8.5, -4.5, -0.5, 3.5, 7.5, 11.5]; // west/east column office boundaries (z)

const north = (id: AgentId, x0: number, x1: number): Office =>
  ({ id, rect: { x0, x1, z0: N_Z0, z1: N_Z1 }, door: "s", doorAt: (x0 + x1) / 2, doorW: 1.4, exec: false });
const west = (id: AgentId, i: number): Office =>
  ({ id, rect: { x0: IN.x0, x1: IN.x0 + COL_W, z0: colZ[i], z1: colZ[i + 1] }, door: "e", doorAt: (colZ[i] + colZ[i + 1]) / 2, doorW: 1.4, exec: false });
const east = (id: AgentId, i: number): Office =>
  ({ id, rect: { x0: IN.x1 - COL_W, x1: IN.x1, z0: colZ[i], z1: colZ[i + 1] }, door: "w", doorAt: (colZ[i] + colZ[i + 1]) / 2, doorW: 1.4, exec: false });

export const OFFICES: readonly Office[] = [
  // Executive suite: centred on the north wall, larger, raised, overlooking the command centre.
  { id: "BASHT", rect: { x0: -7.5, x1: 7.5, z0: N_Z0, z1: -8 }, door: "s", doorAt: 0, doorW: 2.4, exec: true },
  north("SANAD", IN.x0, -15.2), north("MIYAR", -14.7, -8.2), north("BASIRA", 8.2, 14.7), north("HASEEN", 15.2, IN.x1),
  west("MIZAN", 0), west("RAFID", 1), west("KAFAAT", 2), west("FURAS", 3), west("NASAQ", 4),
  east("RAWAJ", 0), east("MIMAR", 1), east("MASAR", 2), east("WISAL", 3),
];

/** Shared spaces (no owner). */
export const ZONES = {
  command: { rect: { x0: -5, x1: 5, z0: -5.3, z1: -1.2 } as Rect, label: "مركز القيادة" },
  lounge: { center: [0, 3.6] as Vec2, radius: 2.9, label: "منطقة الاستراحة" },
  meeting: { rect: { x0: -4, x1: 6, z0: 9.5, z1: IN.z1 } as Rect, door: "n" as Side, doorAt: 1, doorW: 1.6, label: "غرفة الاجتماعات" },
  library: { rect: { x0: 8, x1: IN.x1, z0: 9.5, z1: IN.z1 } as Rect, door: "n" as Side, doorAt: 12, doorW: 2.0, label: "مكتبة المعرفة" },
  reception: { rect: { x0: -13, x1: -5, z0: 11, z1: IN.z1 } as Rect, label: "الاستقبال" },
  waiting: { rect: { x0: IN.x0, x1: IN.x0 + COL_W, z0: 11.5, z1: IN.z1 } as Rect, label: "منطقة الانتظار" },
} as const;

// ── geometry helpers ────────────────────────────────────────────────────────
const sideDir: Record<Side, Vec2> = { s: [0, -1], n: [0, 1], e: [-1, 0], w: [1, 0] }; // INTO the room from its door
export const inward = (s: Side): Vec2 => sideDir[s];
/** Lateral axis of a room: the inward direction turned a quarter. */
export const lateral = (s: Side): Vec2 => { const [dx, dz] = sideDir[s]; return [dz, -dx]; };
export function doorPoint(rect: Rect, side: Side, at: number): Vec2 {
  return side === "s" ? [at, rect.z1] : side === "n" ? [at, rect.z0] : side === "e" ? [rect.x1, at] : [rect.x0, at];
}
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const round = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (p: Vec2): Vec2 => [round(p[0]), round(p[1])];
export const depthOf = (rect: Rect, side: Side) => (side === "n" || side === "s" ? rect.z1 - rect.z0 : rect.x1 - rect.x0);
export const widthOf = (rect: Rect, side: Side) => (side === "n" || side === "s" ? rect.x1 - rect.x0 : rect.z1 - rect.z0);

/** Facing angle (radians, three.js yaw: 0 = looking towards +z) for a direction on the floor. */
export const yawOf = (dir: Vec2) => Math.atan2(dir[0], dir[1]);

// ── furniture ───────────────────────────────────────────────────────────────
export type FurnitureKind =
  | "desk" | "exec-desk" | "chair" | "exec-chair" | "monitor" | "cabinet" | "plant" | "prop"
  | "sofa" | "coffee-table" | "meeting-table" | "screen-wall" | "command-desk" | "lounge-ring"
  | "reception-desk" | "bookcase" | "armchair" | "brand-wall" | "rug";
export type Furniture = {
  kind: FurnitureKind;
  /** centre on the floor */
  at: Vec2;
  /** footprint along the item's own axes (w = across, d = depth) and height */
  w: number; d: number; h: number;
  yaw: number;
  /** blocks walking (chairs and rugs do not: people sit on / walk over them) */
  solid: boolean;
  office?: AgentId;
};

export type Seat = { at: Vec2; yaw: number };

export type OfficeFrame = {
  office: Office;
  door: Vec2; inward: Vec2; lateral: Vec2;
  seat: Seat;
  /** walking nodes inside the room, from the seat out to just outside the door */
  route: readonly Vec2[];
};

export function officeFrame(o: Office): OfficeFrame {
  const d = inward(o.door), L = lateral(o.door);
  const door = doorPoint(o.rect, o.door, o.doorAt);
  const depth = depthOf(o.rect, o.door);
  const back = add(door, d, depth);
  const seatBack = o.exec ? 1.5 : 0.85;
  const seatAt = add(back, d, -seatBack);
  const by = o.exec ? 2.2 : 1.3; // lateral bypass around the desk
  const p1 = add(seatAt, L, by);
  const p2 = add(p1, d, o.exec ? -2.0 : -1.5);
  const di = add(door, d, 0.7);
  const dout = add(door, d, -0.7);
  // people face the door (desk between them and the corridor)
  return { office: o, door: r2(door), inward: d, lateral: L, seat: { at: r2(seatAt), yaw: yawOf([-d[0], -d[1]]) }, route: [seatAt, p1, p2, di, dout].map(r2) };
}

function officeFurniture(f: OfficeFrame): Furniture[] {
  const { office: o, inward: d, lateral: L } = f;
  const depth = depthOf(o.rect, o.door), width = widthOf(o.rect, o.door);
  const back = add(f.door, d, depth);
  const yawIn = yawOf(d); // object front facing into the room from the back wall… i.e. facing the door is yawOf(-d)
  const yawOut = yawOf([-d[0], -d[1]]);
  const items: Furniture[] = [];
  const put = (kind: FurnitureKind, fromBack: number, lat: number, w: number, dd: number, h: number, yaw: number, solid = true) =>
    items.push({ kind, at: r2(add(add(back, d, -fromBack), L, lat)), w, d: dd, h, yaw, solid, office: o.id });
  if (o.exec) {
    put("rug", 3.0, 0, 8.5, 5.2, 0.01, yawOut, false);
    put("brand-wall", 0.12, 0, 6.0, 0.16, 2.5, yawOut);
    put("exec-desk", 2.35, 0, 3.0, 1.1, 0.78, yawOut);
    put("exec-chair", 1.5, 0, 0.75, 0.75, 1.25, yawOut, false);
    put("monitor", 2.55, -0.55, 0.85, 0.08, 0.5, yawIn);
    put("monitor", 2.55, 0.55, 0.85, 0.08, 0.5, yawIn);
    // guest chairs across the desk
    put("chair", 3.45, -0.7, 0.6, 0.6, 0.95, yawIn, false);
    put("chair", 3.45, 0.7, 0.6, 0.6, 0.95, yawIn, false);
    // lounge on the -L side, small meeting table on the +L side (beyond the bypass)
    put("sofa", 1.2, -5.2, 2.6, 0.9, 0.8, yawOut);
    put("coffee-table", 2.6, -5.2, 1.4, 0.7, 0.42, yawOut);
    put("armchair", 3.9, -5.9, 0.85, 0.85, 0.85, yawIn);
    put("armchair", 3.9, -4.5, 0.85, 0.85, 0.85, yawIn);
    put("meeting-table", 2.0, 5.2, 1.3, 1.3, 0.74, 0);
    put("cabinet", 0.3, 3.6, 1.6, 0.45, 1.2, yawOut);
    put("plant", 0.45, -width / 2 + 0.55, 0.6, 0.6, 1.6, 0);
    put("plant", 0.45, width / 2 - 0.55, 0.6, 0.6, 1.6, 0);
    put("plant", depth - 0.5, -width / 2 + 0.55, 0.55, 0.55, 1.3, 0);
    put("plant", depth - 0.5, width / 2 - 0.55, 0.55, 0.55, 1.3, 0);
    return items;
  }
  put("desk", 1.6, 0, 1.8, 0.8, 0.75, yawOut);
  put("chair", 0.85, 0, 0.6, 0.6, 1.05, yawOut, false);
  put("monitor", 1.78, 0, 0.7, 0.07, 0.45, yawIn);
  put("cabinet", depth - 2.2, -(width / 2 - 0.28), 1.2, 0.42, 1.1, yawOf(L));
  put("plant", 0.42, -(width / 2 - 0.42), 0.5, 0.5, 1.2, 0);
  put("prop", depth - 0.55, width / 2 - 0.4, 0.5, 0.5, 1.0, 0);
  return items;
}

// meeting room: 12 seats around one table
const MEETING_TABLE = { at: [1, 12.8] as Vec2, w: 5.6, d: 1.8 };
const MEETING_NORTH_Z = 11.62, MEETING_SOUTH_Z = 13.98, MEETING_LANE_N = 10.7, MEETING_LANE_S = 14.95;
const MEETING_XS = [-1.2, -0.1, 1.0, 2.1, 3.2] as const;
const MEETING_WEST_X = -3.3, MEETING_EAST_X = 5.3;
export const MEETING_SEATS: readonly Seat[] = [
  { at: [-2.6, 12.8], yaw: yawOf([1, 0]) }, // head of the table (BASHT)
  ...MEETING_XS.map((x): Seat => ({ at: [x, MEETING_NORTH_Z], yaw: yawOf([0, 1]) })),
  { at: [4.6, 12.8], yaw: yawOf([-1, 0]) },
  ...MEETING_XS.map((x): Seat => ({ at: [x, MEETING_SOUTH_Z], yaw: yawOf([0, -1]) })),
];

function sharedFurniture(): Furniture[] {
  const f: Furniture[] = [];
  const put = (kind: FurnitureKind, at: Vec2, w: number, d: number, h: number, yaw = 0, solid = true) => f.push({ kind, at, w, d, h, yaw, solid });
  // command centre: video wall facing south, curved operator desk, three operator chairs
  put("screen-wall", [0, -5.0], 9.0, 0.3, 2.4, 0);
  put("command-desk", [0, -3.2], 8.0, 1.1, 0.8, 0);
  for (const x of [-2.6, 0, 2.6]) put("chair", [x, -2.25], 0.6, 0.6, 1.0, yawOf([0, -1]), false);
  // central lounge
  put("rug", [0, 3.6], 6.6, 6.6, 0.01, 0, false);
  put("lounge-ring", [0, 3.6], 5.6, 5.6, 0.8, 0);
  put("coffee-table", [0, 3.6], 1.6, 1.6, 0.42, 0);
  // meeting room
  put("meeting-table", MEETING_TABLE.at, MEETING_TABLE.w, MEETING_TABLE.d, 0.75, 0);
  for (const s of MEETING_SEATS) put("chair", s.at, 0.6, 0.6, 1.0, s.yaw, false);
  put("screen-wall", [5.82, 12.8], 3.2, 0.12, 1.8, yawOf([-1, 0]));
  // reception and waiting
  put("reception-desk", [-9, 13.7], 3.4, 0.9, 1.05, 0);
  put("chair", [-9, 12.75], 0.6, 0.6, 1.0, 0, false);
  put("sofa", [-18.7, 15.0], 3.0, 0.9, 0.8, yawOf([0, -1]));
  put("sofa", [-21.0, 13.4], 2.2, 0.9, 0.8, yawOf([1, 0]));
  put("coffee-table", [-18.7, 13.4], 1.4, 0.8, 0.42, 0);
  // library
  for (const x of [9.6, 12.0, 14.4, 16.8, 19.2]) put("bookcase", [x, 15.35], 2.2, 0.45, 2.2, yawOf([0, -1]));
  put("bookcase", [21.35, 12.4], 2.2, 0.45, 2.2, yawOf([-1, 0]));
  put("armchair", [15.0, 12.2], 0.9, 0.9, 0.85, yawOf([0, 1]));
  put("armchair", [17.4, 12.2], 0.9, 0.9, 0.85, yawOf([0, 1]));
  put("coffee-table", [16.2, 12.9], 1.2, 0.7, 0.42, 0);
  put("meeting-table", [10.4, 12.4], 1.4, 1.4, 0.74, 0);
  // greenery along the open hall
  for (const at of [[-11.5, -7.4], [11.5, -7.4], [-11.5, 7.2], [11.5, 7.2], [-5.6, -7.45], [5.6, -7.45], [-4.6, 9.0], [6.6, 9.0]] as Vec2[])
    put("plant", at, 0.6, 0.6, 1.5, 0);
  return f;
}

// ── walls ───────────────────────────────────────────────────────────────────
export type WallKind = "exterior" | "solid" | "glass";
export type Wall = { x0: number; x1: number; z0: number; z1: number; h: number; kind: WallKind };

function segmentWall(a: Vec2, b: Vec2, kind: WallKind, t = WALL_T, h = WALL_H): Wall {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [z0, z1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x0 === x1
    ? { x0: round(x0 - t / 2), x1: round(x0 + t / 2), z0: round(z0), z1: round(z1), h, kind }
    : { x0: round(x0), x1: round(x1), z0: round(z0 - t / 2), z1: round(z0 + t / 2), h, kind };
}
/** A wall along one side of a rect, with an optional opening. */
function sideWalls(r: Rect, s: Side, kind: WallKind, opening?: { at: number; w: number }): Wall[] {
  const [a, b]: [Vec2, Vec2] = s === "n" ? [[r.x0, r.z0], [r.x1, r.z0]] : s === "s" ? [[r.x0, r.z1], [r.x1, r.z1]]
    : s === "w" ? [[r.x0, r.z0], [r.x0, r.z1]] : [[r.x1, r.z0], [r.x1, r.z1]];
  if (!opening) return [segmentWall(a, b, kind)];
  const horiz = a[1] === b[1];
  const lo = opening.at - opening.w / 2, hi = opening.at + opening.w / 2;
  const p = (v: number): Vec2 => (horiz ? [v, a[1]] : [a[0], v]);
  const [s0, s1] = horiz ? [a[0], b[0]] : [a[1], b[1]];
  return [segmentWall(p(s0), p(lo), kind), segmentWall(p(hi), p(s1), kind)].filter((w) => w.x1 - w.x0 > 0.05 && w.z1 - w.z0 > 0.05);
}
const onExterior = (w: Wall) =>
  (w.x1 - w.x0 < 0.5 && (Math.abs(w.x0 - IN.x0) < 0.3 || Math.abs(w.x1 - IN.x1) < 0.3)) ||
  (w.z1 - w.z0 < 0.5 && (Math.abs(w.z0 - IN.z0) < 0.3 || Math.abs(w.z1 - IN.z1) < 0.3));

function buildWalls(): Wall[] {
  const B = BUILDING, t = EXTERIOR_T, H = EXTERIOR_H;
  const ext: Wall[] = [
    { x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z0 + t, h: H, kind: "exterior" },
    { x0: B.x0, x1: ENTRANCE.x0, z0: B.z1 - t, z1: B.z1, h: H, kind: "exterior" },
    { x0: ENTRANCE.x1, x1: B.x1, z0: B.z1 - t, z1: B.z1, h: H, kind: "exterior" },
    { x0: B.x0, x1: B.x0 + t, z0: B.z0, z1: B.z1, h: H, kind: "exterior" },
    { x0: B.x1 - t, x1: B.x1, z0: B.z0, z1: B.z1, h: H, kind: "exterior" },
  ];
  const inner: Wall[] = [];
  for (const o of OFFICES) {
    const sides: Side[] = ["n", "s", "e", "w"];
    for (const s of sides) {
      const isDoor = s === o.door;
      const isBack = s === ({ n: "s", s: "n", e: "w", w: "e" } as const)[o.door];
      const kind: WallKind = isDoor ? "glass" : isBack ? "solid" : o.exec ? "glass" : "solid";
      inner.push(...sideWalls(o.rect, s, kind, isDoor ? { at: o.doorAt, w: o.doorW } : undefined));
    }
  }
  const m = ZONES.meeting, l = ZONES.library;
  inner.push(...sideWalls(m.rect, "n", "glass", { at: m.doorAt, w: m.doorW }), ...sideWalls(m.rect, "w", "glass"), ...sideWalls(m.rect, "e", "glass"));
  inner.push(...sideWalls(l.rect, "n", "glass", { at: l.doorAt, w: l.doorW }), ...sideWalls(l.rect, "w", "solid"));
  // NASAQ's south wall doubles as the waiting area's north wall (already emitted). Dedup identical segments; drop walls that
  // coincide with the exterior shell (it already covers them).
  const seen = new Set<string>();
  const out: Wall[] = [];
  for (const w of inner) {
    if (onExterior(w)) continue;
    const key = [w.x0, w.x1, w.z0, w.z1].join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return [...ext, ...out];
}

// ── walking graph ───────────────────────────────────────────────────────────
export type EdgeKind = "hall" | "local";
export type Graph = { nodes: Record<string, Vec2>; edges: ReadonlyArray<readonly [string, string, EdgeKind]> };

const WEST_X = -14.2, EAST_X = 14.2, NORTH_HALL_Z = -6.5, SOUTH_HALL_Z = 8.0, NW_HALL_Z = -9.5;

function buildGraph(frames: readonly OfficeFrame[]): Graph {
  const nodes: Record<string, Vec2> = {};
  const edges: [string, string, EdgeKind][] = [];
  const node = (id: string, p: Vec2) => { nodes[id] = r2(p); return id; };
  const link = (a: string, b: string, k: EdgeKind = "hall") => edges.push([a, b, k]);
  const chain = (ids: string[], k: EdgeKind = "hall") => ids.slice(1).forEach((id, i) => link(ids[i], id, k));

  // west / east corridors
  const wz = [NW_HALL_Z, NORTH_HALL_Z, -2.5, 1.5, 5.5, SOUTH_HALL_Z, 9.5];
  const ez = [NW_HALL_Z, NORTH_HALL_Z, -2.5, 1.5, 5.5, SOUTH_HALL_Z];
  chain(wz.map((z) => node(`W${z}`, [WEST_X, z])));
  chain(ez.map((z) => node(`E${z}`, [EAST_X, z])));
  // north hall (between exec suite and command centre) and south hall (between lounge and meeting room)
  chain([`W${NORTH_HALL_Z}`, node("H-8", [-8, NORTH_HALL_Z]), node("H0", [0, NORTH_HALL_Z]), node("H8", [8, NORTH_HALL_Z]), `E${NORTH_HALL_Z}`]);
  chain([`W${SOUTH_HALL_Z}`, node("S-8", [-8, SOUTH_HALL_Z]), node("S1", [1, SOUTH_HALL_Z]), node("S8", [8, SOUTH_HALL_Z]), node("S12", [12, SOUTH_HALL_Z]), `E${SOUTH_HALL_Z}`]);
  // aisles past the command centre / lounge
  link("H-8", "S-8"); link("H8", "S8");
  // short north-west / north-east halls in front of the two inner north offices
  chain([`W${NW_HALL_Z}`, node("NW", [-11.45, NW_HALL_Z]), "H-8"]);
  chain([`E${NW_HALL_Z}`, node("NE", [11.45, NW_HALL_Z]), "H8"]);

  // offices: seat → … → just outside the door → nearest hall node
  const hallFor: Partial<Record<AgentId, string[]>> = {
    BASHT: ["H0"], SANAD: [`W${NW_HALL_Z}`], MIYAR: ["NW"], BASIRA: ["NE"], HASEEN: [`E${NW_HALL_Z}`],
  };
  for (const f of frames) {
    const id = f.office.id;
    const ids = f.route.map((p, i) => node(`${id}:${["seat", "p1", "p2", "in", "out"][i]}`, p));
    chain(ids, "local");
    const targets = hallFor[id] ?? [`${f.office.door === "e" ? "W" : "E"}${f.office.doorAt}`];
    for (const t of targets) link(ids[ids.length - 1], t, "local");
  }

  // meeting room: door → lanes around the table → seats
  const m = ZONES.meeting;
  const mOut = node("M:out", [m.doorAt, m.rect.z0 - 0.7]);
  const mIn = node("M:in", [m.doorAt, m.rect.z0 + 0.7]);
  link("S1", mOut, "local"); link(mOut, mIn, "local");
  const laneN = [MEETING_WEST_X, ...MEETING_XS, MEETING_EAST_X].map((x) => node(`M:n${x}`, [x, MEETING_LANE_N]));
  const laneS = [MEETING_WEST_X, ...MEETING_XS, MEETING_EAST_X].map((x) => node(`M:s${x}`, [x, MEETING_LANE_S]));
  chain(laneN, "local"); chain(laneS, "local");
  link(mIn, `M:n${m.doorAt}`, "local");
  const westMid = node("M:wm", [MEETING_WEST_X, MEETING_SEATS[0].at[1]]);
  const eastMid = node("M:em", [MEETING_EAST_X, MEETING_SEATS[6].at[1]]);
  chain([laneN[0], westMid, laneS[0]], "local");
  chain([laneN[laneN.length - 1], eastMid, laneS[laneS.length - 1]], "local");
  MEETING_SEATS.forEach((s, i) => {
    const sid = node(`M:seat${i}`, s.at);
    const lane = i === 0 ? westMid : i === 6 ? eastMid : i <= 5 ? `M:n${s.at[0]}` : `M:s${s.at[0]}`;
    link(lane, sid, "local");
  });
  // library (a destination for ambient visits)
  const l = ZONES.library;
  const lOut = node("L:out", [l.doorAt, l.rect.z0 - 0.7]);
  const lIn = node("L:in", [l.doorAt, l.rect.z0 + 1.2]);
  link("S12", lOut, "local"); link(lOut, lIn, "local");
  return { nodes, edges };
}

// ── assembled plan ──────────────────────────────────────────────────────────
export const FRAMES: Readonly<Record<AgentId, OfficeFrame>> = Object.fromEntries(OFFICES.map((o) => [o.id, officeFrame(o)])) as Record<AgentId, OfficeFrame>;
export const FURNITURE: readonly Furniture[] = [...OFFICES.flatMap((o) => officeFurniture(FRAMES[o.id])), ...sharedFurniture()];
export const WALLS: readonly Wall[] = buildWalls();
export const GRAPH: Graph = buildGraph(AGENT_IDS.map((id) => FRAMES[id]));

/** Axis-aligned footprint of a piece of furniture (yaw is always a multiple of 90° in this plan). */
export function footprint(f: Furniture): Rect {
  const quarter = Math.round(f.yaw / (Math.PI / 2));
  const swap = Math.abs(quarter) % 2 === 1;
  const [hw, hd] = swap ? [f.d / 2, f.w / 2] : [f.w / 2, f.d / 2];
  return { x0: f.at[0] - hw, x1: f.at[0] + hw, z0: f.at[1] - hd, z1: f.at[1] + hd };
}

/** Everything a walking person must not pass through (2D footprints). */
export const COLLIDERS: readonly Rect[] = [
  ...WALLS.map((w) => ({ x0: w.x0, x1: w.x1, z0: w.z0, z1: w.z1 })),
  ...FURNITURE.filter((f) => f.solid).map(footprint),
];

/** Camera presets: [position, target] in world units. */
export type ViewId = "overview" | "exec" | "command" | "meeting" | "reception" | "library";
export const VIEWS: Readonly<Record<ViewId, { label: string; pos: readonly [number, number, number]; target: readonly [number, number, number] }>> = {
  overview: { label: "نظرة عامة", pos: [0, 34, 30], target: [0, 0, 1] },
  exec: { label: "مكتب باشت", pos: [0, 9.2, -3.6], target: [0, 0.6, -12.2] },
  command: { label: "مركز القيادة", pos: [0, 7.5, 6], target: [0, 1, -3.5] },
  meeting: { label: "غرفة الاجتماعات", pos: [1, 9, 5.5], target: [1, 0.6, 12.8] },
  reception: { label: "الاستقبال", pos: [-9, 7.5, 6], target: [-10, 0.6, 13] },
  library: { label: "مكتبة المعرفة", pos: [14, 8, 5], target: [15, 0.6, 13] },
};

/** Serialisable plan for the asset generator (tools/hq-assets). Bump `version` on any change that needs new art. */
export function exportPlan() {
  return {
    version: 1,
    units: "m",
    axes: "x east, z south, y up (three.js); Blender import maps z → -y",
    building: BUILDING, exteriorT: EXTERIOR_T, exteriorH: EXTERIOR_H, wallT: WALL_T, wallH: WALL_H, entrance: ENTRANCE,
    offices: OFFICES.map((o) => ({ ...o, seat: FRAMES[o.id].seat, door: FRAMES[o.id].office.door, doorPoint: FRAMES[o.id].door })),
    zones: ZONES,
    walls: WALLS,
    furniture: FURNITURE,
    meetingSeats: MEETING_SEATS,
    /** character looks for the generator (roster.ts is the source) */
    characters: ROSTER.map((a) => ({ id: a.id, tint: a.tint, look: a.look })),
  };
}
