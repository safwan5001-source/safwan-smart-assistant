/**
 * BASHT HQ — how a realistic person is played (pure helpers shared by the 3D layer and the tests).
 * The avatars and clip libraries come from tools/hq-assets/blender/build_humans.py (Microsoft Rocketbox, MIT).
 */
import type { Look } from "./roster";

type HumanLook = Extract<Look, { kind: "human" }>;

/** Clip tracks a person keeps: every joint's rotation, but translation only for the root and pelvis — bone lengths come
 *  from the avatar wearing the clip, not from the capture actor. Scale keys are never used. */
export const keepTrack = (name: string) => name.endsWith(".quaternion") || /^(RB_ROOT|Bip01_Pelvis)\.position$/.test(name);

/** Pelvis and ankle heights of the seated clips over the floor (build_humans.py: feet on the floor, hips on the 0.50 m
 *  chair cushion). */
export const SEAT_PELVIS = 0.6;
export const SEAT_ANKLE = 0.08;

/** Body proportions: the roster's height within a natural range of the avatar's own, and the roster's build as a small
 *  change of width and depth (±3–4 %: below what reads as a stretched face), so two people sharing an outfit avatar
 *  don't share a silhouette. */
export function bodyScale(look: HumanLook, avatarHeight: number) {
  const s = Math.min(1.03, Math.max(0.93, look.height / avatarHeight));
  const wide = look.build === "slim" ? 0.97 : look.build === "broad" ? 1.04 : 1;
  return { s, wide, x: s * wide, y: s, z: s * wide };
}

/** Seated lift for a scaled body: scaling about the floor lowers the hips by SEAT_PELVIS·(1−s) and the feet by
 *  SEAT_ANKLE·(1−s). Lifting by half the difference splits it: hips settle at most ~1.5 cm into the cushion and feet clear
 *  the floor by at most ~1.5 cm (instead of hips on the cushion and feet floating 3–5 cm). */
export const seatLift = (s: number) => 0.5 * (SEAT_PELVIS - SEAT_ANKLE) * (1 - s);

/** Playback rate of the in-place walk so the feet keep pace with the simulation. `stride` is the body's scale along the
 *  walking direction (height scale × build width): a smaller body takes shorter steps. */
export const walkRate = (simSpeed: number, captureSpeed: number, stride: number) => Math.min(1.6, Math.max(0.6, simSpeed / (captureSpeed * stride)));
