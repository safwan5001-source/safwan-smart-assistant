/**
 * Procedural greybox geometry for the HQ (HQ-04a). Every piece is built from the plan in lib/hq/layout.ts and merged so the
 * whole building costs a handful of draw calls. The Blender pipeline (tools/hq-assets) replaces these with authored art.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { FurnitureKind } from "@/lib/hq/layout";

type Box = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: string];

const tmpColor = new THREE.Color();
function colorize(g: THREE.BufferGeometry, hex: string) {
  tmpColor.set(hex).convertSRGBToLinear();
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = tmpColor.r; c[i * 3 + 1] = tmpColor.g; c[i * 3 + 2] = tmpColor.b; }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}
function box([x0, y0, z0, x1, y1, z1, color]: Box) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return colorize(g, color);
}
function cyl(x: number, z: number, y0: number, y1: number, r0: number, r1: number, color: string, seg = 18) {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg);
  g.translate(x, (y0 + y1) / 2, z);
  return colorize(g, color);
}
function blob(x: number, y: number, z: number, r: number, color: string, sy = 1) {
  const g = new THREE.IcosahedronGeometry(r, 1);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return colorize(g, color);
}
const merge = (parts: THREE.BufferGeometry[]) => {
  const m = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  m.computeVertexNormals();
  return m;
};

// palette (matches the reference look: warm marble, walnut, deep purple, brushed gold)
export const PAL = {
  walnut: "#7b5039", walnutLight: "#9a6a4b", ink: "#2f2640", purple: "#5b3596", purpleSoft: "#7a52b8", gold: "#d6ae55",
  cream: "#f3ede4", white: "#faf7f2", leaf: "#4f8c45", leafDark: "#3a7036", pot: "#f1ece4", fabric: "#eee6f3", screen: "#1b1540",
};

/**
 * Unit-size furniture (fits x∈[-.5,.5], y∈[0,1], z∈[-.5,.5], front facing +z); instances are scaled to the plan's size.
 */
export function unitFurniture(kind: FurnitureKind): THREE.BufferGeometry | null {
  const P = PAL;
  switch (kind) {
    case "desk": return merge([
      box([-.5, .93, -.5, .5, 1, .5, P.walnut]), box([-.5, 0, -.45, -.44, .93, .45, P.ink]), box([.44, 0, -.45, .5, .93, .45, P.ink]),
      box([-.44, .3, .38, .44, .93, .45, P.ink]), box([-.44, .82, .45, .44, .86, .47, P.gold]),
    ]);
    case "exec-desk": return merge([
      box([-.5, .92, -.5, .5, 1, .5, P.walnut]), box([-.5, 0, -.42, .5, .92, .5, P.ink]), box([-.5, .8, .5, .5, .86, .52, P.gold]),
      box([-.3, .1, .5, .3, .7, .51, P.purple]),
    ]);
    case "chair": return merge([
      box([-.45, .42, -.42, .45, .52, .45, P.purple]), box([-.45, .52, -.5, .45, 1, -.4, P.purple]),
      cyl(0, 0, 0, .42, .06, .06, P.ink, 8), cyl(0, 0, 0, .04, .4, .4, P.ink, 10),
    ]);
    case "exec-chair": return merge([
      box([-.45, .38, -.42, .45, .5, .45, P.ink]), box([-.45, .5, -.5, .45, 1, -.36, P.ink]), box([-.42, .9, -.42, .42, .94, -.36, P.gold]),
      box([-.5, .5, -.3, -.42, .68, .35, P.ink]), box([.42, .5, -.3, .5, .68, .35, P.ink]), cyl(0, 0, 0, .38, .07, .07, P.gold, 10),
    ]);
    case "monitor": return merge([box([-.5, .32, -.5, .5, 1, .5, P.ink]), box([-.06, 0, -.5, .06, .32, .5, P.ink]), box([-.25, 0, -.5, .25, .04, .5, P.ink])]);
    case "cabinet": return merge([
      box([-.5, 0, -.5, .5, 1, .5, P.cream]), box([-.46, .66, .5, .46, .68, .52, P.gold]), box([-.46, .33, .5, .46, .35, .52, P.gold]),
    ]);
    case "plant": return merge([
      cyl(0, 0, 0, .34, .34, .4, P.pot, 16), cyl(0, 0, .32, .36, .42, .42, P.gold, 16),
      blob(0, .62, 0, .4, P.leaf, 1.1), blob(.12, .82, .08, .3, P.leafDark), blob(-.14, .78, -.06, .28, P.leaf), blob(.02, .95, -.1, .24, P.leafDark),
    ]);
    case "prop": return merge([box([-.38, 0, -.38, .38, .7, .38, P.white]), box([-.42, .7, -.42, .42, .76, .42, P.gold]), blob(0, .88, 0, .18, "#ffffff")]);
    case "sofa": return merge([
      box([-.5, 0, -.5, .5, .5, .5, P.fabric]), box([-.5, .5, -.5, .5, 1, -.22, P.fabric]), box([-.5, .5, -.22, -.42, .7, .5, P.fabric]),
      box([.42, .5, -.22, .5, .7, .5, P.fabric]), box([-.4, .5, -.2, -.02, .6, .45, P.purpleSoft]), box([.02, .5, -.2, .4, .6, .45, P.purpleSoft]),
    ]);
    case "armchair": return merge([
      box([-.5, 0, -.5, .5, .5, .5, P.purple]), box([-.5, .5, -.5, .5, 1, -.25, P.purple]), box([-.5, .5, -.25, -.36, .72, .5, P.purple]),
      box([.36, .5, -.25, .5, .72, .5, P.purple]),
    ]);
    case "coffee-table": return merge([cyl(0, 0, .86, 1, .5, .5, P.white, 24), cyl(0, 0, 0, .86, .12, .12, P.gold, 12), cyl(0, 0, 0, .05, .3, .3, P.gold, 16)]);
    case "meeting-table": return merge([
      box([-.5, .92, -.5, .5, 1, .5, P.walnut]), box([-.5, .9, -.5, .5, .92, .5, P.gold]), box([-.3, 0, -.12, -.2, .9, .12, P.ink]), box([.2, 0, -.12, .3, .9, .12, P.ink]),
    ]);
    case "bookcase": {
      const parts = [box([-.5, 0, -.5, .5, 1, -.35, P.walnut]), box([-.5, 0, -.5, -.46, 1, .5, P.walnut]), box([.46, 0, -.5, .5, 1, .5, P.walnut])];
      const colors = ["#7c2d12", "#1e3a8a", "#065f46", "#6b21a8", "#a16207", "#334155", "#9f1239"];
      for (let s = 0; s < 5; s++) {
        const y = s * 0.2;
        parts.push(box([-.46, y, -.5, .46, y + .025, .5, P.walnut]));
        let x = -.44, k = s * 3;
        while (x < .4) { const w = .04 + ((k * 37) % 5) * .012; parts.push(box([x, y + .025, -.33, x + w, y + .13 + ((k * 13) % 4) * .012, .3, colors[k % colors.length]])); x += w + .006; k++; }
      }
      return merge(parts);
    }
    case "rug": return colorize(new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0), P.purple);
    default: return null;
  }
}

