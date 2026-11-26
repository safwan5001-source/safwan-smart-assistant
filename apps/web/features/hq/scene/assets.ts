/**
 * Loading the generated HQ art (tools/hq-assets → public/hq-assets/<content-hash>/). Same-origin files only; the meshopt
 * decoder ships inside the three package (no CDN, no worker script from elsewhere).
 */
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { HQ_ASSETS } from "@/lib/hq/assets.generated";
import { AGENT_IDS, type AgentId } from "@/lib/hq/roster";

export const ASSETS = HQ_ASSETS;
export const assetUrl = (file: string) => ASSETS.base + file;
export const characterUrl = (id: AgentId) => assetUrl(ASSETS.characters[id].file);

type CharacterEntry = { kind: "authored" | "human"; file: string; anims?: string; height?: number };
type AnimLib = { file: string; clips: readonly string[]; walkSpeed: number };
const LIBS: Readonly<Record<string, AnimLib>> = ASSETS.anims;
export const characterEntry = (id: AgentId): CharacterEntry => ASSETS.characters[id];
/** Shared motion-capture clip libraries (one per skeleton), in a fixed order. */
export const ANIM_LIBS = Object.keys(LIBS).sort();
export const animLib = (key: string) => LIBS[key];
/** Everything the people layer loads, as ONE useLoader key: the 14 characters, then the clip libraries. */
export const PEOPLE_URLS = [...AGENT_IDS.map(characterUrl), ...ANIM_LIBS.map((k) => assetUrl(animLib(k).file))];

let loader: GLTFLoader | null = null;
/** R3F `useLoader` extension: one GLTFLoader with the meshopt decoder. */
export const withMeshopt = (l: GLTFLoader) => { l.setMeshoptDecoder(MeshoptDecoder); };
export function gltfLoader() {
  if (!loader) { loader = new GLTFLoader(); withMeshopt(loader); }
  return loader;
}
export type { GLTF };
