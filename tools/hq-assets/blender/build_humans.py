"""
BASHT HQ — realistic human employees from Microsoft Rocketbox (MIT licence, https://github.com/microsoft/Microsoft-Rocketbox).

    tools/hq-assets/build.sh humans            # needs ROCKETBOX=/path/to/Microsoft-Rocketbox (git clone, no LFS needed)

For every human in layout.json ("characters", sourced from apps/web/lib/hq/roster.ts → look.model):
  <ID>.glb      the person: one skinned mesh (body / head / headwear / hair-and-lash cards), 80-bone "Bip01" biped
                skeleton, colour textures resized for phones (512², no normal maps) and exported as WebP
and, once per sex:
  anims-m.glb / anims-f.glb   the motion-capture clips the app plays (idle, walk, sit, type, talk, stand), trimmed to
                              short loopable segments, walk made in-place (the simulation moves people)
All avatars share the biped's bone names, so one clip library drives every character with no retargeting.
"""
import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, ".."))
ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(ROOT, "out"))
ap.add_argument("--only", nargs="*", default=[])
ap.add_argument("--no-anims", action="store_true")
ap.add_argument("--models", nargs="*", default=[], help="casting QA: build these Rocketbox models (e.g. Adults/Female_Adult_03) instead of the roster")
ap.add_argument("--head", type=int, default=512)
ap.add_argument("--body", type=int, default=512)
ap.add_argument("--normal", type=int, default=0, help="normal-map size; 0 = no normal maps")
args, _ = ap.parse_known_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
os.makedirs(args.out, exist_ok=True)
RB = os.environ.get("ROCKETBOX")
if not RB or not os.path.isdir(os.path.join(RB, "Assets", "Avatars")):
    raise SystemExit("set ROCKETBOX to a clone of https://github.com/microsoft/Microsoft-Rocketbox")
AVATARS = os.path.join(RB, "Assets", "Avatars")
ANIMS = os.path.join(RB, "Assets", "Animations")
PLAN = json.load(open(os.path.join(ROOT, "layout.json")))

# clip key → (folder, file stem without the m_/f_ prefix, start second, length seconds)
ROOT_NODE = "RB_ROOT"
SEATED = ("sit", "type", "talk")
# seated clips are placed against the HQ chair (build_building.py: cushion top 0.50 m, front edge 0.24 m ahead of the chair
# centre = the person's origin in the simulation, backrest 0.19–0.27 m behind it): feet flat on the floor, knees past the
# cushion's front edge
KNEE_FORWARD = {"m": 0.34, "f": 0.42}  # women further forward: a hijab / abaya drape must clear the backrest
# the male captures were taken on a lower chair than the female ones: men sit this much higher (feet barely clear the
# floor) so the hips rest on the 0.50 m cushion instead of sinking into it
SEAT_LIFT = {"m": 0.01, "f": 0.0}
COPYRIGHT = "Microsoft Rocketbox (MIT licence, see LICENSE-rocketbox.txt); composed for BASHT HQ"
# only these nodes keep translation keys: every other bone's length comes from the avatar wearing the clip, so tall and
# short people keep their own proportions
MOVING = ("Bip01 Pelvis",)  # (the biped root "Bip01" is the armature object itself: RB_ROOT)
CLIPS = {
    "idle": ("all_animations_max_motextr_static", "idle_neutral_01", 0.0, 8.0),
    "walk": ("all_animations_max_motextr_xy", "walk_neutral_02", None, None),  # the take is one gait cycle at ~1.35 m/s
    "sit": ("all_animations_max_motextr_static", "sit_table_idle_neutral_01", 0.0, 10.0),
    "type": ("all_animations_max_motextr_static", "sit_table_breathe_01", 0.0, 8.0),
    "talk": ("all_animations_max_motextr_static", "sit_table_gestic_thoughtful", 0.0, 9.0),
    "stand": ("all_animations_max_motextr_static", "gestic_talk_neutral_01", 0.0, 9.0),
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, automatic_bone_orientation=False, ignore_leaf_bones=False)
    return [o for o in bpy.data.objects if o not in before]


def load_image(path, size, name):
    img = bpy.data.images.load(path)
    if img.size[0] > size:
        img.scale(size, size)
    img.name = name
    return img