/** Monitor / screen faces (emissive) in the same unit space as `monitor`. */
export function unitScreen() {
  // the monitor's front (+z after its yaw) faces the person at the desk
  return new THREE.PlaneGeometry(.92, .62).translate(0, .66, .51);
}

/** One-off pieces built at their real size. */
export function commandDesk(w: number, d: number) {
  const P = PAL, parts: THREE.BufferGeometry[] = [];
  const segs = 7, R = w * 0.9, arc = 1.0;
  for (let i = 0; i < segs; i++) {
    const a = -arc / 2 + (arc * (i + 0.5)) / segs;
    const seg = merge([box([-.62, 0, -d / 2, .62, .78, d / 2, P.ink]), box([-.62, .74, -d / 2, .62, .8, d / 2, P.walnutLight]), box([-.62, .5, d / 2, .62, .54, d / 2 + .02, P.gold])]);
    seg.translate(0, 0, -R);
    seg.rotateY(a);
    seg.translate(0, 0, R);
    parts.push(seg);
  }
  return merge(parts);
}
export function loungeRing(r: number) {
  const P = PAL, parts: THREE.BufferGeometry[] = [];
  const segs = 14;
  for (let i = 0; i < segs; i++) {
    if (i === 0 || i === segs - 1) continue; // opening towards the south hall
    const a = (i / segs) * Math.PI * 2;
    const seg = merge([box([-.62, 0, -.45, .62, .45, .45, P.fabric]), box([-.62, .45, .25, .62, .85, .45, P.fabric]), box([-.55, .45, -.4, .55, .55, .2, P.purpleSoft])]);
    seg.translate(0, 0, r - .45);
    seg.rotateY(a);
    parts.push(seg);
  }
  return merge(parts);
}
export function receptionDesk(w: number, d: number, h: number) {
  const P = PAL;
  return merge([
    box([-w / 2, 0, -d / 2, w / 2, h, d / 2, P.white]), box([-w / 2 - .05, h, -d / 2 - .05, w / 2 + .05, h + .05, d / 2 + .05, P.walnut]),
    box([-w / 2, .1, d / 2, w / 2, .16, d / 2 + .01, P.gold]), box([-w / 2, h - .16, d / 2, w / 2, h - .1, d / 2 + .01, P.gold]),
  ]);
}
export function screenWallFrame(w: number, h: number, d: number) {
  const P = PAL;
  return merge([box([-w / 2, .05, -d / 2, w / 2, h, d / 2, P.ink]), box([-w / 2, 0, -d / 2 - .1, w / 2, .05, d / 2 + .1, P.gold])]);
}
export function brandWall(w: number, h: number, d: number) {
  const P = PAL;
  return merge([box([-w / 2, 0, -d / 2, w / 2, h, d / 2, P.purple]), box([-w / 2, h, -d / 2, w / 2, h + .06, d / 2, P.gold]), box([-w / 2 - .06, 0, -d / 2, -w / 2, h + .06, d / 2, P.gold]), box([w / 2, 0, -d / 2, w / 2 + .06, h + .06, d / 2, P.gold])]);
}
