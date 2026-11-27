/**
 * Floating name labels: pure layout rules (no DOM), so they are unit-tested and identical on every device.
 * Labels are drawn as plain text over the 3D view; when two would overlap, the lower-priority one is hidden this frame.
 */
export type LabelBox = { id: string; x: number; y: number; w: number; h: number; priority: number; dist: number };

/** Font size in CSS px for a label `dist` metres from the camera: large when close, never below 11.5px or above 16px. */
export const labelSize = (dist: number) => Math.max(11.5, Math.min(16, 18.5 - dist * 0.2));
/** Approximate rendered width of an Arabic name in IBM Plex Sans Arabic (600) at `size` px. */
export const labelWidth = (text: string, size: number) => text.length * size * 0.62 + 6;

/**
 * Greedy placement: highest priority first (selected > BASHT > others), then nearest to the camera. Returns the ids to show.
 * Boxes are anchored at their bottom centre (x, y) — the label sits just above the head.
 */
export function placeLabels(boxes: readonly LabelBox[]): Set<string> {
  const order = [...boxes].sort((a, b) => b.priority - a.priority || a.dist - b.dist || (a.id < b.id ? -1 : 1));
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  const shown = new Set<string>();
  for (const box of order) {
    const r = { l: box.x - box.w / 2, r: box.x + box.w / 2, t: box.y - box.h, b: box.y };
    if (placed.some((q) => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t)) continue;
    placed.push(r);
    shown.add(box.id);
  }
  return shown;
}

/** Ray from `a` to `b` (3D) hits an axis-aligned box? Used to hide a name when a solid wall stands between it and the camera. */
export function segmentHitsBox(
  a: readonly [number, number, number], b: readonly [number, number, number],
  box: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number },
): boolean {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lo = [box.x0, box.y0, box.z0], hi = [box.x1, box.y1, box.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (a[i] < lo[i] || a[i] > hi[i]) return false; continue; }
    let ta = (lo[i] - a[i]) / d[i], tb = (hi[i] - a[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}