def wire_materials(mesh, tex_dir):
    """Rocketbox FBX materials point at 3ds Max paths; rebuild them from the Textures folder."""
    for slot in mesh.material_slots:
        mat = slot.material
        if not mat or "_" not in mat.name:
            raise ValueError(f"unexpected Rocketbox material name {mat.name if mat else None!r} in {tex_dir}")
        prefix, part = mat.name.split("_", 1)  # e.g. m008_body / m250_keffiyeh / f001_opacity
        part = part.split(".")[0]
        color = os.path.join(tex_dir, f"{prefix}_{part}_color.tga")
        normal = os.path.join(tex_dir, f"{prefix}_{part}_normal.tga")
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        bsdf.inputs["Roughness"].default_value = 0.62 if part != "head" else 0.5
        bsdf.inputs["Metallic"].default_value = 0.0
        size = args.head if part == "head" else (512 if part == "opacity" else args.body)
        if os.path.exists(color):
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = load_image(color, size, f"{prefix}_{part}_color")
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            if part == "opacity":  # eyelash / hair cards: alpha-TESTED (glTF MASK: no sorting, cheap on phones)
                # cut at alpha 0.3 instead of the exporter's 0.5 so soft fringes (hair tips, a scarf's hem) stay whole
                px = image_np(tex.image)
                px[..., 3] = np.where(px[..., 3] > 0.3, 1.0, 0.0)
                tex.image = new_image_np(tex.image.name, px)
                rnd = nt.nodes.new("ShaderNodeMath")
                rnd.operation = "ROUND"  # the glTF exporter reads Round(alpha) as alphaMode MASK, cutoff 0.5
                nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
                nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
                mat.surface_render_method = "DITHERED"
        # closed body / head shells are drawn single-sided; cloth and hair cards (keffiyeh, opacity) need both faces
        mat.use_backface_culling = part in ("body", "head")
        if args.normal and os.path.exists(normal) and part != "opacity":
            nt_tex = nt.nodes.new("ShaderNodeTexImage")
            nt_tex.image = load_image(normal, args.normal, f"{prefix}_{part}_normal")
            nt_tex.image.colorspace_settings.name = "Non-Color"
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(nt_tex.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])


# --- kitbash: Rocketbox avatars of one sex share an identical skeleton, so heads and headwear move between them ---
HIJAB_SOURCE = "Adults/Female_Adult_06"  # her hijab is modelled in her head mesh: cloth-coloured faces are cut out of it
COVERED = {"Adults/Female_Adult_06", "Adults/Female_Adult_10"}  # avatars whose own head is already covered


def import_avatar(model):
    folder = os.path.join(AVATARS, model)
    objs = import_fbx(os.path.join(folder, "Export", os.path.basename(model) + ".fbx"))
    arm = next(o for o in objs if o.type == "ARMATURE")
    mesh = next(o for o in objs if o.type == "MESH")
    wire_materials(mesh, os.path.join(folder, "Textures"))
    return arm, mesh


def part_of(mat_name):
    return mat_name.split("_", 1)[1].split(".")[0] if "_" in mat_name else mat_name


