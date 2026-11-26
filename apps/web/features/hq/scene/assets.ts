/**
 * Loading the generated HQ art (tools/hq-assets → public/hq-assets/<content-hash>/). Same-origin files only; the meshopt
 * decoder ships inside the three package (no CDN, no worker script from elsewhere).
 */
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { HQ_ASSETS } from "@/lib/hq/assets.generated";
import type { AgentId } from "@/lib/hq/roster";

export const ASSETS = HQ_ASSETS;
export const assetUrl = (file: string) => ASSETS.base + file;
export const characterUrl = (id: AgentId) => assetUrl(ASSETS.characters[id].file);

let loader: GLTFLoader | null = null;
/** R3F `useLoader` extension: one GLTFLoader with the meshopt decoder. */
export const withMeshopt = (l: GLTFLoader) => { l.setMeshoptDecoder(MeshoptDecoder); };
export function gltfLoader() {
  if (!loader) { loader = new GLTFLoader(); withMeshopt(loader); }
  return loader;
}
export type { GLTF };

