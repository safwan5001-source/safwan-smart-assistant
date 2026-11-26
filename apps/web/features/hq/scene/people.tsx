"use client";
/**
 * Greybox characters (HQ-04a): one InstancedMesh per body part for the 13 humans (≈17 draw calls for all of them) and a small
 * dedicated rig for BASHT's robot. Poses are procedural (sit / type / walk / stand / talk) and read straight from the
 * simulation every frame — React never re-renders for animation. The Blender characters (tools/hq-assets) replace these.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AGENTS, AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import type { Clip, HqSim } from "@/lib/hq/sim";

const HUMANS = AGENT_IDS.filter((id) => id !== "BASHT");
type PartName =
  | "torso" | "thighL" | "thighR" | "shinL" | "shinR" | "footL" | "footR" | "armUL" | "armUR" | "armLL" | "armLR"
  | "handL" | "handR" | "head" | "headwear" | "agal" | "bisht";

const limb = (len: number, r0: number, r1: number) => new THREE.CylinderGeometry(r0, r1, len, 10).translate(0, -len / 2, 0);
const PART_GEOMETRY: Record<PartName, () => THREE.BufferGeometry> = {
  torso: () => new THREE.CylinderGeometry(0.17, 0.2, 0.5, 14).translate(0, 0.25, 0),
  thighL: () => limb(0.45, 0.1, 0.09), thighR: () => limb(0.45, 0.1, 0.09),
  shinL: () => limb(0.43, 0.09, 0.1), shinR: () => limb(0.43, 0.09, 0.1),
  footL: () => new THREE.BoxGeometry(0.1, 0.06, 0.22).translate(0, -0.03, 0.04), footR: () => new THREE.BoxGeometry(0.1, 0.06, 0.22).translate(0, -0.03, 0.04),
  armUL: () => limb(0.29, 0.055, 0.05), armUR: () => limb(0.29, 0.055, 0.05),
  armLL: () => limb(0.26, 0.05, 0.045), armLR: () => limb(0.26, 0.05, 0.045),
  handL: () => new THREE.SphereGeometry(0.048, 8, 6), handR: () => new THREE.SphereGeometry(0.048, 8, 6),
  head: () => new THREE.SphereGeometry(0.115, 16, 12).scale(1, 1.12, 1.04),
  // a draped head-cloth: cone from crown to shoulders, open at the face (thinned on +z)
  headwear: () => new THREE.CylinderGeometry(0.13, 0.23, 0.34, 16, 1, true, Math.PI * 0.18, Math.PI * 1.64).rotateY(Math.PI).translate(0, -0.05, -0.01),
  agal: () => new THREE.TorusGeometry(0.118, 0.016, 6, 20).rotateX(Math.PI / 2).translate(0, 0.075, -0.01),
  bisht: () => new THREE.CylinderGeometry(0.24, 0.33, 1.05, 16, 1, true, Math.PI * 0.22, Math.PI * 1.56).rotateY(Math.PI).translate(0, -0.27, -0.01),
};
const PARTS = Object.keys(PART_GEOMETRY) as PartName[];

type Rig = { root: THREE.Object3D; hips: THREE.Object3D; parts: Record<PartName, THREE.Object3D> };
function makeRig(): Rig {
  const o = () => new THREE.Object3D();
  const root = o(), hips = o();
  const p = Object.fromEntries(PARTS.map((n) => [n, o()])) as Record<PartName, THREE.Object3D>;
  root.add(hips);
  hips.add(p.torso, p.thighL, p.thighR);
  p.thighL.position.set(0.1, 0, 0); p.thighR.position.set(-0.1, 0, 0);
  p.thighL.add(p.shinL); p.thighR.add(p.shinR); p.shinL.position.y = -0.45; p.shinR.position.y = -0.45;
  p.shinL.add(p.footL); p.shinR.add(p.footR); p.footL.position.y = -0.43; p.footR.position.y = -0.43;
  p.torso.add(p.armUL, p.armUR, p.head, p.bisht);
  p.armUL.position.set(0.23, 0.46, 0); p.armUR.position.set(-0.23, 0.46, 0);
  p.armUL.add(p.armLL); p.armUR.add(p.armLR); p.armLL.position.y = -0.29; p.armLR.position.y = -0.29;
  p.armLL.add(p.handL); p.armLR.add(p.handR); p.handL.position.y = -0.27; p.handR.position.y = -0.27;
  p.head.position.y = 0.66; p.head.add(p.headwear, p.agal);
  p.bisht.position.y = 0.5;
  return { root, hips, parts: p };
}

/** Procedural pose. `t` seconds, `phase` per-person offset so nobody moves in lockstep. */
function pose(r: Rig, clip: Clip, t: number, phase: number) {
  const p = r.parts;
  for (const n of PARTS) p[n].rotation.set(0, 0, 0);
  p.armUL.rotation.z = 0.08; p.armUR.rotation.z = -0.08;
  const breathe = Math.sin(t * 1.6 + phase) * 0.015;
  if (clip === "walk") {
    const s = Math.sin(t * 8.4 + phase);
    r.hips.position.y = 0.88 + Math.abs(s) * 0.025;
    p.thighL.rotation.x = s * 0.5; p.thighR.rotation.x = -s * 0.5;
    p.shinL.rotation.x = Math.max(0, -s) * 0.7; p.shinR.rotation.x = Math.max(0, s) * 0.7;
    p.armUL.rotation.x = -s * 0.42; p.armUR.rotation.x = s * 0.42;
    p.armLL.rotation.x = -0.25; p.armLR.rotation.x = -0.25;
    p.torso.rotation.y = s * 0.05;
    return;
  }
  if (clip === "stand") { r.hips.position.y = 0.88; p.torso.rotation.x = breathe; return; }
  // seated clips
  r.hips.position.y = 0.5;
  p.thighL.rotation.x = -Math.PI / 2; p.thighR.rotation.x = -Math.PI / 2;
  p.shinL.rotation.x = Math.PI / 2; p.shinR.rotation.x = Math.PI / 2;
  p.thighL.rotation.z = 0.06; p.thighR.rotation.z = -0.06;
  p.torso.rotation.x = 0.04 + breathe;
  if (clip === "type") {
    const k = Math.sin(t * 13 + phase) * 0.07;
    p.armUL.rotation.x = -0.62 + k; p.armUR.rotation.x = -0.62 - k;
    p.armLL.rotation.x = -1.05; p.armLR.rotation.x = -1.05;
    p.head.rotation.x = 0.12;
  } else if (clip === "talk") {
    const g = Math.sin(t * 2.2 + phase);
    p.armUR.rotation.x = -0.85 + g * 0.25; p.armLR.rotation.x = -1.2; p.armUR.rotation.z = -0.25;
    p.armUL.rotation.x = -0.4; p.armLL.rotation.x = -0.9;
    p.head.rotation.x = Math.sin(t * 1.3 + phase) * 0.08; p.head.rotation.y = Math.sin(t * 0.7 + phase) * 0.25;
  } else {
    p.armUL.rotation.x = -0.45; p.armUR.rotation.x = -0.45; p.armLL.rotation.x = -0.75; p.armLR.rotation.x = -0.75;
  }
}