def keep_parts(mesh, keep):
    """Delete every face whose material part (body / head / opacity / keffiyeh) is not in `keep`."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    parts = [part_of(s.material.name) for s in mesh.material_slots]
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if parts[f.material_index] not in keep], context="FACES")
    bm.to_mesh(mesh.data)
    bm.free()


def move_to(mesh, arm):
    """Re-bind a mesh imported with another avatar to `arm` (same bone names and rest pose)."""
    old = mesh.parent
    mesh.parent = arm
    for m in mesh.modifiers:
        if m.type == "ARMATURE":
            m.object = arm
    return old


def drop(objs):
    for o in objs:
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


def image_np(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def new_image_np(name, a):
    """A new packed image holding pixel array `a` (copy() of a resized image would come back at its original size)."""
    img = bpy.data.images.new(name, a.shape[1], a.shape[0], alpha=True)
    img.pixels.foreach_set(a.astype(np.float32).ravel())
    img.pack()
    return img


def _tex_arrays(mesh):
    out = []
    for slot in mesh.material_slots:
        tex = next((n for n in slot.material.node_tree.nodes if n.type == "TEX_IMAGE"), None) if slot.material else None
        out.append(image_np(tex.image) if tex and tex.image else None)
    return out


def face_texels(mesh):
    """Colour at the UV centre of every face (from its material's base-colour texture), or None."""
    arrays = _tex_arrays(mesh)
    uv = mesh.data.uv_layers.active.data
    out = []
    for poly in mesh.data.polygons:
        a = arrays[poly.material_index]
        if a is None:
            out.append(None)
            continue
        u = sum(uv[i].uv.x for i in poly.loop_indices) / poly.loop_total
        w = sum(uv[i].uv.y for i in poly.loop_indices) / poly.loop_total
        h_, w_ = a.shape[:2]
        out.append(a[min(h_ - 1, max(0, int(w * h_))), min(w_ - 1, max(0, int(u * w_))), :3].copy())
    return out


def eye_level(arm):
    return (arm.matrix_world @ arm.data.bones["Bip01 LEye"].head_local).z


def head_regions(mesh, arm, part="head"):
    """Split a head's faces into skin and not-skin (hair, caps, cloth) above the brows. The skin reference is the
    front-most stretch of the face just under the eyes (nose / cheeks), so every complexion classifies against itself."""
    parts = [part_of(s.material.name) for s in mesh.material_slots]
    tex = face_texels(mesh)
    mw = mesh.matrix_world
    ez = eye_level(arm)
    cent = {p.index: mw @ p.center for p in mesh.data.polygons if parts[p.material_index] == part}
    band = sorted((c.y, i) for i, c in cent.items() if ez - 0.06 < c.z < ez - 0.015 and tex[i] is not None)[:12]
    skin = np.mean([tex[i] for _, i in band], axis=0)
    head_regions.skin_face = band[0][1] if band else None
    above, hair = set(), set()
    for i, c in cent.items():
        if c.z > ez + 0.03:
            above.add(i)
            if tex[i] is None or np.abs(tex[i] - skin).sum() > 0.30:
                hair.add(i)
    return above, hair


def delete_faces(mesh, idx):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in sorted(idx)], context="FACES")
    bm.to_mesh(mesh.data)
    bm.free()


def strip_hair(mesh, arm, crown_cut=None):
    """Under headwear: hair cards above the brows go; hair and caps on the head shell are re-coloured as forehead skin
    (they fill the face opening's hairline) and are then tucked inside the shell. `crown_cut`: also delete every head face
    above this height (under a ghutra crown nothing up there may show)."""
    _above, hair = head_regions(mesh, arm)
    ref = head_regions.skin_face
    parts = [part_of(s.material.name) for s in mesh.material_slots]
    ez = eye_level(arm)
    mw = mesh.matrix_world
    gone = {p.index for p in mesh.data.polygons if parts[p.material_index] == "opacity" and (mw @ p.center).z > ez + 0.02}
    if crown_cut is not None:
        gone |= {p.index for p in mesh.data.polygons if parts[p.material_index] == "head" and (mw @ p.center).z > crown_cut}
    if ref is not None:
        uv = mesh.data.uv_layers.active.data
        rp = mesh.data.polygons[ref]
        su = sum(uv[i].uv.x for i in rp.loop_indices) / rp.loop_total
        sv = sum(uv[i].uv.y for i in rp.loop_indices) / rp.loop_total
        for i in hair - gone:
            for li in mesh.data.polygons[i].loop_indices:
                uv[li].uv = (su, sv)
    delete_faces(mesh, gone)


def recolour_ghutra(mesh):
    """The keffiyeh texture is the red-check shemagh; the white ghutra keeps its weave shading and the black agal."""
    for slot in mesh.material_slots:
        if part_of(slot.material.name) != "keffiyeh":
            continue
        tex = next(n for n in slot.material.node_tree.nodes if n.type == "TEX_IMAGE")
        a = image_np(tex.image)
        rgb = a[..., :3]
        v = rgb.max(axis=2, keepdims=True)
        sat = (v - rgb.min(axis=2, keepdims=True)) / np.maximum(v, 1e-4)
        cloth = (v > 0.25) & (sat > 0.0)
        white = np.clip(0.80 + 0.19 * v, 0, 1) * np.array([1.0, 0.995, 0.985])
        a[..., :3] = np.where(cloth, white, rgb)
        tex.image = new_image_np(tex.image.name.replace("keffiyeh", "ghutra"), a)
        slot.material.name = slot.material.name.replace("keffiyeh", "ghutra")


