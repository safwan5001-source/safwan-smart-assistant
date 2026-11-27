"use client";
/**
 * The characters: BASHT is the authored robot (its clips ride in its own GLB); the 13 people are realistic avatars
 * (Microsoft Rocketbox, MIT) that share one motion-capture clip library per skeleton. Positions come from the simulation
 * every frame; the simulation's clip picks the animation, cross-faded so nobody pops between poses.
 */
import { use, useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AGENTS, AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import { WALK_SPEED, type Clip, type HqSim } from "@/lib/hq/sim";
import { bodyScale, keepTrack, seatLift, walkRate as rateFor } from "@/lib/hq/people";
import { ANIM_LIBS, PEOPLE_URLS, animLib, characterEntry, hqGltf, hqKtx2Ready } from "./assets";

const FADE = 0.28;
const FADE_SEAT = 0.5;
/** into / out of a get-up or sit-down take: short, the take itself carries the motion */
const FADE_TAKE = 0.15;
/** takes played once and held on their last frame: getting up (up_l/up_r) and sitting down (down_l/down_r) */
const ONE_SHOT = /^(up|down)_[lr]$/;
const MOVING_CLIPS = new Set<string>(["walk", "rise", "settle"]);
/** Summed weight of the actions that are actually playing (an action that never played reports weight 1). */
function scheduledWeight(actions: THREE.AnimationAction[]) {
  let k = 0;
  for (const a of actions) if (a.isScheduled()) k += a.getEffectiveWeight();
  return k;
}
/** how fast a person turns to a new heading (rad/s) */
const TURN_RATE = 7;
/** meeting attention: seconds per speaker, the furthest a head turns (rad, ≈ 35°) and how fast (rad/s) */
const SPEAK_TURN = 4;
const LOOK_MAX = 0.6;
const LOOK_RATE = 2.2;
const _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _axis = new THREE.Vector3();
/** Rotate a bone about the world's vertical, on top of whatever the animation set this frame. */
function turnAboutWorldUp(bone: THREE.Object3D, angle: number) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_pq);
  _axis.copy(_up).applyQuaternion(_pq.invert()); // world up in the parent's frame
  bone.quaternion.premultiply(_q.setFromAxisAngle(_axis, angle));
}
const SEATED = new Set<string>(["sit", "type", "talk"]);

/**
 * Clothes and furniture: while a person is seated, cloth that would hang through the chair cushion lies on it, and a
 * drape that would pass through the backrest stays in front of it — a few lines in the vertex shader, in the chair's own
 * frame (the HQ office / meeting chair, tools/hq-assets/blender/build_building.py: cushion top 0.50 m, cushion
 * x ±0.24 z −0.22…0.24, backrest z −0.27…−0.19 up to ~1.0 m), weighted by how seated the current blend is. No cloth
 * simulation: the hem simply never shows through the furniture.
 */
const SEAT_GLSL = /* glsl */ `
#ifdef HQ_SEAT
if (uSeatW > 0.0) {
  vec3 sp = (uSeatFromLocal * vec4(transformed, 1.0)).xyz;
  // hanging below the cushion (feet, near the floor, and the knees' zone in front are left alone)
  if (abs(sp.x) < 0.26 && sp.z > -0.25 && sp.z < 0.2 && sp.y > 0.2 && sp.y < 0.505) sp.y = mix(sp.y, 0.505, uSeatW);
  // behind the backrest's front face
  if (abs(sp.x) < 0.25 && sp.y > 0.5 && sp.y < 1.1 && sp.z < -0.175 && sp.z > -0.4) sp.z = mix(sp.z, -0.175, uSeatW);
  transformed = (uLocalFromSeat * vec4(sp, 1.0)).xyz;
}
#endif
`;

type SeatUniforms = { uSeatW: { value: number }; uSeatFromLocal: { value: THREE.Matrix4 }; uLocalFromSeat: { value: THREE.Matrix4 } };

