"use client";
/**
 * The 3D view of BASHT HQ (loaded on demand, client only). Owns the WebGL canvas, the camera, picking, adaptive quality and
 * the floating-name layer. Reads the simulation every frame; never writes to it.
 */
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import CameraControls from "camera-controls";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { AGENTS, AGENT_IDS, type AgentId } from "@/lib/hq/roster";
import { BUILDING, FRAMES, OFFICES, VIEWS, WALLS, ZONES, inward, type ViewId } from "@/lib/hq/layout";
import { labelSize, labelWidth, placeLabels, segmentHitsBox, type LabelBox } from "@/lib/hq/labels";
import type { HqSim } from "@/lib/hq/sim";
import { useHq, type HqStore } from "../hq-state";
import Building from "./building";
import People from "./people";
import BuildingGlb from "./building-glb";
import PeopleGlb from "./people-glb";
import { ASSETS, HqKtx2TextureLoader, PEOPLE_URLS, assetUrl, characterEntry, releaseHqKtx2 } from "./assets";
import { bodyScale } from "@/lib/hq/people";
import { BRAND_ASSETS } from "@/lib/brand";

CameraControls.install({ THREE });

type LabelRefs = { agents: Partial<Record<AgentId, HTMLSpanElement | null>>; rooms: (HTMLSpanElement | null)[] };
const ROOM_LABELS: { text: string; at: [number, number, number] }[] = [
  ...OFFICES.filter((o) => !o.exec).map((o) => {
    const f = FRAMES[o.id], d = inward(o.door);
    return { text: AGENTS[o.id].role, at: [f.door[0] - d[0] * 0.35, 2.85, f.door[1] - d[1] * 0.35] as [number, number, number] };
  }),
  { text: ZONES.meeting.label, at: [ZONES.meeting.doorAt, 2.4, ZONES.meeting.rect.z0] },
  { text: ZONES.library.label, at: [ZONES.library.doorAt + 3, 2.4, ZONES.library.rect.z0] },
  { text: ZONES.reception.label, at: [-9, 1.9, 13.2] },
  { text: ZONES.command.label, at: [0, 2.75, -5.0] },
];
/** Solid walls a name cannot be seen through (glass is see-through). Heights match the doll-house cut in building.tsx. */
const OCCLUDERS = WALLS.filter((w) => w.kind === "solid" || (w.kind === "exterior" && w.z0 <= BUILDING.z0 + 0.01))
  .map((w) => ({ x0: w.x0, x1: w.x1, y0: 0, y1: w.h, z0: w.z0, z1: w.z1 }));