def hijab_shell(arm, tint_hex):
    """Cut the hijab out of HIJAB_SOURCE's head (faces whose texel is cloth: light and unsaturated) and tint it."""
    h_arm, h = import_avatar(HIJAB_SOURCE)
    keep_parts(h, {"head"})
    slot = h.material_slots[[part_of(s.material.name) for s in h.material_slots].index("head")]
    tex = next(n for n in slot.material.node_tree.nodes if n.type == "TEX_IMAGE")
    a = image_np(tex.image)
    hgt, wid = a.shape[:2]
    uv = h.data.uv_layers.active.data
    # per face: cloth (light or shaded grey: red barely above blue) vs skin / eyes / mouth (orange-red)
    warm = []
    for poly in h.data.polygons:
        u = sum(uv[i].uv.x for i in poly.loop_indices) / poly.loop_total
        w = sum(uv[i].uv.y for i in poly.loop_indices) / poly.loop_total
        px = a[min(hgt - 1, max(0, int(w * hgt))), min(wid - 1, max(0, int(u * wid))), :3]
        warm.append(float(px[0] - px[2]))
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(h.data)
    bm.faces.ensure_lookup_table()
    cloth = {f.index for f in bm.faces if warm[f.index] < 0.10}
    # close holes: a fold too dark or a seam texel must not punch through the drape — adopt faces mostly surrounded by
    # cloth unless they are clearly skin
    for _ in range(4):
        add = set()
        for f in bm.faces:
            if f.index in cloth or warm[f.index] > 0.22:
                continue
            nb = {g.index for e in f.edges for g in e.link_faces if g is not f}
            if len(nb & cloth) >= 2:
                add.add(f.index)
        if not add:
            break
        cloth |= add
    # keep the connected cloth piece(s) that make the hijab; drop stray islands (lashes, inner-mouth specks)
    seen, comps = set(), []
    for start in cloth:
        if start in seen:
            continue
        comp, stack = set(), [start]
        while stack:
            i = stack.pop()
            if i in seen:
                continue
            seen.add(i)
            comp.add(i)
            for e in bm.faces[i].edges:
                for g in e.link_faces:
                    if g.index in cloth and g.index not in seen:
                        stack.append(g.index)
        comps.append(comp)
    keep = set().union(*[c for c in comps if len(c) >= 40])
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
    bm.to_mesh(h.data)
    bm.free()
    # tinted copy of the texture: cloth luminance × the person's colour
    t = np.array([int(tint_hex[i:i + 2], 16) / 255 for i in (1, 3, 5)])  # byte images keep sRGB values in .pixels
    lum = a[..., :3].mean(axis=2, keepdims=True)
    a2 = a.copy()
    a2[..., :3] = np.clip(lum / 0.92 * t, 0, 1)  # the white cloth (~0.92) becomes exactly the colour; folds stay shaded
    tex.image = new_image_np("hijab_color", a2)
    slot.material.name = "hijab_cloth"
    slot.material.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    # the drape (below the chin) stands 1.5 cm off the body: shoulders and lapels moving with the arms stay under it
    chin = eye_level(h_arm) - 0.12
    h.data.update()
    mw, mwi = h.matrix_world, h.matrix_world.inverted()
    for v in h.data.vertices:
        p = mw @ v.co
        if p.z < chin:
            n = (mw.to_3x3() @ v.normal).normalized()
            v.co = mwi @ (p + n * 0.015 * min(1.0, (chin - p.z) / 0.06))
    old = move_to(h, arm)
    drop([old])
    return h


