import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { HQ_ASSETS } from "@/lib/hq/assets.generated";
import { AGENT_IDS } from "@/lib/hq/roster";
import { keepTrack, seatLift, walkRate } from "@/lib/hq/people";

/**
 * The motion the people actually play: decodes the shipped clip libraries (meshopt) and checks what a viewer would see —
 * every joint driven, loops that wrap without a snap, seated feet on the floor with the knees over the cushion's edge.
 */
const PUB = resolve(__dirname, "../public");
const libs = HQ_ASSETS.anims as Readonly<Record<string, { file: string; walkSpeed: number }>>;
const glbJson = (f: string) => { const b = readFileSync(f); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8")); };
const parsed: Record<string, GLTF> = {};

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  for (const [k, lib] of Object.entries(libs)) {
    const b = readFileSync(join(PUB, HQ_ASSETS.base, lib.file));
    parsed[k] = await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
  }
});

const pose = (g: GLTF, clip: string, t: number) => {
  const c = g.animations.find((a) => a.name === clip)!;
  const scene = g.scene;
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((tr) => keepTrack(tr.name)))).play();
  mixer.setTime(t);
  scene.updateMatrixWorld(true);
  const at = (n: string) => scene.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
  const out = { ankle: Math.min(at("Bip01_L_Foot").y, at("Bip01_R_Foot").y), knee: at("Bip01_L_Calf").add(at("Bip01_R_Calf")).multiplyScalar(0.5), pelvis: at("Bip01_Pelvis") };
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  return out;
};

describe("HQ people — motion-capture clips as played", () => {
  it("drive every joint of every person's skeleton in every clip (no joint left in the avatar's bind pose)", () => {
    for (const id of AGENT_IDS.filter((i) => i !== "BASHT")) {
      const e = HQ_ASSETS.characters[id] as { file: string; anims?: string };
      const joints = glbJson(join(PUB, HQ_ASSETS.base, e.file)).nodes.map((n: { name?: string }) => n.name ?? "")
        .filter((n: string) => n.startsWith("Bip01 ") && !n.endsWith("Nub")).map((n: string) => n.replace(/ /g, "_"));
      for (const clip of parsed[e.anims!].animations) {
        const have = new Set(clip.tracks.filter((t) => t.name.endsWith(".quaternion")).map((t) => t.name.split(".")[0]));
        expect(joints.filter((j: string) => !have.has(j)), `${id} ${clip.name}`).toEqual([]);
      }
    }
  });
  it("loop without a visible snap: each joint's last rotation is within 3° of its first", () => {
    for (const [k, g] of Object.entries(parsed)) for (const clip of g.animations) {
      for (const t of clip.tracks) {
        if (!t.name.endsWith(".quaternion")) continue;
        const v = t.values, n = v.length;
        const a = new THREE.Quaternion().fromArray(v, 0), b = new THREE.Quaternion().fromArray(v, n - 4);
        expect(THREE.MathUtils.radToDeg(a.angleTo(b)), `${k} ${clip.name} ${t.name}`).toBeLessThan(3);
      }
    }
  });
  it("sit on the HQ chair at every body scale the app uses: feet on the floor, hips on the 0.50 m cushion, knees past its front edge, back clear of the backrest", () => {
    for (const [k, g] of Object.entries(parsed)) {
      const stand = pose(g, "idle", 0).ankle;
      for (const clip of ["sit", "type", "talk"]) for (const t of [0, 1.5, 3, 5]) {
        const p = pose(g, clip, t);
        for (const s of [0.93, 1, 1.03]) { // people-glb: model scaled about the floor by s, root lifted by seatLift(s)
          const lift = seatLift(s);
          expect(Math.abs(p.ankle * s + lift - stand * s), `${k} ${clip} @${t}s ×${s} feet vs floor`).toBeLessThan(0.035);
          expect(p.pelvis.y * s + lift, `${k} ${clip} ×${s} pelvis on the cushion`).toBeGreaterThan(0.55);
          expect(p.pelvis.y * s + lift, `${k} ${clip} ×${s} pelvis on the cushion`).toBeLessThan(0.66);
        }
        // the person faces +z; chair (build_building.py): cushion z −0.22…0.24, backrest z −0.27…−0.19
        expect(p.knee.z, `${k} ${clip} knees past the cushion's front edge`).toBeGreaterThan(0.24);
        expect(Math.abs(p.knee.x), `${k} ${clip} centred on the chair`).toBeLessThan(0.06);
        expect(p.pelvis.z - 0.14, `${k} ${clip} seat of the hips on the cushion, in front of the backrest`).toBeGreaterThan(-0.24);
        expect(p.pelvis.z, `${k} ${clip} hips over the cushion`).toBeLessThan(0.12);
      }
    }
  });
  it("walk in place at the simulation's pace: the planted foot slides back at the manifest's capture speed", () => {
    for (const [k, g] of Object.entries(parsed)) {
      const clip = g.animations.find((a) => a.name === "walk")!;
      const a = pose(g, "walk", 0).pelvis, b = pose(g, "walk", clip.duration / 2).pelvis;
      expect(Math.hypot(a.x - b.x, a.z - b.z), `${k} root stays in place`).toBeLessThan(0.05);
      // measure the capture speed independently: while a foot is planted (lowest), it moves backwards at walking speed
      const n = 40, dt = clip.duration / n, samples: { y: number; z: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const c = g.animations.find((x) => x.name === "walk")!;
        const mixer = new THREE.AnimationMixer(g.scene);
        mixer.clipAction(new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((tr) => keepTrack(tr.name)))).play();
        mixer.setTime(i * dt);
        g.scene.updateMatrixWorld(true);
        const f = g.scene.getObjectByName("Bip01_L_Foot")!.getWorldPosition(new THREE.Vector3());
        samples.push({ y: f.y, z: f.z });
        mixer.stopAllAction(); mixer.uncacheRoot(g.scene);
      }
      const low = Math.min(...samples.map((q) => q.y));
      const speeds: number[] = [];
      for (let i = 1; i < samples.length; i++)
        if (samples[i].y < low + 0.015 && samples[i - 1].y < low + 0.015) speeds.push(Math.abs(samples[i].z - samples[i - 1].z) / dt);
      expect(speeds.length, `${k} planted samples`).toBeGreaterThan(5);
      const measured = speeds.reduce((x, y) => x + y, 0) / speeds.length;
      expect(measured / libs[k].walkSpeed, `${k} measured ${measured.toFixed(2)} m/s vs manifest ${libs[k].walkSpeed}`).toBeGreaterThan(0.85);
      expect(measured / libs[k].walkSpeed, `${k} measured ${measured.toFixed(2)} m/s vs manifest ${libs[k].walkSpeed}`).toBeLessThan(1.15);
      // and the app's playback rate turns that into the simulation's 1.35 m/s for any stride scale
      for (const s of [0.9, 1, 1.07]) expect(walkRate(1.35, libs[k].walkSpeed, s) * libs[k].walkSpeed * s).toBeCloseTo(1.35, 2);
    }
  });
});
