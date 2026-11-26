/**
 * Walking routes over the authored graph in layout.ts. Pure and deterministic (no Math.random, no clock).
 * Hall edges carry two-way traffic: walkers keep to their right by LANE metres, so two people crossing in a hall pass
 * side by side instead of through each other. Local edges (inside rooms, through doors) are walked on the centre line.
 */
import type { Graph, Rect, Vec2 } from "./layout";

export const LANE = 0.3;
export const BODY_R = 0.2;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

type Adj = Map<string, { to: string; w: number; kind: "hall" | "local" }[]>;
const adjCache = new WeakMap<Graph, Adj>();
function adjacency(g: Graph): Adj {
  let adj = adjCache.get(g);
  if (adj) return adj;
  adj = new Map();
  for (const id of Object.keys(g.nodes)) adj.set(id, []);
  for (const [a, b, kind] of g.edges) {
    const w = dist(g.nodes[a], g.nodes[b]);
    adj.get(a)!.push({ to: b, w, kind });
    adj.get(b)!.push({ to: a, w, kind });
  }
  adjCache.set(g, adj);
  return adj;
}

/** A* over node ids. Returns the node ids from `from` to `to`, or null when unreachable. */
export function findRoute(g: Graph, from: string, to: string): string[] | null {
  if (!(from in g.nodes) || !(to in g.nodes)) return null;
  const adj = adjacency(g);
  const goal = g.nodes[to];
  const open = new Set([from]);
  const came = new Map<string, string>();
  const gScore = new Map<string, number>([[from, 0]]);
  const fScore = new Map<string, number>([[from, dist(g.nodes[from], goal)]]);
  while (open.size) {
    let cur = "";
    let best = Infinity;
    for (const id of open) { const f = fScore.get(id)!; if (f < best || (f === best && id < cur)) { best = f; cur = id; } }
    if (cur === to) {
      const path = [cur];
      while (came.has(cur)) { cur = came.get(cur)!; path.unshift(cur); }
      return path;
    }
    open.delete(cur);
    for (const { to: nb, w } of adj.get(cur)!) {
      const tentative = gScore.get(cur)! + w;
      if (tentative < (gScore.get(nb) ?? Infinity) - 1e-9) {
        came.set(nb, cur);
        gScore.set(nb, tentative);
        fScore.set(nb, tentative + dist(g.nodes[nb], goal));
        open.add(nb);
      }
    }
  }
  return null;
}

export function edgeKind(g: Graph, a: string, b: string): "hall" | "local" | null {
  for (const [x, y, k] of g.edges) if ((x === a && y === b) || (x === b && y === a)) return k;
  return null;
}

/**
 * Turns a node route into the points a walker actually follows. On hall edges both ends are shifted LANE metres to the
 * walker's right; local edges keep the centre line. Consecutive duplicate points are dropped.
 */
export function routePoints(g: Graph, route: readonly string[]): Vec2[] {
  const pts: Vec2[] = [g.nodes[route[0]]];
  for (let i = 1; i < route.length; i++) {
    const a = g.nodes[route[i - 1]], b = g.nodes[route[i]];
    if (edgeKind(g, route[i - 1], route[i]) === "hall") {
      const len = dist(a, b) || 1;
      const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
      // right-hand side of travel direction (x east, z south, viewed from above): (-dz, dx)
      const ox = -dz * LANE, oz = dx * LANE;
      pts.push([a[0] + ox, a[1] + oz], [b[0] + ox, b[1] + oz]);
    } else pts.push(b);
  }
  return pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-6);
}

export const pathLength = (pts: readonly Vec2[]) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);

/** Shortest distance between segment ab and an axis-aligned rect (0 when they touch or cross). */
export function segmentRectDistance(a: Vec2, b: Vec2, r: Rect): number {
  if (segmentHitsRect(a, b, r)) return 0;
  const corners: Vec2[] = [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
  let best = Math.min(pointRectDistance(a, r), pointRectDistance(b, r));
  for (const c of corners) best = Math.min(best, pointSegmentDistance(c, a, b));
  return best;
}
export function pointRectDistance(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x0 - p[0], 0, p[0] - r.x1), dz = Math.max(r.z0 - p[1], 0, p[1] - r.z1);
  return Math.hypot(dx, dz);
}
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const len2 = vx * vx + vz * vz;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vz));
}
/** Liang–Barsky clip: does segment ab pass through the rect's interior or boundary? */
export function segmentHitsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const checks: [number, number][] = [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dz, a[1] - r.z0], [dz, r.z1 - a[1]]];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}