def tuck_inside(mesh, shell, arm, parts=("head", "opacity"), min_z=-1e9, from_bone=None):
    """Hair (and any cap) that would poke through a headwear shell is pulled just inside it: a ray from the skull centre
    to each head vertex that crosses the shell first moves the vertex to 6 mm under the shell."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    bvh = BVHTree.FromObject(shell, bpy.context.evaluated_depsgraph_get(), deform=False)
    inv = shell.matrix_world.inverted()
    centre = arm.matrix_world @ arm.data.bones["Bip01 Head"].head_local
    centre = centre + Vector((0, 0, 0.07))  # from the head joint up into the middle of the skull
    if from_bone:  # e.g. the chest: rays from inside the torso out through the drape
        centre = arm.matrix_world @ arm.data.bones[from_bone].head_local
    names = [part_of(s.material.name) for s in mesh.material_slots]
    verts = set()
    for poly in mesh.data.polygons:
        if names[poly.material_index] in parts:
            verts.update(poly.vertices)
    moved = 0
    mw, mwi = mesh.matrix_world, mesh.matrix_world.inverted()
    eye = arm.matrix_world @ arm.data.bones["Bip01 LEye"].head_local
    for i in verts:
        v = mesh.data.vertices[i]
        p = mw @ v.co
        if p.z < min_z:
            continue
        # the face itself (in front of the eyes, below the brows) is never moved: it is what the opening shows
        if not from_bone and p.y < eye.y + 0.02 and p.z < eye.z + 0.03:
            continue
        d = p - centre
        dist = d.length
        if dist < 1e-4:
            continue
        o_l, p_l = inv @ centre, inv @ p  # the shell's local space is centimetres (FBX scale 0.01): cast there
        loc, _n, _f, _hit = bvh.ray_cast(o_l, (p_l - o_l).normalized(), (p_l - o_l).length * (1 + 0.004 / dist))
        if loc is not None:
            hit_w = (shell.matrix_world @ loc - centre).length
            if hit_w < dist + 0.004:
                v.co = mwi @ (centre + d.normalized() * max(0.0, hit_w - 0.006))
                moved += 1
    return moved


def compose(model, look):
    """The person's mesh: `model` is the outfit (body), look.face the face donor, look.head the headwear."""
    arm, mesh = import_avatar(model)
    head = look.get("head")
    extra = []
    wearer = mesh  # the mesh whose head ends up under the headwear
    if look.get("face"):
        f_arm, f = import_avatar(look["face"])
        keep_parts(f, {"head", "opacity"})
        drop([move_to(f, arm)])
        # the outfit's own head goes entirely (the headdress crown is part of the keffiyeh mesh)
        keep_parts(mesh, {"body", "keffiyeh"})
        extra.append(f)
        wearer = f
    if head == "ghutra":
        recolour_ghutra(mesh)
    if model == HIJAB_SOURCE:
        # her scarf's hem is a fringe of alpha cards that shreds at any alpha cut on a phone: the scarf ends at the cloth
        parts = [part_of(s.material.name) for s in mesh.material_slots]
        low = eye_level(arm) - 0.20
        delete_faces(mesh, {p.index for p in mesh.data.polygons
                            if parts[p.material_index] == "opacity" and (mesh.matrix_world @ p.center).z < low})
    shell = None
    if head in ("ghutra", "shemagh") and look.get("face"):
        shell = mesh.copy()
        shell.data = mesh.data.copy()
        bpy.context.scene.collection.objects.link(shell)
        parts = [part_of(s.material.name) for s in shell.material_slots]
        delete_faces(shell, {p.index for p in shell.data.polygons if parts[p.material_index] == "body"})
    if head == "hijab" and model not in COVERED:
        shell = hijab_shell(arm, look.get("accent", "#2a2a2a"))
        extra.append(shell)
    if shell is not None:
        strip_hair(wearer, arm, crown_cut=eye_level(arm) + 0.07 if head in ("ghutra", "shemagh") else None)
        tuck_inside(wearer, shell, arm)
        if head == "hijab":  # the drape lies over the collar and lapels: keep them under it
            tuck_inside(mesh, shell, arm, parts=("body",), min_z=eye_level(arm) - 0.45, from_bone="Bip01 Spine2")
        if shell not in extra:
            drop([shell])
    if extra:
        select_only([mesh, *extra])
        bpy.context.view_layer.objects.active = mesh
        bpy.ops.object.join()
    select_only([mesh])
    bpy.ops.object.material_slot_remove_unused()
    for p in mesh.data.polygons:
        p.use_smooth = True
    return arm, mesh


