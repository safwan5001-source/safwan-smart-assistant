"use client";
/**
 * The HQ building, generated from lib/hq/layout.ts (HQ-04a greybox). Static geometry is merged by material and furniture is
 * instanced per kind, so the whole floor costs ~30 draw calls. The viewer-side exterior walls are cut low (doll-house view).
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BUILDING, FURNITURE, OFFICES, WALLS, ZONES, type Furniture, type FurnitureKind, type Wall } from "@/lib/hq/layout";
import { BRAND_ASSETS } from "@/lib/brand";
import { AGENTS } from "@/lib/hq/roster";
import { PAL, brandWall, commandDesk, loungeRing, receptionDesk, screenWallFrame, unitFurniture, unitScreen } from "./geometry";

const CUT_H = 0.9; // exterior walls on the camera side (south, east, west) are cut to this height

function colored(g: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g.index ? g.toNonIndexed() : g;
}
const slab = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hex: string) =>
  colored(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), hex);

function wallHeight(w: Wall) {
  if (w.kind !== "exterior") return w.h;
  return w.z0 <= BUILDING.z0 + 0.01 ? w.h : CUT_H; // only the north (back) wall stays full height
}

function buildShell() {
  const solid: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  for (const w of WALLS) {
    const h = wallHeight(w);
    if (w.kind === "glass") {
      glass.push(slab(w.x0, 0.05, w.z0, w.x1, h - 0.06, w.z1, "#ffffff"));
      solid.push(slab(w.x0 - 0.01, h - 0.06, w.z0 - 0.01, w.x1 + 0.01, h, w.z1 + 0.01, PAL.gold)); // top rail
      solid.push(slab(w.x0 - 0.01, 0, w.z0 - 0.01, w.x1 + 0.01, 0.05, w.z1 + 0.01, PAL.ink)); // floor track
      const along = w.x1 - w.x0 > w.z1 - w.z0;
      const len = along ? w.x1 - w.x0 : w.z1 - w.z0;
      const n = Math.max(1, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) {
        const t = (along ? w.x0 : w.z0) + (len * i) / n;
        solid.push(along ? slab(t - 0.022, 0, w.z0 - 0.012, t + 0.022, h, w.z1 + 0.012, PAL.gold) : slab(w.x0 - 0.012, 0, t - 0.022, w.x1 + 0.012, h, t + 0.022, PAL.gold));
      }
    } else {
      // interior partitions: light panel walls with a deep-purple base band (reference look); exterior: warm white
      const body = w.kind === "exterior" ? "#eee8f2" : "#f2edf6";
      solid.push(slab(w.x0, 0, w.z0, w.x1, h, w.z1, body));
      if (w.kind === "solid") solid.push(slab(w.x0 - 0.006, 0, w.z0 - 0.006, w.x1 + 0.006, 0.9, w.z1 + 0.006, PAL.purple));
      solid.push(slab(w.x0 - 0.005, h - 0.05, w.z0 - 0.005, w.x1 + 0.005, h, w.z1 + 0.005, PAL.gold));
      if (w.kind === "solid") glow.push(slab(w.x0 - 0.02, h - 0.16, w.z0 - 0.02, w.x1 + 0.02, h - 0.12, w.z1 + 0.02, "#ffd88a"));
    }
  }
  // floors: marble hall, warm-wood offices, raised executive suite with a gold edge
  const floors: THREE.BufferGeometry[] = [];
  for (const o of OFFICES) {
    const y = o.exec ? 0.14 : 0.02;
    floors.push(slab(o.rect.x0, 0, o.rect.z0, o.rect.x1, y, o.rect.z1, o.exec ? "#5a3a8c" : "#c29a72"));
    if (o.exec) solid.push(slab(o.rect.x0, y, o.rect.z1 - 0.06, o.rect.x1, y + 0.012, o.rect.z1, PAL.gold));
  }
  const m = ZONES.meeting.rect, l = ZONES.library.rect;
  floors.push(slab(m.x0, 0, m.z0, m.x1, 0.02, m.z1, "#b48c66"), slab(l.x0, 0, l.z0, l.x1, 0.02, l.z1, "#bb946d"));
  // foundation edge
  solid.push(slab(BUILDING.x0 - 0.3, -0.5, BUILDING.z0 - 0.3, BUILDING.x1 + 0.3, -0.02, BUILDING.z1 + 0.3, PAL.purple));
  const merge = (a: THREE.BufferGeometry[]) => { const g = mergeGeometries(a, false)!; g.computeVertexNormals(); return g; };
  return { solid: merge(solid), glass: merge(glass), glow: merge(glow), floors: merge(floors) };
}

function marbleTexture() {
  const S = 512, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e7e2ea"; g.fillRect(0, 0, S, S);
  // deterministic soft veins
  let seed = 9;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(150,140,165,${0.06 + r() * 0.1})`;
    g.lineWidth = 0.6 + r() * 2.2;
    g.beginPath();
    let x = r() * S, y = r() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 160; y += r() * 90; g.quadraticCurveTo(x + (r() - 0.5) * 60, y - 30, x, y); }
    g.stroke();
  }
  g.strokeStyle = "rgba(201,162,74,.55)"; g.lineWidth = 3; g.strokeRect(1.5, 1.5, S - 3, S - 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set((BUILDING.x1 - BUILDING.x0) / 4, (BUILDING.z1 - BUILDING.z0) / 4);
  t.anisotropy = 4;
  return t;
}

function screenTexture(kind: "wall" | "monitor") {
  const W = kind === "wall" ? 512 : 128, H = kind === "wall" ? 160 : 80, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1a1145"); grad.addColorStop(1, "#2b1a6b");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  let seed = kind === "wall" ? 3 : 5;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (kind === "wall") {
    for (let p = 0; p < 3; p++) {
      const x0 = 12 + p * (W / 3), w = W / 3 - 24;
      g.strokeStyle = "rgba(124,58,237,.7)"; g.strokeRect(x0, 14, w, H - 28);
      g.strokeStyle = p === 1 ? "#22d3ee" : "#a78bfa"; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i <= 12; i++) { const x = x0 + (w * i) / 12, y = H - 30 - r() * (H - 60); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
      for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? "rgba(34,211,238,.55)" : "rgba(212,160,23,.7)"; const bh = 8 + r() * 36; g.fillRect(x0 + 8 + i * 12, H - 22 - bh, 7, bh); }
    }
  } else {
    for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(196,181,253,${0.35 + r() * 0.4})`; g.fillRect(10, 10 + i * 9, 30 + r() * 80, 4); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const UNIT_KINDS = ["desk", "exec-desk", "chair", "exec-chair", "monitor", "cabinet", "plant", "prop", "sofa", "armchair", "coffee-table", "meeting-table", "bookcase", "rug"] as const satisfies readonly FurnitureKind[];

function instanceMatrix(f: Furniture, liftExec: boolean) {
  const y = f.office === "BASHT" && liftExec ? 0.14 : f.kind === "rug" ? 0.021 : 0.02;
  return new THREE.Matrix4().compose(new THREE.Vector3(f.at[0], y, f.at[1]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw), new THREE.Vector3(f.w, f.h, f.d));
}

export default function Building({ night }: { night: boolean }) {
  const shell = useMemo(buildShell, []);
  const marble = useMemo(marbleTexture, []);
  const wallScreen = useMemo(() => screenTexture("wall"), []);
  const monScreen = useMemo(() => screenTexture("monitor"), []);
  const logo = useMemo(() => { const t = new THREE.TextureLoader().load(BRAND_ASSETS.logo); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }, []);
  const mats = useMemo(() => ({
    vc: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
    floor: new THREE.MeshStandardMaterial({ map: marble, roughness: 0.32, metalness: 0.02 }),
    glass: new THREE.MeshStandardMaterial({ color: "#d9d0f5", transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    wallScreen: new THREE.MeshBasicMaterial({ map: wallScreen, toneMapped: false }),
    monScreen: new THREE.MeshBasicMaterial({ map: monScreen, toneMapped: false }),
    logo: new THREE.MeshBasicMaterial({ map: logo, transparent: true, toneMapped: false }),
  }), [marble, wallScreen, monScreen, logo]);
  useEffect(() => { mats.glow.color.setScalar(night ? 1.4 : 0.55); }, [night, mats]);

  const instanced = useMemo(() => UNIT_KINDS.flatMap((kind) => {
    const items = FURNITURE.filter((f) => f.kind === kind);
    const geo = unitFurniture(kind);
    if (!items.length || !geo) return [];
    const mesh = new THREE.InstancedMesh(geo, mats.vc, items.length);
    items.forEach((f, i) => mesh.setMatrixAt(i, instanceMatrix(f, true)));
    if (kind === "prop") {
      const c = new THREE.Color();
      items.forEach((f, i) => mesh.setColorAt(i, c.set(AGENTS[f.office ?? "BASHT"].tint)));
    }
    mesh.computeBoundingSphere();
    return [{ kind, mesh }];
  }), [mats]);
  const screens = useMemo(() => {
    const items = FURNITURE.filter((f) => f.kind === "monitor");
    const mesh = new THREE.InstancedMesh(unitScreen(), mats.monScreen, items.length);
    items.forEach((f, i) => mesh.setMatrixAt(i, instanceMatrix(f, true)));
    mesh.computeBoundingSphere();
    return mesh;
  }, [mats]);
  const oneOffs = useMemo(() => {
    const out: { key: string; geo: THREE.BufferGeometry; f: Furniture; mat: THREE.Material; y?: number }[] = [];
    FURNITURE.forEach((f, i) => {
      const geo = f.kind === "command-desk" ? commandDesk(f.w, f.d) : f.kind === "lounge-ring" ? loungeRing(f.w / 2)
        : f.kind === "reception-desk" ? receptionDesk(f.w, f.d, f.h) : f.kind === "screen-wall" ? screenWallFrame(f.w, f.h, f.d)
        : f.kind === "brand-wall" ? brandWall(f.w, f.h, f.d) : null;
      if (geo) out.push({ key: f.kind + i, geo, f, mat: mats.vc, y: f.office === "BASHT" ? 0.14 : 0 });
    });
    return out;
  }, [mats]);
  useEffect(() => () => {
    Object.values(shell).forEach((g) => g.dispose());
    Object.values(mats).forEach((m) => m.dispose());
    [marble, wallScreen, monScreen, logo].forEach((t) => t.dispose());
    instanced.forEach(({ mesh }) => { mesh.geometry.dispose(); mesh.dispose(); });
    screens.geometry.dispose(); screens.dispose();
    oneOffs.forEach((o) => o.geo.dispose());
  }, [shell, mats, marble, wallScreen, monScreen, logo, instanced, screens, oneOffs]);

  const brand = FURNITURE.find((f) => f.kind === "brand-wall")!;
  return (
    <group>
      <mesh geometry={shell.floors} material={mats.vc} receiveShadow />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.001, 0]} material={mats.floor} receiveShadow>
        <planeGeometry args={[BUILDING.x1 - BUILDING.x0, BUILDING.z1 - BUILDING.z0]} />
      </mesh>
      <mesh geometry={shell.solid} material={mats.vc} castShadow receiveShadow />
      <mesh geometry={shell.glow} material={mats.glow} />
      {instanced.map(({ kind, mesh }) => <primitive key={kind} object={mesh} />)}
      <primitive object={screens} />
      {oneOffs.map((o) => (
        <mesh key={o.key} geometry={o.geo} material={o.mat} position={[o.f.at[0], o.y ?? 0, o.f.at[1]]} rotation-y={o.f.yaw} />
      ))}
      {FURNITURE.filter((f) => f.kind === "screen-wall").map((f, i) => (
        <mesh key={"sw" + i} material={mats.wallScreen} position={[f.at[0], 0, f.at[1]]} rotation-y={f.yaw}>
          <planeGeometry args={[f.w - 0.25, f.h - 0.5]} onUpdate={(g) => g.translate(0, f.h / 2 + 0.1, f.d / 2 + 0.01)} />
        </mesh>
      ))}
      {/* official logo on the executive brand wall (original asset, never redrawn) */}
      <mesh material={mats.logo} position={[brand.at[0], 0.14, brand.at[1]]} rotation-y={brand.yaw}>
        <planeGeometry args={[1.3, 1.65]} onUpdate={(g) => g.translate(0, 1.35, brand.d / 2 + 0.012)} />
      </mesh>
      <mesh geometry={shell.glass} material={mats.glass} renderOrder={2} />
    </group>
  );
}
