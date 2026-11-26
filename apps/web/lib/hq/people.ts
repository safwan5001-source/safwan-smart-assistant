/**
 * BASHT HQ — how a realistic person is played (pure helpers shared by the 3D layer and the tests).
 * The avatars and clip libraries come from tools/hq-assets/blender/build_humans.py (Microsoft Rocketbox, MIT).
 */
import type { Look } from "./roster";

type HumanLook = Extract<Look, { kind: "human" }>;

/** Clip tracks a person keeps: every joint's rotation, but translation only for the root and pelvis — bone lengths come
 *  from the avatar wearing the clip, not from the capture actor. Scale keys are never used. */
export const keepTrack = (name: string) => name.endsWith(".quaternion") || /^(RB_ROOT|Bip01_Pelvis)\.position$/.test(name);

/** Pelvis height of the seated clips over the floor (build_humans.py places them on the 0.50 m chair cushion). */
export const SEAT_PELVIS = 0.6;

/** Body proportions: the roster's height within a natural range of the avatar's own (no stretched faces), and the
 *  roster's build as a modest change of width and depth, so two people sharing an outfit avatar don't share a body. */
export function bodyScale(look: HumanLook, avatarHeight: number) {
  const s = Math.min(1.03, Math.max(0.93, look.height / avatarHeight));
  const wide = look.build === "slim" ? 0.95 : look.build === "broad" ? 1.06 : 1;
  return { s, wide, x: s * wide, y: s, z: s * wide };
}

/** Playback rate of the in-place walk so the feet keep pace with the simulation (a smaller body takes shorter steps). */
export const walkRate = (simSpeed: number, captureSpeed: number, s: number) => Math.min(1.6, Math.max(0.6, simSpeed / (captureSpeed * s)));