def select_only(objs):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]


def build_avatar(cid, model, look=None):
    reset()
    arm, mesh = compose(model, look or {})
    meshes = [mesh]
    # Rocketbox keeps root motion and seat height on the armature OBJECT: avatars and clip libraries use the same node
    # name so the clips' root track binds to every avatar
    arm.name = ROOT_NODE
    path = os.path.join(args.out, f"{cid}.glb")
    select_only([arm, *meshes])
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_skins=True,
                              export_animations=False, export_materials="EXPORT", export_image_format="WEBP", export_image_quality=82,
                              export_def_bones=False, export_normals=True, export_tangents=False, export_copyright=COPYRIGHT)
    tris = sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)
    # rest-pose pelvis height (metres) — the app scales clip root heights to each body
    pelvis = arm.data.bones.get("Bip01 Pelvis")
    pelvis_h = (arm.matrix_world @ pelvis.head_local).z if pelvis else 1.0
    return {"tris": tris, "bytes": os.path.getsize(path), "model": model, "sex": "f" if "Female" in model else "m", "pelvis": round(pelvis_h, 4),
            "height": round(max((m.matrix_world @ v.co).z for m in meshes for v in m.data.vertices), 4),
            "materials": [s.material.name for m in meshes for s in m.material_slots]}


def build_anims(sex):
    """One armature carrying every clip as its own NLA track (exported as separate glTF animations).

    Every Rocketbox clip FBX imports with its OWN rest pose (the take's first frame baked into the bones), so its actions
    are only meaningful on that armature. Each clip is therefore re-baked visually (world-space Copy Transforms → keyed
    pose) onto one host skeleton, whose rest pose is then what every clip is relative to."""
    reset()
    scene = bpy.context.scene
    host = None
    info = {}
    for key, (folder, stem, start, length) in CLIPS.items():
        path = os.path.join(ANIMS, folder, f"{sex}_{stem}.max.fbx")
        objs = import_fbx(path)
        src = next(o for o in objs if o.type == "ARMATURE")
        for o in objs:
            if o.type == "MESH":
                bpy.data.objects.remove(o, do_unlink=True)
        act = src.animation_data.action
        f0, f1 = act.frame_range
        fps = scene.render.fps / scene.render.fps_base  # the FBX importer sets the scene to the take's rate (30)
        if key == "walk":
            # the xy takes are exactly one gait cycle: use all of it (its last pose is its first)
            start_f, end_f = round(f0), round(f1)
            p0, p1 = root_xy(src, start_f), root_xy(src, end_f)
            walk_speed = math.dist(p0, p1) / ((end_f - start_f) / fps)
            # in place (the simulation moves the person): flatten whichever horizontal root channels travel
            for fc in action_fcurves(act):
                if fc.data_path == "location" and fc.array_index in (0, 1):
                    ys = [kp.co.y for kp in fc.keyframe_points]
                    if ys and max(ys) - min(ys) > 0.3:
                        for kp in fc.keyframe_points:
                            kp.co.y = kp.handle_left.y = kp.handle_right.y = ys[0]
        else:
            # a calm stretch of the take whose last pose flows back into its first (no pop when the loop wraps)
            start_f = round(f0 + start * fps)
            want = start_f + length * fps
            end_f = loop_end(src, start_f, want - fps * 3, min(f1, want + fps * 3))
        if host is None:
            # the first clip's skeleton becomes the host: duplicate it without animation so its rest pose is the reference
            host = src.copy()
            host.data = src.data.copy()
            host.animation_data_clear()
            scene.collection.objects.link(host)
            host.name = ROOT_NODE
        # follow the source take in world space, then key the result
        oc = host.constraints.new("COPY_TRANSFORMS")
        oc.target = src
        for pb in host.pose.bones:
            c = pb.constraints.new("COPY_TRANSFORMS")
            c.target, c.subtarget = src, pb.name
        select_only([host])
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.nla.bake(frame_start=int(start_f), frame_end=int(end_f), step=1, only_selected=False, visual_keying=True,
                         clear_constraints=True, use_current_action=False, bake_types={"POSE", "OBJECT"})
        bpy.ops.object.mode_set(mode="OBJECT")
        baked = host.animation_data.action
        baked.name = key
        host.animation_data.action = baked
        if key == "idle":
            scene.frame_set(int(start_f))
            ankle_stand = min(joint(host, "Bip01 L Foot").z, joint(host, "Bip01 R Foot").z)
        if key in SEATED:
            scene.frame_set(int(start_f))
            ankle = min(joint(host, "Bip01 L Foot").z, joint(host, "Bip01 R Foot").z)
            knee = (joint(host, "Bip01 L Calf") + joint(host, "Bip01 R Calf")) / 2
            # the person faces -Y here (+Z in the app): knees KNEE_FORWARD ahead of the chair centre, centred sideways
            shift = (-knee.x, -KNEE_FORWARD[sex] - knee.y, ankle_stand - ankle + SEAT_LIFT[sex])
            for fc in action_fcurves(baked):
                if fc.data_path == "location":
                    for kp in fc.keyframe_points:
                        for pt in (kp.co, kp.handle_left, kp.handle_right):
                            pt.y += shift[fc.array_index]
            scene.frame_set(int(start_f))
            pel = joint(host, "Bip01 Pelvis")
            info_seat = {"pelvis_z": round(pel.z, 3), "pelvis_back": round(-pel.y, 3), "shift": [round(v, 3) for v in shift]}
        else:
            info_seat = None
        close_loop(baked, walk=(key == "walk"))
        host.animation_data.action = None
        for bag in action_channelbags(baked):
            for fc in list(bag.fcurves):
                bone = fc.data_path.split('"')[1] if fc.data_path.startswith("pose.bones") else None
                if fc.data_path.endswith(".scale") or fc.data_path == "scale" or (fc.data_path.endswith(".location") and bone not in MOVING):
                    bag.fcurves.remove(fc)
        host.animation_data.action = None
        tr = host.animation_data.nla_tracks.new()
        tr.name = key
        strip = tr.strips.new(key, int(start_f), baked)
        strip.action_frame_start, strip.action_frame_end = start_f, end_f
        bpy.data.objects.remove(src, do_unlink=True)
        info[key] = {"file": os.path.basename(path), "seconds": round((end_f - start_f) / fps, 2)}
        if info_seat:
            info[key]["seat"] = info_seat
        if key == "walk":
            info[key]["speed"] = round(walk_speed, 3)  # metres / second the feet travel at timeScale 1
    host.location = (0, 0, 0)
    host.rotation_quaternion = (1, 0, 0, 0)
    host.rotation_euler = (0, 0, 0)
    pelvis = host.data.bones.get("Bip01 Pelvis")
    path = os.path.join(args.out, f"anims-{sex}.glb")
    select_only([host])
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_skins=False,
                              export_animations=True, export_animation_mode="NLA_TRACKS", export_frame_step=1,
                              export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=True,
                              export_copyright=COPYRIGHT,
                              export_materials="NONE", export_def_bones=False)
    return {"bytes": os.path.getsize(path), "clips": info, "pelvis": round((host.matrix_world @ pelvis.head_local).z, 4) if pelvis else None}


