"use client";
/**
 * The authored HQ building (Blender → GLB, one mesh per material). Static surfaces use the Cycles-baked lightmap with an
 * unlit material: realistic soft light and contact shadows at the cost of a texture lookup — no lights to compute on the
 * phone. Glass stays a lit, transparent material; screens and cove strips glow and brighten at night.
 */
import { use, useEffect, useMemo } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { BRAND_ASSETS } from "@/lib/brand";
import { FURNITURE } from "@/lib/hq/layout";
import { ASSETS, HqKtx2TextureLoader, assetUrl, hqGltf, hqKtx2Ready } from "./assets";

const EMISSIVE = new Set(["screen", "glow"]);
/**
 * three's basic material applies lightMap × intensity × 1/π. The bake is normalised to its 99.5th percentile
 * (ASSETS.building.lightmapScale), so π × scale restores the baked radiance; LIGHTMAP_GAIN is the art-directed exposure
 * that balances baked surfaces against the live-lit characters (tuned visually, ≈ ACES exposure at the previous look).
 */
const LIGHTMAP_GAIN = 0.4;
const lmIntensity = (k = 1) => ASSETS.building.lightmapScale * Math.PI * LIGHTMAP_GAIN * k;

export default function BuildingGlb({ night }: { night: boolean }) {
  const gl = useThree((s) => s.gl);
  use(hqKtx2Ready(gl)); // throws to the simplified scene if textures cannot be decoded
  const gltf = useLoader(GLTFLoader, assetUrl(ASSETS.building.file), hqGltf(gl));
  const lightmap = useLoader(HqKtx2TextureLoader, assetUrl(ASSETS.building.lightmap), (l) => { l.gl = gl; });
  const logo = useLoader(THREE.TextureLoader, BRAND_ASSETS.logo);

  const { scene, mats } = useMemo(() => {
    lightmap.colorSpace = THREE.SRGBColorSpace;
    lightmap.channel = 1; // TEXCOORD_1 = the baked atlas (KTX2 rows run top-down: the glTF UV convention, no flip)
    lightmap.anisotropy = 4;
    const mats: { basic: THREE.MeshBasicMaterial[]; emissive: THREE.MeshBasicMaterial[]; lit: THREE.MeshStandardMaterial[] } = { basic: [], emissive: [], lit: [] };
    // the loader caches the parsed glTF: work on a clone (shared geometry, our own materials) so a remount is clean
    const scene = gltf.scene.clone(true);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = (mesh.material as THREE.MeshStandardMaterial).clone();
      const name = src.name;
      if (name === "glass") {
        const g = new THREE.MeshStandardMaterial({ name, color: src.color, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.15, depthWrite: false, side: THREE.DoubleSide });
        mats.lit.push(g);
        mesh.material = g;
        mesh.renderOrder = 2;
      } else if (EMISSIVE.has(name)) {
        const m = new THREE.MeshBasicMaterial({ name, color: src.emissive.clone().multiplyScalar(name === "glow" ? 1.0 : 0.9), toneMapped: false });
        mats.emissive.push(m);
        mesh.material = m;
      } else if (mesh.geometry.attributes.uv1) {
        // large surface with a baked lightmap: unlit × baked light
        // surface texture (marble / oak / carpet tiles) × colour × baked light
        if (src.map) { src.map.anisotropy = 8; src.map.colorSpace = THREE.SRGBColorSpace; }
        const m = new THREE.MeshBasicMaterial({ name, color: src.color, map: src.map, lightMap: lightmap, lightMapIntensity: lmIntensity() });
        mats.basic.push(m);
        mesh.material = m;
      } else {
        // small detailed props (leaves, books, trims, chairs): lit live, reflecting the room environment
        src.envMapIntensity = name === "gold" ? 1.1 : 0.55;
        if (name === "gold") { src.metalness = 0.85; src.roughness = 0.3; }
        mats.lit.push(src);
        mesh.material = src;
        return mesh.matrixAutoUpdate = false, mesh.updateMatrix();
      }
      if (mesh.material !== src) src.dispose();
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    });
    return { scene, mats };
  }, [gltf, lightmap]);

  useEffect(() => {
    const k = night ? 0.32 : 1;
    for (const m of mats.basic) m.lightMapIntensity = lmIntensity(k);
    for (const m of mats.lit) if (m.name !== "glass") m.envMapIntensity = (m.name === "gold" ? 1.1 : 0.55) * (night ? 0.45 : 1);
    for (const m of mats.emissive) if (m.name === "glow") m.color.setRGB(1.0, 0.82, 0.48).multiplyScalar(night ? 1.6 : 0.85);
  }, [night, mats]);
  // our materials go with this mount; the cached glTF itself is released when the HQ unmounts (hq-canvas)
  useEffect(() => () => { for (const m of [...mats.basic, ...mats.emissive, ...mats.lit]) m.dispose(); }, [mats]);

  // official logo on the executive brand wall (original asset, never redrawn)
  const brand = FURNITURE.find((f) => f.kind === "brand-wall")!;
  const logoMat = useMemo(() => { logo.colorSpace = THREE.SRGBColorSpace; return new THREE.MeshBasicMaterial({ map: logo, transparent: true, toneMapped: false }); }, [logo]);
  useEffect(() => () => logoMat.dispose(), [logoMat]);
  return (
    <group>
      <primitive object={scene} />
      <mesh material={logoMat} position={[brand.at[0], 0.14, brand.at[1]]} rotation-y={brand.yaw}>
        <planeGeometry args={[1.3, 1.65]} onUpdate={(g) => g.translate(0, 1.35, brand.d / 2 + 0.014)} />
      </mesh>
    </group>
  );
}