type Rig = {
  root: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Partial<Record<string, THREE.AnimationAction>>; current: string;
  /** uniform body scale (roster height) and the lift that keeps a scaled person on the chair cushion */
  scale: number; walkRate: number;
  /** the seated clips' actions (their summed weight scales the seat lift) and every skeleton this mount owns */
  seated: THREE.AnimationAction[]; skeletons: THREE.Skeleton[];
  /** last simulated floor position, the facing shown (eased), and the pending hand-over offset (see useFrame) */
  lastPos: [number, number]; yaw: number; comp: { x: number; z: number; action: THREE.AnimationAction } | null;
  /** cloth-vs-chair: the person's shader uniforms, a mesh to read the world matrix from, and the chair last sat on */
  seat: { uniforms: SeatUniforms; mesh: THREE.Object3D; at: [number, number]; yaw: number; actions: THREE.AnimationAction[] } | null;
  /** attention: the head and neck bones and how far the head is turned now (eased) */
  look: { head: THREE.Object3D; neck: THREE.Object3D | null; yaw: number } | null;
  pelvis: THREE.Object3D | null;
};

export default function PeopleGlb({ sim, paused, reducedMotion }: { sim: HqSim; paused: boolean; reducedMotion: boolean }) {
  const gl = useThree((s) => s.gl);
  use(hqKtx2Ready(gl)); // throws to the simplified scene if textures cannot be decoded
  const loaded = useLoader(GLTFLoader, PEOPLE_URLS, hqGltf(gl));
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
      const uniforms: SeatUniforms = { uSeatW: { value: 0 }, uSeatFromLocal: { value: new THREE.Matrix4() }, uLocalFromSeat: { value: new THREE.Matrix4() } };
      let seatMesh: THREE.Object3D | null = null;
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isMesh) {
          m.frustumCulled = false; // skinned bounds don't follow the pose; 14 small meshes are cheap to always draw
          for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
            if (human) {
              mat.envMapIntensity = 0.7; // scanned-style textures carry their own shading
              // the person's materials are their own (one GLB each): give them the chair-aware vertex step once
              if (!mat.userData.hqSeat) {
                mat.userData.hqSeat = uniforms;
                mat.defines = { ...(mat.defines ?? {}), HQ_SEAT: "" };
                mat.onBeforeCompile = (sh) => {
                  Object.assign(sh.uniforms, mat.userData.hqSeat as SeatUniforms);
                  sh.vertexShader = "uniform float uSeatW;\nuniform mat4 uSeatFromLocal;\nuniform mat4 uLocalFromSeat;\n" +
                    sh.vertexShader.replace("#include <skinning_vertex>", "#include <skinning_vertex>\n" + SEAT_GLSL);
                };
                mat.customProgramCacheKey = () => "hq-seat";
                mat.needsUpdate = true;
              } else Object.assign(uniforms, mat.userData.hqSeat); // a remount shares the material: reuse its uniforms
              seatMesh ??= m;
              continue;
            }
            mat.roughness = 0.68; mat.metalness = 0;
            if (mat.name.endsWith("_glow")) { mat.emissive.set("#22d3ee"); mat.emissiveIntensity = 1.6; mat.toneMapped = false; } // BASHT's eyes
          }
        }
      });
      const mixer = new THREE.AnimationMixer(model);
      const actions: Rig["actions"] = {};
      for (const clip of human ? libs[entry.anims!] : g.animations) {
        const a = mixer.clipAction(clip);
        if (ONE_SHOT.test(clip.name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        actions[clip.name as Clip] = a;
      }
      const start = actions.sit ?? actions.idle;
      start?.play();
      // the capture walks at its own pace: play it at the simulation's speed so feet don't slide
      const walkRate = human ? rateFor(WALK_SPEED, animLib(entry.anims!).walkSpeed, body ? body.z : 1) : 1;
      actions.walk?.setEffectiveTimeScale(walkRate);
      const skeletons = new Set<THREE.Skeleton>();
      model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton); });
      const seated = Object.entries(actions).filter(([n, a]) => a && SEATED.has(n)).map(([, a]) => a!);
      const w0 = sim.walkers[id];
      const headBone = human ? model.getObjectByName("Bip01_Head") : undefined;
      // the chair-aware vertex step follows the SEATED clips only (the get-up / sit-down takes move past the chair)
      out[id] = { root, mixer, actions, current: start === actions.sit ? "sit" : "idle", scale, walkRate, seated, skeletons: [...skeletons],
        lastPos: [w0.pos[0], w0.pos[1]], yaw: w0.yaw, comp: null,
        seat: human && seatMesh ? { uniforms, mesh: seatMesh, at: [w0.pos[0], w0.pos[1]], yaw: w0.yaw, actions: seated } : null,
        pelvis: human ? model.getObjectByName("Bip01_Pelvis") ?? null : null,
        look: headBone ? { head: headBone, neck: model.getObjectByName("Bip01_Neck") ?? null, yaw: 0 } : null };
      // de-synchronise idle loops
      mixer.setTime(i * 0.37);
    });
    return out;
  }, [loaded, sim]);
  useEffect(() => () => {
    for (const id of AGENT_IDS) {
      const r = rigs[id];
      r.mixer.stopAllAction();
      r.mixer.uncacheRoot(r.root.children[0]);
      for (const sk of r.skeletons) sk.dispose(); // the per-mount bone textures (geometry/materials stay with the loader cache)
    }
    shadowTex.dispose();
  }, [rigs, shadowTex]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Matrix4(), seat: new THREE.Matrix4(), v: new THREE.Vector3() }), []);
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1);
    // a meeting has a speaker (turns every few seconds, from the simulation clock: same for every viewer); the others
    // turn their heads to them, the speaker to BASHT
    const meeting = AGENT_IDS.filter((a) => sim.walkers[a].status === "meeting" && sim.walkers[a].phase === "seated");
    const speaker = meeting.length > 1 ? meeting[Math.floor(sim.t / SPEAK_TURN) % meeting.length] : null;
    for (const id of AGENT_IDS) {
      const w = sim.walkers[id], r = rigs[id];
      // which take to play: getting up / sitting down use the take for the chair side the simulation chose
      const named = w.clip === "rise" ? `up_${w.side}` : w.clip === "settle" ? `down_${w.side}` : w.clip;
      const want = named in r.actions ? named : w.clip === "walk" ? "walk" : w.clip === "rise" || w.clip === "settle" ? (r.actions.sit ? "sit" : "idle") : "idle";
      if (want !== r.current) {
        const next = r.actions[want as Clip];
        if (next) {
          const prev = r.actions[r.current as Clip];
          const oneShot = ONE_SHOT.test(want);
          // exactly one target clip: every other running action fades out (rotations blended at a total weight > 1 over-rotate)
          // a looping clip still fading out is picked up where it is (reset() would jump its pose); a one-shot take
          // (getting up / sitting down) always plays from its start
          if (!next.isRunning() || oneShot) next.reset();
          // the robot (no takes) blends between seated and walking a little longer
          const fade = oneShot || ONE_SHOT.test(r.current) ? FADE_TAKE
            : SEATED.has(r.current) !== SEATED.has(want) ? FADE_SEAT : FADE;
          for (const [name, a] of Object.entries(r.actions)) if (name !== want && a && a.isScheduled()) a.fadeOut(fade); // incl. a finished (clamped) take
          next.stopFading().setEffectiveTimeScale(want === "walk" ? r.walkRate : 1).fadeIn(fade).play();
          // the simulation hands over between the seat and the standing point in one step (the take carries the body
          // there): while the outgoing take still shows, hold the body where it was
          const jx = w.pos[0] - r.lastPos[0], jz = w.pos[1] - r.lastPos[1];
          const take = ONE_SHOT.test(want) || ONE_SHOT.test(r.current), jump = Math.hypot(jx, jz);
          if (prev && take && jump > 0.05 && jump < 1.5) r.comp = { x: jx, z: jz, action: prev };
          else r.comp = null;
          r.current = want;
        }
      }
      r.lastPos[0] = w.pos[0]; r.lastPos[1] = w.pos[1];
      // paused: everyone holds still (the simulation is stopped too); reduced motion: no idle motion, but moving from
      // place to place (walking, getting up, sitting down) still animates
      r.mixer.timeScale = paused ? 0 : reducedMotion && !MOVING_CLIPS.has(w.clip) ? 0 : 1;
      r.mixer.update(step);
      let cx = 0, cz = 0;
      if (r.comp) {
        const k = r.comp.action.getEffectiveWeight();
        if (k <= 0.001) r.comp = null;
        else { cx = -r.comp.x * k; cz = -r.comp.z * k; }
      }
      r.root.position.x = w.pos[0] + cx;
      r.root.position.z = w.pos[1] + cz;
      // turn smoothly (the simulation's heading changes in steps at corners, chairs and seats)
      let takeShown = false;
      for (const [name, a] of Object.entries(r.actions)) if (a && ONE_SHOT.test(name) && a.isScheduled() && a.getEffectiveWeight() > 0.02) takeShown = true;
      if (w.clip === "settle" && r.current.startsWith("down_")) r.yaw = w.yaw; // the take starts facing the approach
      const dy = takeShown ? 0 : Math.atan2(Math.sin(w.yaw - r.yaw), Math.cos(w.yaw - r.yaw));
      const maxTurn = TURN_RATE * (paused ? 0 : step);
      r.yaw += Math.abs(dy) <= maxTurn ? dy : Math.sign(dy) * maxTurn;
      r.root.rotation.y = r.yaw;
      // a scaled person on the chair: lifted by seatLift() in proportion to how seated the current blend is
      if (r.scale !== 1) {
        let seated = 0;
        seated = scheduledWeight(r.seated);
        r.root.position.y = seatLift(r.scale) * Math.min(1, seated);
      }
      // attention: added on top of the capture's own head motion, eased, and never more than a natural neck turn
      if (r.look) {
        let want = 0;
        const target = speaker && meeting.includes(id) ? (speaker === id ? (id === "BASHT" ? null : "BASHT") : speaker) : null;
        if (target && w.clip === "talk") {
          const tw = sim.walkers[target];
          const toward = Math.atan2(tw.pos[0] - w.pos[0], tw.pos[1] - w.pos[1]);
          want = THREE.MathUtils.clamp(Math.atan2(Math.sin(toward - r.yaw), Math.cos(toward - r.yaw)), -LOOK_MAX, LOOK_MAX);
        }
        const d = want - r.look.yaw, m = LOOK_RATE * (paused ? 0 : step);
        r.look.yaw += Math.abs(d) <= m ? d : Math.sign(d) * m;
        if (Math.abs(r.look.yaw) > 1e-3) {
          r.root.updateMatrixWorld(true);
          turnAboutWorldUp(r.look.head, r.look.yaw * (r.look.neck ? 0.65 : 1));
          if (r.look.neck) turnAboutWorldUp(r.look.neck, r.look.yaw * 0.35);
        }
      }
      // cloth vs. chair: the chair is where the person last sat (it stays there while they get up and walk off)
      if (r.seat) {
        const st = r.seat;
        if (w.seated || w.phase === "rising" || w.phase === "settling") { st.at[0] = w.pos[0]; st.at[1] = w.pos[1]; st.yaw = w.yaw; }
        let k = 0;
        k = scheduledWeight(st.actions);
        st.uniforms.uSeatW.value = Math.min(1, k);
        if (k > 0) {
          r.root.updateMatrixWorld(true);
          tmp.seat.makeRotationY(st.yaw).setPosition(st.at[0], 0, st.at[1]).invert();
          st.uniforms.uSeatFromLocal.value.multiplyMatrices(tmp.seat, st.mesh.matrixWorld);
          st.uniforms.uLocalFromSeat.value.copy(st.uniforms.uSeatFromLocal.value).invert();
        }
      }
    }
    const sh = shadows.current;
    if (sh) {
      AGENT_IDS.forEach((id, i) => {
        tmp.s.makeScale(id === "BASHT" ? 1.15 : 0.95, 1, id === "BASHT" ? 1.15 : 0.95);
        // under the body as drawn: a get-up / sit-down take moves the hips away from the simulated spot
        const r = rigs[id], p = r.pelvis ? r.pelvis.getWorldPosition(tmp.v) : r.root.position;
        tmp.m.makeTranslation(p.x, 0.025, p.z).multiply(tmp.s);
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