export default function HqCanvas({ sim, store, onContextLost }: { sim: HqSim; store: HqStore; onContextLost: () => void }) {
  const ui = useHq(store, (s) => s);
  const labels = useRef<LabelRefs>({ agents: {}, rooms: [] });
  // a canvas that is being torn down (switch to plan, route change) is force-lost on purpose: not a failure
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [hidden, setHidden] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    // battery: stop rendering while the 3D view is scrolled out of sight (the panels below are long on a phone)
    const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting), { threshold: 0.02 });
    if (wrap.current) io.observe(wrap.current);
    return () => { document.removeEventListener("visibilitychange", on); io.disconnect(); };
  }, []);
  // leaving the HQ releases the parsed models and the lightmap held by the loader cache (they come back from the HTTP cache)
  useEffect(() => () => {
    // keys must match the useLoader calls exactly: the building alone, the people (characters + clip libraries) as ONE array,
    // the two textures
    useLoader.clear(GLTFLoader, assetUrl(ASSETS.building.file));
    useLoader.clear(GLTFLoader, PEOPLE_URLS);
    useLoader.clear(HqKtx2TextureLoader, assetUrl(ASSETS.building.lightmap));
    useLoader.clear(THREE.TextureLoader, BRAND_ASSETS.logo);
    releaseHqKtx2(); // the transcoder's workers
  }, []);
  const low = ui.quality === "low";
  const maxDpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);

  return (
    <div ref={wrap} className={"hq-canvas-wrap" + (ui.night ? " night" : "")}>
      <Canvas
        dpr={low ? 1 : [1, maxDpr]}
        gl={{ antialias: !low, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: false }}
        camera={{ fov: 38, near: 0.3, far: 220, position: [...VIEWS.overview.pos] }}
        frameloop={hidden || offscreen ? "never" : low ? "demand" : "always"}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          gl.toneMapping = THREE.NeutralToneMapping; // hue-preserving: brand purples stay purple (ACES shifts them to blue)
          gl.toneMappingExposure = 1.0;
          gl.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (mounted.current) onContextLost(); }, { once: true });
          gl.domElement.setAttribute("aria-label", "عرض ثلاثي الأبعاد للمقر — استخدم المخطط أو دليل الموظفين للتنقل بلوحة المفاتيح");
          gl.domElement.setAttribute("role", "img");
        }}
      >
        <Scene sim={sim} store={store} labels={labels} />
      </Canvas>
      <div className={"hq-labels" + (ui.labels ? "" : " off")} aria-hidden="true">
        {ROOM_LABELS.map((r, i) => (
          <span key={r.text} ref={(el) => { labels.current.rooms[i] = el; }} className="hq-room-label">{r.text}</span>
        ))}
        {AGENT_IDS.map((id) => (
          <span key={id} ref={(el) => { labels.current.agents[id] = el; }} className={"hq-name" + (id === "BASHT" ? " ceo" : "")}>{AGENTS[id].nameAr}</span>
        ))}
      </div>
    </div>
  );
}

/** Distance at which a w × h (metres, facing the camera) area fills the view, with a small margin. */
function fitDistance(w: number, h: number, cam: THREE.PerspectiveCamera, aspect: number) {
  const t = Math.tan(((cam.fov ?? 38) * Math.PI) / 360);
  return Math.max(h / 2 / t, w / 2 / (t * aspect)) * 1.08;
}

