/**
 * BASHT HQ — sitting down and getting up (data from the motion-capture build, tools/hq-assets/blender/build_humans.py).
 * A person gets up sideways out of the chair (the take carries its own travel), so walking starts where the take leaves
 * them; and walks to the side of the chair, from where the sit-down take carries them onto it. Pure + deterministic: the
 * simulation and the renderer both read these numbers.
 */
import { HQ_ASSETS } from "./assets.generated";
import { AGENTS, type AgentId } from "./roster";
import { bodyScale } from "./people";
import type { Vec2 } from "./layout";

export type Side = "l" | "r";
export type Transition = { seconds: number; stand: readonly [number, number]; yaw: number };
type Lib = { transitions?: Readonly<Record<string, Transition>> };
type Entry = { kind: string; anims?: string; height?: number };

export type PersonTransitions = { up: Record<Side, Transition>; down: Record<Side, Transition>; k: number };

/** The person's transitions (scaled to their body), or null for someone without them (the BASHT robot). */
export function transitionsFor(id: AgentId): PersonTransitions | null {
  const e = (HQ_ASSETS.characters as Readonly<Record<string, Entry>>)[id];
  const lib = e?.anims ? (HQ_ASSETS as unknown as { anims: Readonly<Record<string, Lib>> }).anims[e.anims] : undefined;
  const t = lib?.transitions;
  if (!t?.up_l || !t.up_r || !t.down_l || !t.down_r) return null;
  const look = AGENTS[id].look;
  const k = look.kind === "human" && e.height ? bodyScale(look, e.height).x : 1;
  return { up: { l: t.up_l, r: t.up_r }, down: { l: t.down_l, r: t.down_r }, k };
}

/** Seat-local (x to the seated person's left, z towards the desk) → world floor offset for a seat facing `yaw`. */
export const seatToWorld = (local: readonly [number, number], yaw: number, k = 1): Vec2 =>
  [(local[0] * Math.cos(yaw) + local[1] * Math.sin(yaw)) * k, (-local[0] * Math.sin(yaw) + local[1] * Math.cos(yaw)) * k];

/** Which side of the seat a floor direction points to: "l" = the seated person's left. */
export const sideOf = (dir: Vec2, yaw: number): Side => (dir[0] * Math.cos(yaw) - dir[1] * Math.sin(yaw) >= 0 ? "l" : "r");
