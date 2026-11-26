"use client";
/**
 * The characters: BASHT is the authored robot (its clips ride in its own GLB); the 13 people are realistic avatars
 * (Microsoft Rocketbox, MIT) that share one motion-capture clip library per skeleton. Positions come from the simulation
 * every frame; the simulation's clip picks the animation, cross-faded so nobody pops between poses.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AGENTS, AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import { WALK_SPEED, type Clip, type HqSim } from "@/lib/hq/sim";
import { bodyScale, keepTrack, seatLift, walkRate as rateFor } from "@/lib/hq/people";
import { ANIM_LIBS, PEOPLE_URLS, animLib, characterEntry, withMeshopt } from "./assets";

const FADE = 0.28;
const FADE_SEAT = 0.5;
const SEATED = new Set<string>(["sit", "type", "talk"]);

type Rig = {
  root: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Partial<Record<Clip | "idle", THREE.AnimationAction>>; current: string;
  /** uniform body scale (roster height) and the lift that keeps a scaled person on the chair cushion */
  scale: number; walkRate: number;
  /** the seated clips' actions (their summed weight scales the seat lift) and every skeleton this mount owns */
  seated: THREE.AnimationAction[]; skeletons: THREE.Skeleton[];
};

export default function PeopleGlb({ sim, paused, reducedMotion }: { sim: HqSim; paused: boolean; reducedMotion: boolean }) {
  const loaded = useLoader(GLTFLoader, PEOPLE_URLS, withMeshopt);
  const shadows = useRef<THREE.InstancedMesh>(null);
  const shadowTex = useMemo(blobTexture, []);
  const rigs = useMemo(() => {
    const libs: Record<string, THREE.AnimationClip[]> = {};
    ANIM_LIBS.forEach((k, i) => {
      libs[k] = loaded[AGENT_IDS.length + i].animations.map((c) => new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((t) => keepTrack(t.name))));
    });
    const out = {} as Record<AgentId, Rig>;
    AGENT_IDS.forEach((id, i) => {
      const g = loaded[i];
      const entry = characterEntry(id);
      const human = entry.kind === "human" && !!entry.anims && !!libs[entry.anims];
      const root = new THREE.Group();
      const model = cloneSkinned(g.scene); // the loader caches the glTF; each mount animates its own skeleton
      root.add(model);
      // people: roster height and build (bodyScale), applied to the whole posed body
      const look = AGENTS[id].look;
      const body = human && look.kind === "human" && entry.height ? bodyScale(look, entry.height) : null;
      const scale = body?.s ?? 1;
      if (body) model.scale.set(body.x, body.y, body.z);
      // GLTFLoader gives every primitive of a skinned mesh its own Skeleton (same bones): bind them all to one, so a
      // person uploads one set of bone matrices per frame instead of one per material
      let shared: THREE.Skeleton | null = null;
      model.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (!sm.isSkinnedMesh) return;
        if (!shared) shared = sm.skeleton;
        else if (sm.skeleton !== shared && sm.skeleton.bones.length === shared.bones.length && sm.skeleton.bones.every((b, k) => b === shared!.bones[k])) sm.bind(shared, sm.bindMatrix);
      });
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isMesh) {
          m.frustumCulled = false; // skinned bounds don't follow the pose; 14 small meshes are cheap to always draw
          for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
            if (human) { mat.envMapIntensity = 0.7; continue; } // scanned-style textures carry their own shading
            mat.roughness = 0.68; mat.metalness = 0;
            if (mat.name.endsWith("_glow")) { mat.emissive.set("#22d3ee"); mat.emissiveIntensity = 1.6; mat.toneMapped = false; } // BASHT's eyes
          }
        }
      });
      const mixer = new THREE.AnimationMixer(model);
      const actions: Rig["actions"] = {};
      for (const clip of human ? libs[entry.anims!] : g.animations) actions[clip.name as Clip] = mixer.clipAction(clip);
      const start = actions.sit ?? actions.idle;
      start?.play();
      // the capture walks at its own pace: play it at the simulation's speed so feet don't slide
      const walkRate = human ? rateFor(WALK_SPEED, animLib(entry.anims!).walkSpeed, body ? body.z : 1) : 1;
      actions.walk?.setEffectiveTimeScale(walkRate);
      const skeletons = new Set<THREE.Skeleton>();
      model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton); });
      const seated = Object.entries(actions).filter(([n, a]) => a && SEATED.has(n)).map(([, a]) => a!);
      out[id] = { root, mixer, actions, current: start === actions.sit ? "sit" : "idle", scale, walkRate, seated, skeletons: [...skeletons] };
      // de-synchronise idle loops
      mixer.setTime(i * 0.37);
    });
    return out;
  }, [loaded]);
  useEffect(() => () => {
    for (const id of AGENT_IDS) {
      const r = rigs[id];
      r.mixer.stopAllAction();
      r.mixer.uncacheRoot(r.root.children[0]);
      for (const sk of r.skeletons) sk.dispose(); // the per-mount bone textures (geometry/materials stay with the loader cache)
    }
    shadowTex.dispose();
  }, [rigs, shadowTex]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Matrix4() }), []);
  useFrame((_, dt) => {
    for (const id of AGENT_IDS) {
      const w = sim.walkers[id], r = rigs[id];
      r.root.position.x = w.pos[0];
      r.root.position.z = w.pos[1];
      r.root.rotation.y = w.yaw;
      const want = w.clip in r.actions ? w.clip : w.clip === "walk" ? "walk" : "idle";
      if (want !== r.current) {
        const next = r.actions[want as Clip];
        if (next) {
          // exactly one target clip: every other running action fades out (rotations blended at a total weight > 1 over-rotate)
          // a clip still fading out is picked up where it is (reset() would jump its pose)
          if (!next.isRunning()) next.reset();
          // getting up from / down onto a chair blends longer, so the body rises while it is already clear of the cushion
          const fade = SEATED.has(r.current) !== SEATED.has(want) ? FADE_SEAT : FADE;
          for (const [name, a] of Object.entries(r.actions)) if (name !== want && a && a.isRunning()) a.fadeOut(fade);
          next.stopFading().setEffectiveTimeScale(want === "walk" ? r.walkRate : 1).fadeIn(fade).play();
          r.current = want;
        }
      }
      // paused: everyone holds still (the simulation is stopped too); reduced motion: no idle motion, walking still animates
      r.mixer.timeScale = paused ? 0 : reducedMotion && w.clip !== "walk" ? 0 : 1;
      r.mixer.update(Math.min(dt, 0.1));
      // a scaled person on the chair: lifted by seatLift() in proportion to how seated the current blend is
      if (r.scale !== 1) {
        let seated = 0;
        for (const a of r.seated) seated += a.getEffectiveWeight();
        r.root.position.y = seatLift(r.scale) * Math.min(1, seated);
      }
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
