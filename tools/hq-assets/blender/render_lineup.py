"""Render all characters side by side (QA): tools/hq-assets/build.sh lineup  → out/lineup-<clip>.png"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from common import B, hex_rgba, reset_scene  # noqa: E402
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(ROOT, "out")
clip = sys.argv[sys.argv.index("--") + 2] if "--" in sys.argv and len(sys.argv) > sys.argv.index("--") + 2 else "idle"
ids = [c["id"] for c in json.load(open(os.path.join(ROOT, "layout.json")))["characters"]]
reset_scene()
sc = bpy.context.scene
for i, cid in enumerate(ids):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(out, f"{cid}.glb"))
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    for r in roots:
        r.location = B((i - (len(ids) - 1) / 2) * 0.85, 0, 0)
    for o in new:
        if o.animation_data and o.animation_data.nla_tracks:
            for tr in o.animation_data.nla_tracks:
                tr.mute = tr.name != clip
            o.animation_data.action = None
sc.frame_set(7)
sc.render.engine = "CYCLES"; sc.cycles.samples = 24
sc.render.resolution_x, sc.render.resolution_y = 1800, 520
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = 12.4
cam.location = B(0, 1.25, 12); cam.rotation_euler = (math.radians(88), 0, 0)
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba("#efeaf7")
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 3.2; sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(25))
sc.render.filepath = os.path.join(out, f"lineup-{clip}.png")
bpy.ops.render.render(write_still=True)
print("[lineup] wrote", sc.render.filepath)