SIG_BONES = ("Bip01 Head", "Bip01 L Hand", "Bip01 R Hand", "Bip01 L Forearm", "Bip01 R Forearm", "Bip01 L Foot", "Bip01 R Foot",
             "Bip01 L Calf", "Bip01 R Calf", "Bip01 Spine2")


def joint(arm, name):
    return arm.matrix_world @ arm.pose.bones[name].head


def pose_sig(arm, frame):
    """Pose fingerprint: key joints relative to the pelvis (metres) and every joint's local rotation (quaternion
    components, sign-normalised), so both where the hands are and how the wrists / head are turned must match."""
    bpy.context.scene.frame_set(int(frame))
    pel = joint(arm, "Bip01 Pelvis")
    out = []
    for b in SIG_BONES:
        v = joint(arm, b) - pel
        out += [v.x, v.y, v.z]
    for pb in arm.pose.bones:
        if pb.name.endswith("Nub"):
            continue
        q = pb.matrix_basis.to_quaternion()
        if q.w < 0:
            q = -q
        out += [0.15 * c for c in q]  # ~0.15 m per unit: a 20° turn weighs like a few cm of hand travel
    return out


def close_loop(act, walk=False):
    """Make a clip wrap seamlessly: whatever separates its last pose from its first is spread linearly over the whole
    clip (a few degrees over 7–11 s is invisible; a snap at the wrap is not). Quaternions stay unit length and in the
    first pose's hemisphere. The in-place walk's flattened travel is left alone."""
    bags = list(action_channelbags(act))
    curves = [fc for bag in bags for fc in bag.fcurves]
    groups = {}
    for fc in curves:
        groups.setdefault(fc.data_path, {})[fc.array_index] = fc
    for path, comps in groups.items():
        if walk and path == "location":
            continue
        fcs = [comps[i] for i in sorted(comps)]
        n = min(len(fc.keyframe_points) for fc in fcs)
        if n < 3:
            continue
        first = [fc.keyframe_points[0].co.y for fc in fcs]
        last = [fc.keyframe_points[n - 1].co.y for fc in fcs]
        quat = path.endswith("rotation_quaternion") and len(fcs) == 4
        if quat and sum(a * b for a, b in zip(first, last)) < 0:
            first = [-v for v in first]
        delta = [a - b for a, b in zip(first, last)]
        for i in range(n):
            w = i / (n - 1)
            vals = [fc.keyframe_points[i].co.y + d * w for fc, d in zip(fcs, delta)]
            if quat:
                norm = math.sqrt(sum(v * v for v in vals)) or 1.0
                vals = [v / norm for v in vals]
            for fc, v in zip(fcs, vals):
                kp = fc.keyframe_points[i]
                kp.co.y = v
                kp.interpolation = "LINEAR"
        for fc in fcs:
            fc.update()


