/**
 * Loading the generated HQ art (tools/hq-assets → public/hq-assets/<content-hash>/). Same-origin files only; the meshopt
 * decoder ships inside the three package (no CDN, no worker script from elsewhere).
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
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

/**
 * Textures are KTX2 / Basis Universal: the GPU keeps them compressed. One transcoder (2 workers, same origin — the files
 * ship next to the assets) per canvas, shared by the models and the lightmap; released when the HQ unmounts.
 */
let ktx2: { loader: KTX2Loader; gl: THREE.WebGLRenderer; ready: Promise<void> } | null = null;
function ensureKtx2(gl: THREE.WebGLRenderer) {
  if (!ktx2 || ktx2.gl !== gl) {
    ktx2?.loader.dispose();
    const transcoder = (ASSETS as { transcoder?: string }).transcoder ?? "basis/";
    const loader = new KTX2Loader().setTranscoderPath(assetUrl(transcoder)).setWorkerLimit(2).detectSupport(gl);
    // no WebAssembly (e.g. iOS Lockdown Mode) or no transcoder → reject, so the HQ shows its simplified scene instead of
    // untextured models (GLTFLoader would otherwise swallow the texture errors)
    const ready = typeof WebAssembly === "undefined"
      ? Promise.reject(new Error("WebAssembly unavailable: KTX2 textures cannot be decoded"))
      : loader.init().then(() => undefined);
    ready.catch(() => {}); // observed by the components through use(); avoid an unhandled-rejection report
    ktx2 = { loader, gl, ready };
  }
  return ktx2;
}
export const hqKtx2 = (gl: THREE.WebGLRenderer) => ensureKtx2(gl).loader;
/** Resolves once the texture transcoder is usable (for React `use()`; the same promise every render). */
export const hqKtx2Ready = (gl: THREE.WebGLRenderer) => ensureKtx2(gl).ready;
export function releaseHqKtx2() { ktx2?.loader.dispose(); ktx2 = null; }

/** R3F `useLoader` extension for the HQ GLBs: meshopt geometry + KTX2 textures. */
export const hqGltf = (gl: THREE.WebGLRenderer) => (l: GLTFLoader) => { l.setMeshoptDecoder(MeshoptDecoder); l.setKTX2Loader(hqKtx2(gl)); };

/** `useLoader` class for a standalone KTX2 texture (the lightmap) through the shared transcoder. */
export class HqKtx2TextureLoader extends THREE.Loader<THREE.CompressedTexture> {
  gl: THREE.WebGLRenderer | null = null;
  load(url: string, onLoad: (t: THREE.CompressedTexture) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void) {
    hqKtx2(this.gl!).load(url, onLoad as (t: THREE.CompressedTexture) => void, onProgress, onError);
  }
}
export type { GLTF };
