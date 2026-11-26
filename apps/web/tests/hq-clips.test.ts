import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { HQ_ASSETS } from "@/lib/hq/assets.generated";
import { AGENT_IDS } from "@/lib/hq/roster";
import { keepTrack, walkRate } from "@/lib/hq/people";

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
  it("sit on the HQ chair: feet on the floor, pelvis just above the 0.50 m cushion, knees past its front edge", () => {
    for (const [k, g] of Object.entries(parsed)) {
      const stand = pose(g, "idle", 0).ankle;
      for (const clip of ["sit", "type", "talk"]) for (const t of [0, 1.5, 3]) {
        const p = pose(g, clip, t);
        expect(Math.abs(p.ankle - stand), `${k} ${clip} @${t}s feet vs floor`).toBeLessThan(0.04);
        expect(p.pelvis.y, `${k} ${clip} pelvis height`).toBeGreaterThan(0.56);
        expect(p.pelvis.y, `${k} ${clip} pelvis height`).toBeLessThan(0.66);
        expect(p.knee.z, `${k} ${clip} knees forward of the chair centre`).toBeGreaterThan(0.2); // the person faces +z
        expect(Math.abs(p.knee.x), `${k} ${clip} centred on the chair`).toBeLessThan(0.06);
        expect(p.pelvis.z, `${k} ${clip} hips over the cushion`).toBeLessThan(0.05);
        expect(p.pelvis.z, `${k} ${clip} hips over the cushion`).toBeGreaterThan(-0.2);
      }
    }
  });
  it("walk in place at the simulation's pace (any body scale keeps the stride matched)", () => {
    for (const [k, g] of Object.entries(parsed)) {
      const a = pose(g, "walk", 0).pelvis, b = pose(g, "walk", 0.5).pelvis;
      expect(Math.hypot(a.x - b.x, a.z - b.z), `${k} root stays in place`).toBeLessThan(0.05);
      expect(libs[k].walkSpeed).toBeGreaterThan(1.1);
      for (const s of [0.93, 1, 1.03]) expect(walkRate(1.35, libs[k].walkSpeed, s) * libs[k].walkSpeed * s).toBeCloseTo(1.35, 2);
    }
  });
});