def root_xy(arm, frame):
    bpy.context.scene.frame_set(int(frame))
    p = arm.matrix_world @ arm.pose.bones["Bip01 Pelvis"].head
    return (p.x, p.y)


def loop_end(arm, start_f, lo, hi):
    """The frame in [lo, hi] whose pose is closest to the start pose."""
    ref = pose_sig(arm, start_f)
    best = None
    for f in range(int(lo), int(hi) + 1):
        d = sum((a - b) ** 2 for a, b in zip(pose_sig(arm, f), ref))
        if best is None or d < best[0]:
            best = (d, f)
    return best[1]


def action_channelbags(act):
    for layer in getattr(act, "layers", []):
        for strip in layer.strips:
            yield from getattr(strip, "channelbags", [])


def action_fcurves(act):
    """Blender 4.4+ layered actions keep F-curves in channelbags; older ones on action.fcurves."""
    if hasattr(act, "layers") and act.layers:
        for layer in act.layers:
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", []):
                    yield from bag.fcurves
    else:
        yield from getattr(act, "fcurves", [])


def rocketbox_rev():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", RB, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def main():
    summary = {"source": "Microsoft Rocketbox (MIT) https://github.com/microsoft/Microsoft-Rocketbox", "rocketbox": rocketbox_rev(),
               "avatars": {}, "anims": {}}
    for model in args.models:
        try:
            summary["avatars"][model] = build_avatar(model.replace("/", "__"), model)
        except Exception as e:  # QA sheet: note the odd one and keep going
            print(f"[humans] skip {model}: {e}")
    for ch in ([] if args.models else PLAN["characters"]):
        look = ch["look"]
        if look.get("kind") != "human" or not look.get("model"):
            continue
        if args.only and ch["id"] not in args.only:
            continue
        t = time.time()
        summary["avatars"][ch["id"]] = build_avatar(ch["id"], look["model"], look)
        a = summary["avatars"][ch["id"]]
        print(f"[humans] {ch['id']}: {look['model']} {a['tris']} tris, {a['bytes'] / 1e3:.0f} kB in {time.time() - t:.1f}s")
    if not args.no_anims:
        for sex in ("m", "f"):
            t = time.time()
            summary["anims"][sex] = build_anims(sex)
            print(f"[humans] anims-{sex}: {summary['anims'][sex]['bytes'] / 1e3:.0f} kB in {time.time() - t:.1f}s")
    json.dump(summary, open(os.path.join(args.out, "humans.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
