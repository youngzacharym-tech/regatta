# ============================================================================
# build_class_tokens.py — procedural class reliefs for the Master Killer
# tokens that have no hand-sculpted Nomad relief: Rogue, Warlock, Hunter,
# Barbarian, Bard. Replaces tools/out/build_rogue_token.py (whose flat,
# sharp-edged, untinted dagger was a self-described placeholder).
#
# Each relief is a smooth heightfield pillow raised from a 2D signed-distance
# field (unions/subtractions of polygons, circles, stadiums and rings), so it
# reads like the clay reliefs Kasen sculpted for Archer/Mage/Warrior/
# Necromancer/Cleric: rounded edges, flat-ish top, class-colored vertex paint
# on a team-tinted stone. Everything follows the fit envelope documented in
# art/tokens/README.md (radial <= 0.130, top <= z +0.038, base seated at
# z ~ +0.0128) and the conventions read off the shipped pieces-mk.glb:
#
#   * body tint  red team (0.90, 0.72, 0.56) / blue team (0.69, 0.72, 0.74)
#     (linear RGB — the warm/cool stone is what tells the teams apart; the
#     class relief is the SAME color on both, see applyTokenGeometries in
#     stage/src/main.ts for the mirror-match slate tint that builds on this)
#   * relief color = the class's DOCK_RING_TINTS hue, darkened to a matte
#     linear value the way the sculpted five are (roughly linear(UI) x 0.55,
#     nudged apart where two classes would collide — lime vs archer green,
#     ember vs necro red, magenta vs necro red)
#   * ~4000 verts per finished token (blank decimated to ~5500 tris, relief
#     to ~3000), one mesh, one material slot, COLOR_0 vertex paint
#
# Outputs (mirrors the per-class file set in art/tokens/):
#   art/tokens/decoration-<cls>.glb (+ -draco)   the relief alone, in place
#   art/tokens/token-<cls>-red.glb / -blue.glb (+ -draco)   finished tokens
#   tools/out/preview-class-tokens.png / -top.png            game-lit previews
# and, with REBUILD_PIECES_MK=1, rebuilds stage/public/pieces-mk.glb from the
# five hand-sculpted masters (art/tokens/token-{archer,mage,warrior,
# necromancer,cleric}-*.glb) plus these five — 20 tokens, Draco.
#
# Run headless:
#   "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --python tools/build_class_tokens.py
#   REBUILD_PIECES_MK=1 ...      <- also write stage/public/pieces-mk.glb
#   CLASSES=bard,hunter ...      <- build a subset (previews only; the glb
#                                   rebuild always needs all five)
# ============================================================================

import bpy
import math
import os
import numpy as np
from mathutils import Matrix, Vector

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOK = os.path.join(REPO, "art", "tokens")
OUT = os.path.join(REPO, "tools", "out")
PIECES_MK = os.path.join(REPO, "stage", "public", "pieces-mk.glb")
os.makedirs(OUT, exist_ok=True)

SCULPTED = ["archer", "mage", "warrior", "necromancer", "cleric"]
PROCEDURAL = ["rogue", "warlock", "hunter", "barbarian", "bard"]

# --- fit envelope (art/tokens/README.md) -----------------------------------
SEAT_Z = 0.0128          # face seat level; relief base sinks just under it
RELIEF_H = 0.022         # flat-top height above the seat (top z = 0.0348 < 0.038)
EDGE_R = 0.012           # horizontal radius of the rounded edge (pillow)
SKIRT_DROP = 0.004       # how far the outermost ring sinks into the stone
GRID_CELL = 0.0018       # heightfield resolution (~1.8 mm; decimated after)
GRID_HALF = 0.135        # covers the whole usable face (r <= 0.130)

