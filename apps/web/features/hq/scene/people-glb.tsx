"use client";
/**
 * The authored characters (Blender → one skinned GLB each, built from roster.ts: no two alike). Positions come from the
 * simulation every frame; the simulation's clip picks the animation, cross-faded so nobody pops between poses.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import type { Clip, HqSim } from "@/lib/hq/sim";
import { characterUrl, withMeshopt } from "./assets";

const URLS = AGENT_IDS.map(characterUrl);
const FADE = 0.28;

type Rig = { root: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Partial<Record<Clip | "idle", THREE.AnimationAction>>; current: string };

export default function PeopleGlb({ sim, paused, reducedMotion }: { sim: HqSim; paused: boolean; reducedMotion: boolean }) {
  const gltfs = useLoader(GLTFLoader, URLS, withMeshopt);
  const shadows = useRef<THREE.InstancedMesh>(null);
  const shadowTex = useMemo(blobTexture, []);
  const rigs = useMemo(() => {
    const out = {} as Record<AgentId, Rig>;
    AGENT_IDS.forEach((id, i) => {
      const g = gltfs[i];
      const root = new THREE.Group();
      const model = cloneSkinned(g.scene); // the loader caches the glTF; each mount animates its own skeleton
      root.add(model);
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isMesh) {
          m.frustumCulled = false; // skinned bounds don't follow the pose; 14 small meshes are cheap to always draw
          for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
            mat.roughness = 0.68; mat.metalness = 0;
            if (mat.name.endsWith("_glow")) { mat.emissive.set("#22d3ee"); mat.emissiveIntensity = 1.6; mat.toneMapped = false; } // BASHT's eyes
          }
        }
      });
      const mixer = new THREE.AnimationMixer(model);
      const actions: Rig["actions"] = {};
      for (const clip of g.animations) actions[clip.name as Clip] = mixer.clipAction(clip);
      const start = actions.sit ?? actions.idle;
      start?.play();
      out[id] = { root, mixer, actions, current: start === actions.sit ? "sit" : "idle" };
      // de-synchronise idle loops
      mixer.setTime(i * 0.37);
    });
    return out;
  }, [gltfs]);
  useEffect(() => () => { for (const id of AGENT_IDS) { rigs[id].mixer.stopAllAction(); rigs[id].mixer.uncacheRoot(rigs[id].root.children[0]); } shadowTex.dispose(); }, [rigs, shadowTex]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Matrix4() }), []);
  useFrame((_, dt) => {
    for (const id of AGENT_IDS) {
      const w = sim.walkers[id], r = rigs[id];
      r.root.position.set(w.pos[0], 0, w.pos[1]);
      r.root.rotation.y = w.yaw;
      const want = w.clip in r.actions ? w.clip : w.clip === "walk" ? "walk" : "idle";
      if (want !== r.current) {
        const next = r.actions[want as Clip];
        if (next) {
          // exactly one target clip: every other running action fades out (rotations blended at a total weight > 1 over-rotate)
          for (const [name, a] of Object.entries(r.actions)) if (name !== want && a && a.isRunning()) a.fadeOut(FADE);
          // a clip still fading out is picked up where it is (reset() would jump its pose)
          if (!next.isRunning()) next.reset();
          next.stopFading().setEffectiveTimeScale(1).fadeIn(FADE).play();
          r.current = want;
        }
      }
      // paused: everyone holds still (the simulation is stopped too); reduced motion: no idle motion, walking still animates
      r.mixer.timeScale = paused ? 0 : reducedMotion && w.clip !== "walk" ? 0 : 1;
      r.mixer.update(Math.min(dt, 0.1));
    }
    const sh = shadows.current;
    if (sh) {
      AGENT_IDS.forEach((id, i) => {
        const w = sim.walkers[id];
        tmp.s.makeScale(id === "BASHT" ? 1.15 : 0.95, 1, id === "BASHT" ? 1.15 : 0.95);
        tmp.m.makeTranslation(w.pos[0], 0.025, w.pos[1]).multiply(tmp.s);
        sh.setMatrixAt(i, tmp.m);
      });
      sh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {AGENT_IDS.map((id) => <primitive key={id} object={rigs[id].root} />)}
      <instancedMesh ref={shadows} args={[undefined, undefined, AGENT_IDS.length]} frustumCulled={false} renderOrder={1}>
        <planeGeometry args={[0.95, 0.95]} onUpdate={(g) => g.rotateX(-Math.PI / 2)} />
        <meshBasicMaterial map={shadowTex} transparent depthWrite={false} opacity={0.5} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(20,10,40,0.8)");
  grad.addColorStop(1, "rgba(20,10,40,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