function partColor(id: AgentId, part: PartName): string | null {
  const look = AGENTS[id].look;
  if (look.kind !== "human") return null;
  switch (part) {
    case "head": case "handL": case "handR": return look.skin;
    case "footL": case "footR": return "#2a2320";
    case "headwear": return look.head === "shemagh" ? "#c8363b" : look.head === "ghutra" ? "#f6f5f1" : look.accent;
    case "agal": return look.head === "hijab" ? null : "#1b1b1f";
    case "bisht": return look.extras.includes("bisht") ? "#3a2618" : null;
    case "torso": case "armUL": case "armUR": case "armLL": case "armLR": return look.outfit;
    default: return look.outfit; // legs: the robe
  }
}

const tmpM = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const scaleM = new THREE.Matrix4();

export default function People({ sim, quality }: { sim: HqSim; quality: "high" | "low" }) {
  const meshes = useRef<Partial<Record<PartName, THREE.InstancedMesh | null>>>({});
  const robot = useRef<THREE.Group>(null);
  const robotLegs = useRef<(THREE.Object3D | null)[]>([]);
  const shadows = useRef<THREE.InstancedMesh>(null);
  const rig = useMemo(makeRig, []);
  const geos = useMemo(() => Object.fromEntries(PARTS.map((n) => [n, PART_GEOMETRY[n]()])) as Record<PartName, THREE.BufferGeometry>, []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.02 }), []);
  const robotGeo = useMemo(robotGeometry, []);
  const robotMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.1 }), []);
  const eyeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#22d3ee", toneMapped: false }), []);
  const shadowTex = useMemo(blobTexture, []);
  const phases = useMemo(() => Object.fromEntries(AGENT_IDS.map((id, i) => [id, i * 1.37])) as Record<AgentId, number>, []);

  // static per-instance colours
  useEffect(() => {
    const c = new THREE.Color();
    for (const n of PARTS) {
      const m = meshes.current[n];
      if (!m) continue;
      HUMANS.forEach((id, i) => { const col = partColor(id, n); m.setColorAt(i, c.set(col ?? "#000000")); });
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    material.needsUpdate = true; // recompile with instance colours
  }, [material]);
  useEffect(() => () => { Object.values(geos).forEach((g) => g.dispose()); material.dispose(); robotGeo.body.dispose(); robotGeo.eyes.dispose(); robotMat.dispose(); eyeMat.dispose(); shadowTex.dispose(); }, [geos, material, robotGeo, robotMat, eyeMat, shadowTex]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    HUMANS.forEach((id, i) => {
      const w = sim.walkers[id];
      const look = AGENTS[id].look;
      if (look.kind !== "human") return;
      const k = look.height / 1.75;
      const bw = look.build === "slim" ? 0.92 : look.build === "broad" ? 1.14 : 1;
      rig.root.position.set(w.pos[0], 0, w.pos[1]);
      rig.root.rotation.set(0, w.yaw, 0);
      rig.root.scale.set(k * bw, k, k * bw);
      pose(rig, w.clip, t, phases[id]);
      rig.root.updateMatrixWorld(true);
      for (const n of PARTS) {
        const m = meshes.current[n];
        if (!m) continue;
        const visible = partColor(id, n) !== null;
        m.setMatrixAt(i, visible ? rig.parts[n].matrixWorld : HIDDEN);
      }
    });
    for (const n of PARTS) { const m = meshes.current[n]; if (m) m.instanceMatrix.needsUpdate = true; }

    // BASHT robot
    const b = sim.walkers.BASHT;
    const g = robot.current;
    if (g) {
      g.position.set(b.pos[0], b.clip === "walk" ? Math.abs(Math.sin(t * 8.4)) * 0.03 : 0, b.pos[1]);
      g.rotation.y = b.yaw;
      const seated = b.clip !== "walk" && b.clip !== "stand";
      const body = g.children[0];
      body.position.y = seated ? -0.36 : 0;
      body.rotation.x = b.clip === "type" ? 0.08 : 0;
      const s = Math.sin(t * 8.4);
      robotLegs.current.forEach((leg, j) => {
        if (!leg) return;
        leg.position.y = seated ? 0.46 : 0.82;
        leg.rotation.x = seated ? -Math.PI / 2 : b.clip === "walk" ? (j ? -s : s) * 0.5 : 0;
      });
    }

    // contact shadows
    const sh = shadows.current;
    if (sh) {
      AGENT_IDS.forEach((id, i) => {
        const w = sim.walkers[id];
        scaleM.makeScale(id === "BASHT" ? 1.15 : 0.95, 1, id === "BASHT" ? 1.15 : 0.95);
        tmpM.makeTranslation(w.pos[0], 0.012, w.pos[1]).multiply(scaleM);
        sh.setMatrixAt(i, tmpM);
      });
      sh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {PARTS.map((n) => (
        <instancedMesh key={n} ref={(m) => { meshes.current[n] = m; }} args={[geos[n], material, HUMANS.length]} castShadow={quality === "high"} frustumCulled={false} />
      ))}
      <group ref={robot}>
        <group>
          <mesh geometry={robotGeo.body} material={robotMat} />
          <mesh geometry={robotGeo.eyes} material={eyeMat} />
        </group>
        {[0.12, -0.12].map((x, j) => (
          <group key={x} ref={(el) => { robotLegs.current[j] = el; }} position={[x, 0.82, 0]}>
            <mesh position={[0, -0.38, 0]} material={robotMat}><capsuleGeometry args={[0.085, 0.55, 4, 10]} /></mesh>
          </group>
        ))}
      </group>
      <instancedMesh ref={shadows} args={[undefined, undefined, AGENT_IDS.length]} frustumCulled={false} renderOrder={1}>
        <planeGeometry args={[0.9, 0.9]} onUpdate={(g) => g.rotateX(-Math.PI / 2)} />
        <meshBasicMaterial map={shadowTex} transparent depthWrite={false} opacity={0.55} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/** BASHT — the official mascot (purple robot, white dasmal with the red band, gold jambiya), as greybox volumes. */
function robotGeometry() {
  const col = (g: THREE.BufferGeometry, hex: string) => {
    const c = new THREE.Color(hex).convertSRGBToLinear();
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const body = mergeGeometries([
    col(new THREE.CapsuleGeometry(0.27, 0.42, 6, 18).translate(0, 1.12, 0), "#5b21b6"), // torso
    col(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 18, 1, false, -0.9, 1.8).translate(0, 1.12, 0.12), "#efeaf8"), // chest plate
    col(new THREE.SphereGeometry(0.3, 24, 18).scale(1.08, 0.95, 1).translate(0, 1.72, 0), "#4c1d95"), // head
    col(new THREE.SphereGeometry(0.235, 24, 14, -1.15, 2.3, 0.9, 1.15).scale(1.1, 0.9, 1.04).translate(0, 1.7, 0.03), "#0d0a1a"), // visor
    col(new THREE.TorusGeometry(0.3, 0.07, 10, 28).rotateX(Math.PI / 2).scale(1.08, 1, 1).translate(0, 1.86, 0), "#f5f3ff"), // dasmal wrap
    col(new THREE.TorusGeometry(0.3, 0.035, 8, 28).rotateX(Math.PI / 2).scale(1.09, 1, 1).translate(0, 1.92, 0), "#d91b38"), // red band
    col(new THREE.SphereGeometry(0.27, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.08, 0.55, 1).translate(0, 1.9, 0), "#f5f3ff"), // crown
    col(new THREE.TorusGeometry(0.28, 0.04, 8, 28).rotateX(Math.PI / 2).translate(0, 0.86, 0), "#d4a017"), // belt
    col(new THREE.TorusGeometry(0.1, 0.03, 6, 14, Math.PI).rotateZ(Math.PI).translate(0, 0.83, 0.29), "#d4a017"), // jambiya
    col(new THREE.CapsuleGeometry(0.07, 0.42, 4, 10).rotateZ(0.12).translate(0.36, 1.05, 0.02), "#4c1d95"), // arms
    col(new THREE.CapsuleGeometry(0.07, 0.42, 4, 10).rotateZ(-0.12).translate(-0.36, 1.05, 0.02), "#4c1d95"),
  ])!;
  body.computeVertexNormals();
  const eye = (x: number) => new THREE.TorusGeometry(0.05, 0.016, 6, 12, Math.PI).translate(x, 1.7, 0.27);
  const eyes = mergeGeometries([eye(0.09), eye(-0.09)])!;
  return { body, eyes };
}

function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(20,10,40,0.85)");
  grad.addColorStop(1, "rgba(20,10,40,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