BODY_TINT = {"red": (0.90, 0.72, 0.56), "blue": (0.69, 0.72, 0.74)}
CLASS_TINT = {
    "rogue": (0.16, 0.21, 0.29),      # moonlit steel   (DOCK_RING_TINTS.rogue)
    "warlock": (0.30, 0.46, 0.02),    # acid lime       (warlock)
    "hunter": (0.02, 0.36, 0.34),     # glacial teal    (hunter)
    "barbarian": (0.62, 0.17, 0.01),  # ember orange    (barbarian)
    "bard": (0.58, 0.03, 0.22),       # footlight magenta (bard)
}
BUDGET_BLANK_TRIS = 5500
BUDGET_RELIEF_TRIS = 3000


def log(*a):
    print("[build_class_tokens]", *a)


# ---------------------------------------------------------------------------
# 2D signed distance fields on a point cloud P (n, 2). Positive = inside.
# ---------------------------------------------------------------------------
def _seg_dist(P, a, b):
    a = np.asarray(a, float); b = np.asarray(b, float)
    e = b - a
    w = P - a
    denom = float(e @ e) or 1e-12
    t = np.clip((w @ e) / denom, 0.0, 1.0)
    return np.linalg.norm(w - t[:, None] * e, axis=1)


def sd_circle(P, c, r):
    return r - np.linalg.norm(P - np.asarray(c, float), axis=1)


def sd_stadium(P, a, b, r):
    """Capsule: segment a-b thickened by radius r."""
    return r - _seg_dist(P, a, b)


def sd_ring(P, a, b, R, t):
    """A chain link: the stadium of radius R around a-b, as a ring of
    thickness t (hollow inside)."""
    return t / 2 - np.abs(_seg_dist(P, a, b) - R)


def sd_polygon(P, poly):
    poly = np.asarray(poly, float)
    n = len(poly)
    d2 = np.full(len(P), np.inf)
    inside = np.zeros(len(P), dtype=bool)
    for i in range(n):
        a = poly[i]; b = poly[(i + 1) % n]
        e = b - a
        w = P - a
        denom = float(e @ e) or 1e-12
        t = np.clip((w @ e) / denom, 0.0, 1.0)
        d2 = np.minimum(d2, ((w - t[:, None] * e) ** 2).sum(1))
        # even-odd crossing test
        cond = (a[1] > P[:, 1]) != (b[1] > P[:, 1])
        ey = e[1] if abs(e[1]) > 1e-12 else 1e-12
        xint = a[0] + (P[:, 1] - a[1]) * e[0] / ey
        inside ^= cond & (P[:, 0] < xint)
    d = np.sqrt(d2)
    return np.where(inside, d, -d)


def union(*ds):
    return np.maximum.reduce(list(ds))


def subtract(d, cut):
    return np.minimum(d, -cut)