function Scene({ sim, store, labels }: { sim: HqSim; store: HqStore; labels: React.RefObject<LabelRefs> }) {
  const ui = useHq(store, (s) => s);
  const { camera, gl, invalidate, setDpr, size } = useThree();
  const [controls, setControls] = useState<CameraControls | null>(null);
  const hitGroup = useRef<THREE.Group>(null);
  const reduceMotion = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
  const debug = useMemo(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("hqdebug"), []);
  // soft studio reflections for gold, glass and lacquer — generated on the GPU once, no HDR file to download
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    pmrem.dispose();
    room.dispose();
    return () => { scene.environment = null; env.dispose(); };
  }, [gl, scene]);

  // camera controls + limits
  useEffect(() => {
    const controls = new CameraControls(camera, gl.domElement);
    setControls(controls);
    controls.minDistance = 3.5;
    controls.maxDistance = 75;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = 1.32;
    controls.smoothTime = reduceMotion ? 0 : 0.35;
    controls.dollyToCursor = true;
    controls.setBoundary(new THREE.Box3(new THREE.Vector3(BUILDING.x0 - 2, 0, BUILDING.z0 - 2), new THREE.Vector3(BUILDING.x1 + 2, 8, BUILDING.z1 + 2)));
    controls.addEventListener("control", () => invalidate());
    controls.addEventListener("update", () => invalidate());
    return () => { controls.dispose(); setControls(null); };
  }, [camera, gl, invalidate, reduceMotion]);

  // views and focus
  const aspect = size.width / Math.max(size.height, 1);
  useEffect(() => {
    if (!controls) return;
    const animate = !reduceMotion && ui.viewNonce > 0;
    if (ui.selected) {
      const f = FRAMES[ui.selected], d = inward(f.office.door);
      const back = f.office.exec ? 9.5 : 6.2;
      const s = f.seat.at;
      void controls.setLookAt(f.door[0] - d[0] * back, f.office.exec ? 8 : 6.2, f.door[1] - d[1] * back, s[0], 0.9, s[1], animate);
      return;
    }
    const v = VIEWS[ui.view as ViewId];
    const portrait = aspect < 0.85;
    if (ui.view === "overview") {
      // fit the whole floor in frame, whatever the screen shape; portrait phones look from the east so the long side of the
      // building runs up the screen. Padding keeps the executive suite clear of the toolbar and the view chips.
      void controls.setLookAt(...(portrait ? [26, 40, 0.5] : [0, 34, 30]) as [number, number, number], 0, 0, 0.5, false);
      const box = new THREE.Box3(new THREE.Vector3(BUILDING.x0, 0, BUILDING.z0), new THREE.Vector3(BUILDING.x1, 2.4, BUILDING.z1));
      void controls.fitToBox(box, animate, { paddingTop: 2.2, paddingBottom: 2.6, paddingLeft: 0.8, paddingRight: 0.8 });
      return;
    }
    if (ui.view === "meeting") {
      // seen from the far side of the table, so the people facing the door show their faces; framed to the room
      const r = ZONES.meeting.rect;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      // keep a 40° downward look (fitToBox would snap the camera level) and back off until the whole room fits the screen
      const tilt = (40 * Math.PI) / 180;
      const d = fitDistance(r.x1 - r.x0 + 0.6, (r.z1 - r.z0) * Math.sin(tilt) + 1.8, camera as THREE.PerspectiveCamera, aspect);
      void controls.setLookAt(cx, 0.6 + d * Math.sin(tilt), cz + d * Math.cos(tilt), cx, 0.6, cz, animate);
      return;
    }
    const k = portrait ? 1.3 : 1;
    const p = v.pos.map((c, i) => v.target[i] + (c - v.target[i]) * k);
    void controls.setLookAt(p[0], p[1], p[2], v.target[0], v.target[1], v.target[2], animate);
  }, [controls, camera, ui.view, ui.viewNonce, ui.selected, aspect, reduceMotion]);

  // tap to select (a drag rotates the camera and must not select)
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    const ray = new THREE.Raycaster();
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 500) { down = null; return; }
      down = null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = hitGroup.current ? ray.intersectObjects(hitGroup.current.children, false)[0] : undefined;
      const id = hit?.object.userData.id as AgentId | undefined;
      if (id) store.set({ selected: id, panel: "people", viewNonce: store.get().viewNonce + 1 });
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => { el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); };
  }, [gl, camera, store]);

  // low-power mode: 30 fps on demand
  useEffect(() => {
    if (ui.quality !== "low") return;
    const id = window.setInterval(() => invalidate(), 33);
    return () => window.clearInterval(id);
  }, [ui.quality, invalidate]);

  // toolbar + view chips over the canvas, relative to it; measured on resize only (no layout reads per frame)
  const blockers = useRef<LabelBox[]>([]);
  useEffect(() => {
    const host = gl.domElement;
    const measure = () => {
      const h = host.getBoundingClientRect();
      blockers.current = [...document.querySelectorAll<HTMLElement>(".hq-toolbar, .hq-views")].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: "", x: r.left - h.left + r.width / 2, y: r.bottom - h.top, w: r.width, h: r.height, priority: 99, dist: 0 };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    document.querySelectorAll(".hq-toolbar, .hq-views").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [gl]);
  const frames = useRef({ n: 0, acc: 0, dpr: 1 });
  useEffect(() => { frames.current.dpr = gl.getPixelRatio(); }, [gl]);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame((state, dt) => {
    controls?.update(dt);
    // adaptive resolution: if the last ~2 s averaged under 26 fps, step the pixel ratio down (never below 1)
    const F = frames.current;
    F.n++; F.acc += dt;
    if (F.n >= 120) {
      const fps = F.n / F.acc;
      if (ui.quality === "auto" && fps < 26 && F.dpr > 1) { F.dpr = Math.max(1, F.dpr - 0.5); setDpr(F.dpr); }
      if (debug) (window as unknown as { __hqStats: unknown }).__hqStats = { fps: Math.round(fps), dpr: F.dpr, ...state.gl.info.render, geometries: state.gl.info.memory.geometries, textures: state.gl.info.memory.textures };
      F.n = 0; F.acc = 0;
    }
    // hit volumes follow the people
    hitGroup.current?.children.forEach((m) => { const w = sim.walkers[m.userData.id as AgentId]; m.position.set(w.pos[0], 0.9, w.pos[1]); });

    // floating names (no work at all while they are switched off)
    const L = labels.current;
    if (!L || !store.get().labels) return;
    const W = state.size.width, H = state.size.height;
    const cam: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const boxes: LabelBox[] = [];
    const place = (key: string, el: HTMLSpanElement | null | undefined, x: number, y: number, z: number, priority: number, text: string, scale = 1) => {
      if (!el) return;
      v.set(x, y, z);
      const dist = camera.position.distanceTo(v);
      v.project(camera);
      const offscreen = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1;
      const blocked = !offscreen && OCCLUDERS.some((b) => segmentHitsBox(cam, [x, y, z], b));
      if (offscreen || blocked) { el.style.visibility = "hidden"; return; }
      const px = (v.x + 1) * 0.5 * W, py = (1 - v.y) * 0.5 * H;
      const fs = labelSize(dist) * scale;
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.fontSize = fs.toFixed(1) + "px";
      boxes.push({ id: key, x: px, y: py, w: labelWidth(text, fs), h: fs * (scale < 1 ? 2.3 : 1.35), priority, dist });
    };
    const sel = store.get().selected;
    for (const id of AGENT_IDS) {
      const w = sim.walkers[id], look = AGENTS[id].look;
      // above the person's real top (avatar height incl. headwear × the body scale people-glb applies)
      const av = characterEntry(id).height;
      const k = look.kind === "human" ? (av ? bodyScale(look, av).s * av : look.height) / 1.75 : 1;
      const standing = w.clip === "walk" || w.clip === "stand";
      const y = id === "BASHT" ? (standing ? 2.25 : 1.92) : (standing ? 1.98 : 1.58) * k;
      place(id, L.agents[id], w.pos[0], y, w.pos[1], id === sel ? 3 : id === "BASHT" ? 2 : 1, AGENTS[id].nameAr);
    }
    ROOM_LABELS.forEach((r, i) => place("room" + i, L.rooms[i], r.at[0], r.at[1], r.at[2], 0, r.text, 0.82));
    // the toolbar and the view chips sit over the canvas: nothing may be drawn underneath them
    const shown = placeLabels([...blockers.current, ...boxes]);
    for (const b of boxes) {
      const el = b.id.startsWith("room") ? L.rooms[Number(b.id.slice(4))] : L.agents[b.id as AgentId];
      if (el) el.style.visibility = shown.has(b.id) ? "visible" : "hidden";
    }
  });

  const night = ui.night;
  return (
    <>
      <hemisphereLight args={[night ? "#8b7bd6" : "#fbf8ff", night ? "#1b1230" : "#cdbfa8", night ? 0.6 : 2.1]} />
      <directionalLight position={[14, 26, 18]} intensity={night ? 0.25 : 1.9} color={night ? "#9fb4ff" : "#fff3dc"} />
      <directionalLight position={[-18, 14, -10]} intensity={night ? 0.15 : 0.45} color="#d9cfff" />
      {/* authored art (tools/hq-assets); the procedural greybox shows while it streams in, and if it ever fails to load */}
      <AssetBoundary fallback={<Building night={night} />}>
        <Suspense fallback={<Building night={night} />}><BuildingGlb night={night} /></Suspense>
      </AssetBoundary>
      <AssetBoundary fallback={<People sim={sim} />}>
        <Suspense fallback={<People sim={sim} />}><PeopleGlb sim={sim} paused={ui.paused} reducedMotion={ui.reducedMotion} /></Suspense>
      </AssetBoundary>
      <group ref={hitGroup} visible={false}>
        {AGENT_IDS.map((id) => (
          <mesh key={id} userData={{ id }}><cylinderGeometry args={[0.45, 0.45, 1.9, 8]} /><meshBasicMaterial /></mesh>
        ))}
      </group>
    </>
  );
}

/** A failed asset download (offline, blocked) falls back to the procedural greybox instead of breaking the view. */
class AssetBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