def rot(pts, deg, about=(0.0, 0.0)):
    """Rotate a list of 2D points (CCW, degrees) about a point."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    ax, ay = about
    return [(ax + (x - ax) * c - (y - ay) * s, ay + (x - ax) * s + (y - ay) * c) for x, y in pts]


def mirror_x(pts):
    return [(-x, y) for x, y in pts]


# ---------------------------------------------------------------------------
# The five motifs. Each returns a list of (sdf, height) "parts"; the relief
# surface is the max over parts of each part's pillow profile, so a lower
# part visibly passes UNDER a higher one where they cross (the crossed
# daggers, the chain links). Coordinates are the token's face plane, Y = the
# direction the shipped reliefs read as "up" (dagger tip, skull crown).
# ---------------------------------------------------------------------------
def motif_rogue(P):
    # Crossed daggers — the universal rogue emblem, bold enough to survive
    # the game camera (the retired placeholder's 36 mm blade did not).
    dagger = [
        (0.000, 0.108),                     # tip
        (-0.027, 0.036), (-0.054, 0.036), (-0.054, 0.019), (-0.017, 0.019),
        (-0.015, -0.056), (-0.019, -0.061), (-0.021, -0.077), (0.000, -0.092),
        (0.021, -0.077), (0.019, -0.061), (0.015, -0.056), (0.017, 0.019),
        (0.054, 0.019), (0.054, 0.036), (0.027, 0.036),
    ]
    dagger = [(x * 1.12, y * 1.12) for x, y in dagger]
    a = sd_polygon(P, rot(dagger, -32))
    b = sd_polygon(P, rot(dagger, 32))
    return [(a, RELIEF_H), (b, RELIEF_H - 0.005)]


def motif_warlock(P):
    # Curse of Chains: three stadium links along a diagonal, the middle one
    # a touch lower so it reads as threaded under its neighbours.
    parts = []
    pitch = 0.074
    for i, h in ((-1, RELIEF_H), (0, RELIEF_H - 0.005), (1, RELIEF_H)):
        cx, cy = rot([(i * pitch, 0.0)], 45)[0]
        a, b = rot([(cx - 0.025, cy), (cx + 0.025, cy)], 45, about=(cx, cy))
        parts.append((sd_ring(P, a, b, R=0.022, t=0.019), h))
    return parts


def motif_hunter(P):
    # Wolf's head, front on — ears, brow, cheeks, muzzle; slit eyes and a
    # nose sunk to the stone the way the necromancer's skull has its sockets.
    right = [
        (0.000, 0.040), (0.020, 0.048), (0.048, 0.098), (0.070, 0.045),
        (0.080, 0.010), (0.066, -0.030), (0.036, -0.062), (0.014, -0.090),
        (0.000, -0.095),
    ]
    head = right + list(reversed(mirror_x(right[1:-1])))
    d = sd_polygon(P, head)
    for sx in (1, -1):
        ea, eb = rot([(sx * 0.020, 0.008), (sx * 0.044, 0.008)], sx * 22,
                     about=(sx * 0.032, 0.008))
        d = subtract(d, sd_stadium(P, ea, eb, 0.0055))
    d = subtract(d, sd_circle(P, (0.0, -0.074), 0.0085))
    return [(d, RELIEF_H)]


def motif_barbarian(P):
    # Double-bladed axe (labrys) with a knobbed haft.
    blade_r = [
        (0.006, -0.020), (0.040, -0.036), (0.072, -0.024), (0.090, 0.004),
        (0.093, 0.030), (0.088, 0.058), (0.070, 0.082), (0.040, 0.094),
        (0.006, 0.080),
    ]
    d = union(
        sd_polygon(P, blade_r),
        sd_polygon(P, mirror_x(blade_r)),
        sd_stadium(P, (0.0, -0.100), (0.0, 0.088), 0.011),
        sd_circle(P, (0.0, -0.102), 0.016),
    )
    return [(d, RELIEF_H)]


def motif_bard(P):
    # Lute: pear body, neck, bent-back pegbox, soundhole open to the stone.
    shoulders = [(-0.046, -0.030), (-0.020, 0.018), (0.020, 0.018), (0.046, -0.030)]
    body = union(sd_circle(P, (0.0, -0.050), 0.052), sd_polygon(P, shoulders))
    neck = sd_stadium(P, (0.0, 0.010), (0.0, 0.086), 0.010)
    pegbox = sd_stadium(P, (0.0, 0.086), (0.024, 0.108), 0.012)
    d = union(body, neck, pegbox)
    d = subtract(d, sd_circle(P, (0.0, -0.042), 0.013))
    return [(d, RELIEF_H)]


MOTIFS = {
    "rogue": motif_rogue,
    "warlock": motif_warlock,
    "hunter": motif_hunter,
    "barbarian": motif_barbarian,
    "bard": motif_bard,
}


# ---------------------------------------------------------------------------
# Heightfield -> mesh
# ---------------------------------------------------------------------------
def pillow(d, h):
    """Rounded-edge profile: 0 at the outline, quarter-ellipse up to a flat
    top of height h reached EDGE_R inside the outline."""
    u = np.clip(d / EDGE_R, 0.0, 1.0)
    return h * np.sqrt(np.maximum(0.0, 1.0 - (1.0 - u) ** 2))


def make_relief(name, motif):
    n = int(round(2 * GRID_HALF / GRID_CELL)) + 1
    xs = np.linspace(-GRID_HALF, GRID_HALF, n)
    gx, gy = np.meshgrid(xs, xs, indexing="ij")
    P = np.stack([gx.ravel(), gy.ravel()], axis=1)
    parts = motif(P)
    dmax = np.maximum.reduce([d for d, _ in parts])
    height = np.maximum.reduce([pillow(d, h) for d, h in parts])
    r = np.linalg.norm(P, axis=1)
    assert r[dmax > 0].max() <= 0.130, f"{name}: relief exceeds the r=0.130 budget ({r[dmax > 0].max():.3f})"

    keep = (dmax > -1.6 * GRID_CELL).reshape(n, n)
    z = np.where(dmax > 0, SEAT_Z + height, SEAT_Z - SKIRT_DROP).reshape(n, n)
    idx = -np.ones((n, n), dtype=np.int64)
    ki, kj = np.nonzero(keep)
    idx[ki, kj] = np.arange(len(ki))
    verts = np.stack([gx[ki, kj], gy[ki, kj], z[ki, kj]], axis=1)
    # quads where all four corners survive
    q = (keep[:-1, :-1] & keep[1:, :-1] & keep[1:, 1:] & keep[:-1, 1:])
    qi, qj = np.nonzero(q)
    faces = np.stack([idx[qi, qj], idx[qi + 1, qj], idx[qi + 1, qj + 1], idx[qi, qj + 1]], axis=1)

    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.validate()
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    log(f"{name}: grid {n}x{n}, {len(verts)} verts, {len(faces)} quads, "
        f"footprint r<={r[dmax > 0].max():.3f}, top z={z.max():.4f}")
    return obj


# ---------------------------------------------------------------------------
# Blender plumbing (same conventions as build_assets.py / the old rogue script)
# ---------------------------------------------------------------------------
def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate_to(obj, budget):
    t = tri_count(obj)
    if t <= budget:
        return
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.ratio = budget / t
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def paint_uniform(obj, rgb):
    me = obj.data
    for attr in list(me.color_attributes):
        me.color_attributes.remove(attr)
    attr = me.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
    n = len(attr.data)
    cols = np.empty((n, 4), dtype=np.float32)
    cols[:, 0], cols[:, 1], cols[:, 2], cols[:, 3] = rgb[0], rgb[1], rgb[2], 1.0
    attr.data.foreach_set("color", cols.reshape(-1))
    me.color_attributes.active_color_index = me.color_attributes.find("Color")
    me.color_attributes.render_color_index = me.color_attributes.find("Color")


def matte_vertex_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.8
    vc = tree.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Color"
    tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def import_single_mesh(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    incoming = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    assert len(incoming) == 1, f"{path}: expected 1 mesh, got {len(incoming)}"
    for o in bpy.data.objects:
        if o not in before and o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    return incoming[0]


def export_glb(objs, path, draco=False):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, use_selection=True, export_format="GLB", export_yup=True,
              export_apply=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False)
    if draco:
        kw.update(export_draco_mesh_compression_enable=True,
                  export_draco_mesh_compression_level=10,
                  export_draco_position_quantization=11,
                  export_draco_normal_quantization=8,
                  export_draco_color_quantization=8,
                  export_draco_generic_quantization=10)
    bpy.ops.export_scene.gltf(**kw)
    log(f"exported {os.path.relpath(path, REPO)} ({os.path.getsize(path) / 1e3:.1f} KB)")


def build_token(blank_path, team, relief, cls):
    blank = import_single_mesh(blank_path)
    decimate_to(blank, BUDGET_BLANK_TRIS)
    paint_uniform(blank, BODY_TINT[team])
    blank.data.polygons.foreach_set("use_smooth", np.ones(len(blank.data.polygons), dtype=bool))

    dec = relief.copy()
    dec.data = relief.data.copy()
    bpy.context.scene.collection.objects.link(dec)

    bpy.ops.object.select_all(action="DESELECT")
    blank.select_set(True)
    dec.select_set(True)
    bpy.context.view_layer.objects.active = blank
    bpy.ops.object.join()
    name = f"token_{cls}_{team}"
    blank.name = name
    blank.data.name = name
    me = blank.data
    me.polygons.foreach_set("material_index", np.zeros(len(me.polygons), dtype=np.int32))
    while len(me.materials) > 1:
        me.materials.pop()
    if not me.materials:
        me.materials.append(matte_vertex_material(name + "_mat"))
    else:
        me.materials[0] = matte_vertex_material(name + "_mat")
    me.color_attributes.active_color_index = me.color_attributes.find("Color")
    me.color_attributes.render_color_index = me.color_attributes.find("Color")
    return blank


# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
wanted = [c for c in os.environ.get("CLASSES", ",".join(PROCEDURAL)).split(",") if c]
rebuild = os.environ.get("REBUILD_PIECES_MK") == "1"
if rebuild:
    assert set(wanted) == set(PROCEDURAL), "the pieces-mk.glb rebuild needs all five classes"

tokens = {}
for cls in wanted:
    relief = make_relief(f"decoration_{cls}", MOTIFS[cls])
    decimate_to(relief, BUDGET_RELIEF_TRIS)
    paint_uniform(relief, CLASS_TINT[cls])
    relief.data.materials.append(matte_vertex_material(f"decoration_{cls}_mat"))
    export_glb([relief], os.path.join(TOK, f"decoration-{cls}.glb"))
    export_glb([relief], os.path.join(TOK, f"decoration-{cls}-draco.glb"), draco=True)

    pair = {}
    for team in ("red", "blue"):
        tok = build_token(os.path.join(TOK, f"blank-coin-{team}.glb"), team, relief, cls)
        export_glb([tok], os.path.join(TOK, f"token-{cls}-{team}.glb"))
        export_glb([tok], os.path.join(TOK, f"token-{cls}-{team}-draco.glb"), draco=True)
        pair[team] = tok
        log(f"{tok.name}: {len(tok.data.vertices)} verts, {tri_count(tok)} tris")
    tokens[cls] = pair
    bpy.data.objects.remove(relief, do_unlink=True)

# ---------------------------------------------------------------------------
# pieces-mk.glb: the five sculpted masters + the five procedural pairs.
# ---------------------------------------------------------------------------
sculpted_objs = []
if rebuild:
    for cls in SCULPTED:
        for team in ("red", "blue"):
            o = import_single_mesh(os.path.join(TOK, f"token-{cls}-{team}.glb"))
            o.name = o.data.name = f"token_{cls}_{team}"
            sculpted_objs.append(o)
    all_tokens = sculpted_objs + [t for c in PROCEDURAL for t in (tokens[c]["red"], tokens[c]["blue"])]
    export_glb(all_tokens, PIECES_MK, draco=True)
    log(f"rebuilt pieces-mk.glb with {len(all_tokens)} tokens: {[o.name for o in all_tokens]}")
else:
    log("SKIPPED pieces-mk.glb rebuild (dry run — set REBUILD_PIECES_MK=1 to write it)")

# ---------------------------------------------------------------------------
# Preview renders: the new pairs in a row, game-lit, angled and top-down.
# ---------------------------------------------------------------------------
for o in sculpted_objs:
    o.hide_render = True
row = [t for c in wanted for t in (tokens[c]["red"], tokens[c]["blue"])]
for i, o in enumerate(row):
    o.matrix_world = Matrix.Translation(((i - (len(row) - 1) / 2) * 0.48, 0, 0))

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 240 * len(row)
scene.render.resolution_y = 520
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.35, 0.38, 1)
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (0.9, 0, 0.35)
scene.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
span = 0.48 * len(row) + 0.2

cam.data.type = "PERSP"
cam.data.angle = math.radians(35)
cam.location = Vector((0.0, -span * 1.35, span * 0.95))
cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.render.filepath = os.path.join(OUT, "preview-class-tokens.png")
bpy.ops.render.render(write_still=True)
log("rendered", scene.render.filepath)

cam.data.type = "ORTHO"
cam.data.ortho_scale = span
cam.location = Vector((0.0, 0.0, 2.0))
cam.rotation_euler = (0, 0, 0)
scene.render.filepath = os.path.join(OUT, "preview-class-tokens-top.png")
bpy.ops.render.render(write_still=True)
log("rendered", scene.render.filepath)
log("DONE")
