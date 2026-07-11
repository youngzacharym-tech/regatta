# ============================================================================
# build_assets.py — turn Kasen's Nomad-painted "Matcap regatta.glb" into the
# game's regatta.glb (board) and pieces.glb (tokens + per-player coins).
#
# Run headless:
#   /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_assets.py
#
# Source model override:  REGATTA_SRC=/path/to/model.glb
#
# What it does:
#   1. Imports the painted GLB (board, tile frames, deck zone planes, glyph
#      stamps, finish medallions, player discs, coin disc).
#   2. Fits a similarity transform mapping the sculpt's tile grid onto the
#      game's world space (derived from the tile frames themselves), applies
#      it to everything. The game's board mirror hack is removed, so the
#      export IS world space.
#   3. Measures every tile center and writes tools/layout_measured.ts for
#      stage/src/layout.ts.
#   4. Builds coin_red / coin_blue = coin disc + blossom/star glyph relief.
#   5. Normalizes materials (matte), decimates to web budgets, exports
#      tools/out/regatta-raw.glb + pieces-raw.glb (Draco step is separate),
#      and renders preview PNGs to tools/out/.
# ============================================================================

import bpy
import json
import math
import os
import sys
import numpy as np
from mathutils import Matrix, Vector

SRC = os.environ.get("REGATTA_SRC", "/Users/myrm/Desktop/Matcap regatta.glb")
# Kasen's per-piece painted exports (same Nomad scene coordinates as SRC).
# When present, they replace the scene's white PlayerA/B sculpts as tokens.
# Note the crossover: PlayerB is painted RED and the viewer is always red
# (token_p1), so B goes to p1 and the blue-painted A to p2.
#
# FIXME (2026-07-11): that crossover put STAR tokens on the blossom-stamped
# red field (and blossoms on the star field). The Soulframe reference pairs
# red BLOSSOM tokens with the red blossom shore. pieces.glb has been
# corrected downstream (tokens rebuilt from the original sculpts: PlayerA
# blossom -> token_p1 painted red, PlayerB star -> token_p2 painted blue).
# Next time these are regenerated from the painted sources, repaint to match:
# blossom sculpt in red for p1, star sculpt in blue for p2.
TOKEN_SRC = {
    "token_p1": os.environ.get("REGATTA_TOKEN_A", "/Users/myrm/Downloads/Regatta_PlayerB color.glb"),
    "token_p2": os.environ.get("REGATTA_TOKEN_B", "/Users/myrm/Downloads/Regatta_PlayerA color.glb"),
}
# Kasen's metal roll coin (painted, metallic material baked in the GLB).
# When present it becomes BOTH players' coin sets as-is — no glyph composite,
# and its metal material is preserved rather than normalized to matte.
COIN_SRC = os.environ.get("REGATTA_COIN", "/Users/myrm/Downloads/Regatta_Coin_001 color.glb")
EXTERNAL_COIN = bool(COIN_SRC and os.path.exists(COIN_SRC))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "tools", "out")
os.makedirs(OUT, exist_ok=True)

# Objects that are painting helpers / strays in the sculpt scene, not art.
EXCLUDE = {
    "Plane - individual.15", "Plane - individual.16",   # black frames (gaps)
    "Plane - individual.19", "Plane - individual.20",
    "Stamps 17",                                        # sunk below the deck
    "Regatta_Finish 1",   # unpainted duplicate shell covering the painted pad
}
ZONE_PLANES = {"Plane", "Plane 1", "Plane 2", "Plane 3", "Plane 4", "Plane 5", "Plane 6"}
RED_GLYPH_SRC = "Stamps 14"   # blossom relief (red-tinted)
BLUE_GLYPH_SRC = "Stamps 18"  # star relief (blue-tinted)

# Game-space constants measured from the original board/layout.ts:
MID_ROW_SPAN = 3.772          # tile 4 .. tile 11 world-x span
ROW_SEPARATION = 1.08         # red row z=+0.54 .. blue row z=-0.54
TOKEN_SEAT = 0.085            # layout y = stamp top + this (token base offset)

# Decimation budgets (triangles per object)
BUDGETS = {
    "board": 200_000,
    "stamp": 8_000,
    "blossom": 40_000,   # the blossom glyph is dozens of tiny petal islands —
    "frame": 2_500,      # aggressive collapse shreds it, so it gets headroom
    "zone": 1_500,
    "finish": 9_000,
    "token": 25_000,
    "coin_disc": 10_000,
    "coin_glyph": 30_000,
}
# Red-tinted blossom stamps (verified by vertex-color tint in the source).
BLOSSOM_STAMPS = {"Stamps", "Stamps 14", "Stamps 15", "Stamps 16"}

def log(*a):
    print("[build_assets]", *a)
    sys.stdout.flush()

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
log("importing", SRC)
bpy.ops.import_scene.gltf(filepath=SRC)
log("imported", len(bpy.data.objects), "objects")

def world_bbox(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx, (mn + mx) / 2

def tri_count(obj):
    m = obj.data
    m.calc_loop_triangles()
    return len(m.loop_triangles)

# ---------------------------------------------------------------------------
# Classify
# ---------------------------------------------------------------------------
groups = {"board": [], "frame": [], "zone": [], "stamp": [], "finish": [],
          "token_p1": [], "token_p2": [], "coin": [], "excluded": []}
for obj in list(bpy.data.objects):
    if obj.type != "MESH":
        continue
    n = obj.name
    if n in EXCLUDE:
        groups["excluded"].append(obj)
    elif n == "Regatta_Board.001":
        groups["board"].append(obj)
    elif n in ZONE_PLANES:
        groups["zone"].append(obj)
    elif n.startswith("Plane - individual") or n == "middle 1":
        groups["frame"].append(obj)
    elif n.startswith("Stamps"):
        groups["stamp"].append(obj)
    elif n.startswith("Regatta_Finish"):
        groups["finish"].append(obj)
    elif n == "Regatta_PlayerA":
        groups["token_p1"].append(obj)
    elif n == "Regatta_PlayerB":
        groups["token_p2"].append(obj)
    elif n == "Regatta_Coin":
        groups["coin"].append(obj)
    else:
        log("WARNING: unrecognized mesh object excluded:", n)
        groups["excluded"].append(obj)

counts = {k: len(v) for k, v in groups.items()}
log("classified:", counts)
assert counts["board"] == 1 and counts["frame"] == 20 and counts["stamp"] == 20, counts
assert counts["token_p1"] == 1 and counts["token_p2"] == 1 and counts["coin"] == 1, counts

for obj in groups["excluded"]:
    bpy.data.objects.remove(obj, do_unlink=True)
groups.pop("excluded")

# Swap in the individually painted token GLBs (exported in the same scene
# space, so they ride the same alignment transform as everything else).
overrides = dict(TOKEN_SRC)
if EXTERNAL_COIN:
    overrides["coin"] = COIN_SRC
for key, path in overrides.items():
    if not path or not os.path.exists(path):
        log(f"NOTE: no painted override for {key}, using scene sculpt")
        continue
    for old in groups[key]:
        bpy.data.objects.remove(old, do_unlink=True)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    incoming = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    assert len(incoming) == 1, f"{path}: expected 1 mesh, got {len(incoming)}"
    obj = incoming[0]
    obj.data.color_attributes.active_color_index = 0  # COLOR_0 = the paint
    groups[key] = [obj]
    log(f"{key} <- {os.path.basename(path)} ({tri_count(obj):,} tris)")

board_objs = groups["board"] + groups["frame"] + groups["zone"] + groups["stamp"] + groups["finish"]
piece_objs = groups["token_p1"] + groups["token_p2"] + groups["coin"]

# ---------------------------------------------------------------------------
# Un-bury stamps: a few glyph reliefs sit below their deck zone plane in the
# sculpt scene (invisible in-game). Raise any stamp whose top doesn't clear
# the tallest zone plane under it. (Blender coords here: Z is up.)
# ---------------------------------------------------------------------------
zone_boxes = [world_bbox(o) for o in groups["zone"]]
for st in groups["stamp"]:
    mn, mx, c = world_bbox(st)
    tops = [zmx.z for zmn, zmx, zc in zone_boxes
            if zmn.x - 1 <= c.x <= zmx.x + 1 and zmn.y - 1 <= c.y <= zmx.y + 1]
    if not tops:
        continue
    plane_top = max(tops)
    if mx.z < plane_top + 0.03:
        dz = plane_top + 0.05 - mx.z
        st.matrix_world = Matrix.Translation((0.0, 0.0, dz)) @ st.matrix_world
        log(f"raised buried stamp {st.name} by {dz:.2f}")
bpy.context.view_layer.update()

# ---------------------------------------------------------------------------
# Fit the similarity transform from the sculpt's tile grid.
# Blender coords here (Z up). Length axis of the sculpt = +Y, width = X.
# Game space in Blender coords: game_x -> X, game_z -> -Y, game_y (up) -> Z.
# ---------------------------------------------------------------------------
frame_centers = {o.name: world_bbox(o)[2] for o in groups["frame"]}

xs = sorted(c.x for c in frame_centers.values())
# Cluster frame x into 3 rows (they differ by ~24.6 units)
rows = []
for x in xs:
    for r in rows:
        if abs(r[0] - x) < 8:
            r.append(x)
            break
    else:
        rows.append([x])
assert len(rows) == 3, f"expected 3 rows, got {len(rows)}"
rows = [sum(r) / len(r) for r in sorted(rows, key=lambda r: -len(r) * 0 + r[0])]
row_by_size = sorted(([x for x in rows],), key=len)  # noqa - keep simple below
mid_candidates = sorted(rows, key=lambda rx: -sum(1 for c in frame_centers.values() if abs(c.x - rx) < 8))
mid_x = mid_candidates[0]
outer = sorted([r for r in rows if r != mid_x])
low_x, high_x = outer[0], outer[1]

# Which outer row is red? The red deck zone plane ("Plane") tells us.
red_zone_x = world_bbox(bpy.data.objects["Plane"])[2].x
red_x = high_x if abs(high_x - red_zone_x) < abs(low_x - red_zone_x) else low_x
blue_x = low_x if red_x == high_x else high_x
log(f"rows: mid={mid_x:.2f} red={red_x:.2f} blue={blue_x:.2f}")

mid_frames = [c for c in frame_centers.values() if abs(c.x - mid_x) < 8]
assert len(mid_frames) == 8, len(mid_frames)
mid_ys = sorted(c.y for c in mid_frames)
yc = sum(mid_ys) / len(mid_ys)
xc = mid_x

s_len = MID_ROW_SPAN / (mid_ys[-1] - mid_ys[0])
s_wid = ROW_SEPARATION / abs(red_x - blue_x)
s = (s_len + s_wid) / 2
log(f"scale: len={s_len:.6f} wid={s_wid:.6f} -> {s:.6f} (drift {abs(s_len-s_wid)/s*100:.2f}%)")

# Start end (red/blue zone) must sit at LOW sculpt y -> game -X.
# Sanity: the 4-frame side of an outer row is the start side.
red_frames_y = sorted(c.y for c in frame_centers.values() if abs(c.x - red_x) < 8)
assert len(red_frames_y) == 6, len(red_frames_y)
start_cluster = [y for y in red_frames_y if y < yc]
assert len(start_cluster) == 4, "expected 4 start tiles on the low-y side"

# Red row must land at game z=+0.54 => Blender y' = -0.54 => y' = -s*(x - xc)
# needs red_x > xc. Assert, since the sign is baked into the matrix below.
assert red_x > xc, "red row expected on +X side of the sculpt"

M = Matrix((
    (0.0,  s,   0.0, -s * yc),
    (-s,   0.0, 0.0,  s * xc),
    (0.0,  0.0, s,    0.0),
    (0.0,  0.0, 0.0,  1.0),
))
assert M.to_3x3().determinant() > 0, "transform must be a proper rotation"

for obj in board_objs + piece_objs:
    obj.matrix_world = M @ obj.matrix_world
bpy.context.view_layer.update()
log("transform applied")

# ---------------------------------------------------------------------------
# Measure tile centers -> layout arrays (game coords: gx=X, gz=-Y, gy=Z)
# ---------------------------------------------------------------------------
def game_xyz(v):
    return (v.x, v.z, -v.y)  # (game_x, game_y, game_z)

f_centers = {o.name: game_xyz(world_bbox(o)[2]) for o in groups["frame"]}
stamp_info = []
for o in groups["stamp"]:
    mn, mx, c = world_bbox(o)
    stamp_info.append({"name": o.name, "gx": c.x, "gz": -c.y, "top": mx.z})
finish_info = []
for o in groups["finish"]:
    mn, mx, c = world_bbox(o)
    finish_info.append({"name": o.name, "gx": c.x, "gz": -c.y, "top": mx.z})

def tile_y(gx, gz, fallback_top=None):
    near = [st for st in stamp_info if abs(st["gx"] - gx) < 0.30 and abs(st["gz"] - gz) < 0.30]
    if near:
        return max(st["top"] for st in near) + TOKEN_SEAT
    assert fallback_top is not None, f"no stamp near tile ({gx:.2f},{gz:.2f})"
    return fallback_top + TOKEN_SEAT

def build_row(row_frames, finish_circles):
    """row_frames: [(gx,gy,gz)] for one outer row; returns 15 tile positions."""
    start = sorted([f for f in row_frames if f[0] < 0.5], key=lambda f: -f[0])
    fin = sorted([f for f in row_frames if f[0] >= 0.5], key=lambda f: -f[0])
    assert len(start) == 4 and len(fin) == 2, (len(start), len(fin))
    mid = sorted([f_centers[n] for n in f_centers
                  if abs(f_centers[n][2]) < 0.3], key=lambda f: f[0])
    assert len(mid) == 8, len(mid)
    fc_gx = sum(f["gx"] for f in finish_circles) / len(finish_circles)
    fc_gz = sum(f["gz"] for f in finish_circles) / len(finish_circles)
    fc_top = max(f["top"] for f in finish_circles)
    tiles = []
    for gx, gy, gz in start:                     # 0..3
        tiles.append((gx, tile_y(gx, gz), gz))
    for gx, gy, gz in mid:                       # 4..11
        tiles.append((gx, tile_y(gx, gz), gz))
    for gx, gy, gz in fin:                       # 12..13
        tiles.append((gx, tile_y(gx, gz), gz))
    tiles.append((fc_gx, tile_y(fc_gx, fc_gz, fc_top), fc_gz))  # 14 finish
    return tiles

p1_frames = [v for v in f_centers.values() if v[2] > 0.3]
p2_frames = [v for v in f_centers.values() if v[2] < -0.3]
p1_fin = [f for f in finish_info if f["gz"] > 0]
p2_fin = [f for f in finish_info if f["gz"] < 0]
assert len(p1_frames) == 6 and len(p2_frames) == 6, (len(p1_frames), len(p2_frames))
assert len(p1_fin) >= 1 and len(p2_fin) >= 1, (len(p1_fin), len(p2_fin))

P1 = build_row(p1_frames, p1_fin)
P2 = build_row(p2_frames, p2_fin)

SHIELDS = {3, 7, 13}
def ts_row(tiles):
    lines = []
    for i, (x, y, z) in enumerate(tiles):
        tag = "  SHIELD" if i in SHIELDS else (" FINISH" if i == 14 else "")
        lines.append(f"  {{ x: {x:.3f}, y: {y:.3f}, z: {z:.3f} }}, // {i}{tag}")
    return "\n".join(lines)

layout_ts = (
    "// Measured by tools/build_assets.py from the painted board sculpt.\n"
    "// Board GLB is exported directly in world space (no runtime mirror).\n"
    f"const P1_TILES: WorldPos[] = [\n{ts_row(P1)}\n];\n\n"
    f"const P2_TILES: WorldPos[] = [\n{ts_row(P2)}\n];\n"
)
with open(os.path.join(OUT, "layout_measured.ts"), "w") as fh:
    fh.write(layout_ts)
log("layout measured:\n" + layout_ts)

# ---------------------------------------------------------------------------
# Coin composites (game scale now): disc + glyph relief on the +Z(up) face
# ---------------------------------------------------------------------------
def duplicate(obj, name):
    d = obj.copy()
    d.data = obj.data.copy()
    d.name = name
    d.data.name = name
    bpy.context.scene.collection.objects.link(d)
    return d

# Soulframe-matched piece design colors (linear RGB): muted brick red for the
# viewer's blossom, steel blue for the opponent's star.
BRICK_RED = (0.45, 0.045, 0.04)
STEEL_BLUE = (0.05, 0.11, 0.33)

def set_colors(obj, rgb, only_above_z=None):
    """Overwrite vertex colors (linear) — whole mesh, or only vertices above a
    z threshold (used to tint just the raised relief of a piece)."""
    me = obj.data
    attr = me.color_attributes.active_color
    n = len(attr.data)
    cols = np.empty(n * 4, dtype=np.float32)
    attr.data.foreach_get("color", cols)
    cols = cols.reshape(-1, 4)
    if only_above_z is None:
        mask = np.ones(n, dtype=bool)
    else:
        vs = np.empty(len(me.vertices) * 3, dtype=np.float64)
        me.vertices.foreach_get("co", vs)
        vz = vs.reshape(-1, 3)[:, 2]
        vmask = vz > only_above_z
        if attr.domain == "POINT":
            mask = vmask
        else:  # CORNER domain — map loops to their vertices
            li = np.empty(len(me.loops), dtype=np.int64)
            me.loops.foreach_get("vertex_index", li)
            mask = vmask[li]
    cols[mask, 0] = rgb[0]
    cols[mask, 1] = rgb[1]
    cols[mask, 2] = rgb[2]
    attr.data.foreach_set("color", cols.reshape(-1))
    return int(mask.sum()), n

def decimate_to(obj, budget):
    t = tri_count(obj)
    if t <= budget:
        return
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.ratio = budget / t
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=mod.name)

def weather_wood(obj, strength=0.55):
    """Break up the flat brown hull with organic grime + grain so it reads as
    aged, tarnished wood instead of one clean solid color. Multiplies the
    baked vertex colors by a position-driven noise (darker in the low/recessed
    grain, subtle desaturation), no textures needed. Runs BEFORE decimation so
    the pattern survives the collapse. Coords here are game-space post-M
    (long axis on X, up on Z)."""
    me = obj.data
    attr = me.color_attributes.active_color
    n = len(attr.data)
    cols = np.empty(n * 4, dtype=np.float32)
    attr.data.foreach_get("color", cols)
    cols = cols.reshape(-1, 4)
    # per-color-entry world position
    wm = np.array(obj.matrix_world)
    vco = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", vco)
    vco = vco.reshape(-1, 3)
    vworld = (vco @ wm[:3, :3].T) + wm[:3, 3]
    if attr.domain == "POINT":
        pos = vworld
    else:
        li = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", li)
        pos = vworld[li]
    x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
    # organic multi-octave blotch noise in [0,1]
    def bump(f, px, pz):
        return (np.sin(x * f + px) * np.cos(z * f * 1.31 + pz)
                + np.sin(z * f * 0.7 + 1.7) * np.cos(x * f * 1.13 + 0.5))
    nz = bump(1.7, 0, 0) + 0.5 * bump(3.9, 1.2, 2.0) + 0.28 * bump(8.3, 0.4, 3.1)
    nz = (nz - nz.min()) / (nz.max() - nz.min() + 1e-9)          # blotchy grime
    # Wavy, frequency-jittered grain — a plain sin(x*k) makes clean vertical
    # bands on the hull faces, which reads as a lighting artifact.
    gfreq = 21.0 + 7.0 * np.sin(z * 2.3 + nz * 3.0)
    grain = 0.5 + 0.5 * np.sin(x * gfreq + np.sin(z * 11.7) * 3.5 + nz * 8.0)
    lowlight = np.clip((z.max() - z) / (z.max() - z.min() + 1e-9), 0, 1)
    darken = 1.0 - strength * (0.70 * nz + 0.0 * (1.0 - grain) + 0.24 * lowlight)  # grain term OFF: any periodic term reads as artificial stripes
    # weathered wood also greys out slightly — pull each color a touch toward
    # its own luma so the brown desaturates where it's most worn.
    luma = (0.3 * cols[:, 0] + 0.59 * cols[:, 1] + 0.11 * cols[:, 2])[:, None]
    desat = (0.30 * nz)[:, None]
    cols[:, :3] = (cols[:, :3] * (1 - desat) + luma * desat) * darken[:, None]
    attr.data.foreach_set("color", cols.reshape(-1))
    log(f"weathered {obj.name}: darken range "
        f"{darken.min():.2f}..{darken.max():.2f}")

def make_coin(color_name, glyph_src_name, glyph_tint=None):
    coin = duplicate(groups["coin"][0], color_name)
    glyph = duplicate(bpy.data.objects[glyph_src_name], color_name + "_glyph")
    # Decimate the parts SEPARATELY before joining — the glyph relief needs
    # far more triangle headroom than the plain disc.
    decimate_to(coin, BUDGETS["coin_disc"])
    decimate_to(glyph, BUDGETS["coin_glyph"])
    c_mn, c_mx, c_c = world_bbox(coin)
    g_mn, g_mx, g_c = world_bbox(glyph)
    # Scale the stamp to 65% of the coin diameter, centered on itself. Squash
    # it 15% in Z so the whole stamp (its base plate included) fits INSIDE the
    # disc — a taller stamp pokes out the underside and stains the blank face.
    target = 0.65 * (c_mx.x - c_mn.x)
    factor = target / max(g_mx.x - g_mn.x, 1e-9)
    S = Matrix.Diagonal((factor, factor, factor * 0.85, 1.0))
    glyph.matrix_world = (Matrix.Translation(g_c) @ S @ Matrix.Translation(-g_c)) @ glyph.matrix_world
    bpy.context.view_layer.update()
    # Stamp anatomy (measured): a dense base plate at the bottom, a tall empty
    # gap, then the floating design layer in the top ~5% of the height — the
    # board shows glyphs by burying everything but that top layer in the deck.
    # Do the same here: put the top 6% of the stamp above the coin face, so
    # the full design layer shows and the plate hides inside the disc.
    glyph.data.transform(glyph.matrix_world)
    glyph.matrix_world = Matrix.Identity(4)
    # obj.bound_box is stale right after a mesh-data transform — measure from
    # the vertices themselves.
    vs = np.empty(len(glyph.data.vertices) * 3, dtype=np.float64)
    glyph.data.vertices.foreach_get("co", vs)
    vs = vs.reshape(-1, 3)
    g_lo, g_hi = vs.min(0), vs.max(0)
    height = g_hi[2] - g_lo[2]
    dz = (c_mx.z + 0.06 * height) - g_hi[2]
    dxy = (c_c.x - (g_lo[0] + g_hi[0]) / 2, c_c.y - (g_lo[1] + g_hi[1]) / 2, dz)
    glyph.data.transform(Matrix.Translation(dxy))
    bpy.context.view_layer.update()
    # Color AFTER final placement: the stamp goes white everywhere (so any
    # part visible through the disc shell reads as blank), then only the
    # design layer poking above the coin face gets the player color.
    set_colors(glyph, (1.0, 1.0, 1.0))
    tinted, total = set_colors(glyph, glyph_tint, only_above_z=c_mx.z + 0.0002)
    log(f"{color_name}: glyph height {height:.4f}, pokes {0.06 * height:.4f}, "
        f"tinted {tinted}/{total} color entries above the face")
    with bpy.context.temp_override(active_object=coin, selected_editable_objects=[coin, glyph]):
        bpy.ops.object.join()
    coin.name = color_name
    coin.data.name = color_name
    # Collapse to ONE material slot so the coin exports as a single glTF
    # primitive — the game reads mesh.geometry and a multi-primitive mesh
    # loads as a Group with no geometry of its own.
    me = coin.data
    me.polygons.foreach_set("material_index", np.zeros(len(me.polygons), dtype=np.int32))
    while len(me.materials) > 1:
        me.materials.pop()
    return coin

if EXTERNAL_COIN:
    # Kasen's painted metal coin, used verbatim for both sets.
    coin_red = duplicate(groups["coin"][0], "coin_red")
    coin_blue = duplicate(groups["coin"][0], "coin_blue")
    for c in (coin_red, coin_blue):
        decimate_to(c, 25_000)
    log("coins from painted metal GLB:", tri_count(coin_red), "tris each")
else:
    coin_red = make_coin("coin_red", RED_GLYPH_SRC, glyph_tint=BRICK_RED)
    coin_blue = make_coin("coin_blue", BLUE_GLYPH_SRC, glyph_tint=STEEL_BLUE)
    log("coins composited: coin_red", tri_count(coin_red), "tris; coin_blue", tri_count(coin_blue))

tok1 = groups["token_p1"][0]; tok1.name = "token_p1"; tok1.data.name = "token_p1"
tok2 = groups["token_p2"][0]; tok2.name = "token_p2"; tok2.data.name = "token_p2"
bpy.data.objects.remove(groups["coin"][0], do_unlink=True)  # bare disc no longer needed
piece_final = [tok1, tok2, coin_red, coin_blue]

# Bake transforms into piece meshes and center each at the origin —
# the game reads pieces.glb geometry directly and ignores node transforms.
# Center from actual vertex data (obj.bound_box is stale right after a
# mesh-data transform, which silently offsets the export).
# Pieces are also scaled to Soulframe proportions: raw sculpts fill the whole
# tile, the reference pieces sit inside it.
PIECE_SCALE = {"token_p1": 0.78, "token_p2": 0.78, "coin_red": 0.85, "coin_blue": 0.85}
for obj in piece_final:
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)
    me = obj.data
    vs = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", vs)
    vs = vs.reshape(-1, 3)
    c = (vs.min(0) + vs.max(0)) / 2
    me.transform(Matrix.Translation((-c[0], -c[1], -c[2])))
    me.transform(Matrix.Scale(PIECE_SCALE[obj.name], 4))
bpy.context.view_layer.update()

# Tokens carry Kasen's own paint (the per-piece color GLBs) — no tinting.
for obj in piece_final:
    mn, mx, _ = world_bbox(obj)
    log(f"piece {obj.name}: size=({mx.x-mn.x:.3f},{mx.y-mn.y:.3f},{mx.z-mn.z:.3f})")

# ---------------------------------------------------------------------------
# Materials: matte paint everywhere + make sure vertex color reaches BaseColor
# ---------------------------------------------------------------------------
def fix_material(mat, mesh_has_color):
    if not mat or not mat.use_nodes:
        return
    tree = mat.node_tree
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        return
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.8
    base = bsdf.inputs["Base Color"]
    has_vc = any(n.type in ("VERTEX_COLOR", "ATTRIBUTE") for n in tree.nodes)
    if mesh_has_color and not has_vc:
        vc = tree.nodes.new("ShaderNodeVertexColor")
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[7].default_value = tuple(base.default_value)  # A = old base color
        tree.links.new(vc.outputs["Color"], mix.inputs[6])       # B = vertex color
        tree.links.new(mix.outputs[2], base)

for obj in board_objs + piece_final:
    if EXTERNAL_COIN and obj.name.startswith("coin_"):
        continue  # keep the painted metal material as authored
    has_color = bool(obj.data.color_attributes)
    for slot in obj.material_slots:
        fix_material(slot.material, has_color)
log("materials normalized")

# Tarnish the bare wood hull so it doesn't read as one clean solid brown.
for obj in groups["board"]:
    if obj.data.color_attributes:
        weather_wood(obj)

def granitize(obj):
    """Give the finish score pads a polished-stone read: fine mineral speckle
    plus faint veining in the vertex colors, and a smoother material."""
    me = obj.data
    attr = me.color_attributes.active_color
    n = len(attr.data)
    cols = np.empty(n * 4, dtype=np.float32)
    attr.data.foreach_get("color", cols)
    cols = cols.reshape(-1, 4)
    wm = np.array(obj.matrix_world)
    vco = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", vco)
    vworld = (vco.reshape(-1, 3) @ wm[:3, :3].T) + wm[:3, 3]
    if attr.domain == "POINT":
        pos = vworld
    else:
        li = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", li)
        pos = vworld[li]
    x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
    speckle = np.sin(x * 260 + z * 231) * np.sin(x * 187 - z * 293) * np.sin(z * 341 + x * 149)
    vein = np.abs(np.sin(x * 9.0 + np.sin(z * 7.0) * 1.8 + z * 4.0))
    shade = 1.0 - 0.05 * (speckle > 0.55) - 0.07 * (vein < 0.06)
    cols[:, :3] *= shade[:, None]
    attr.data.foreach_set("color", cols.reshape(-1))
    for slot in obj.material_slots:
        if slot.material and slot.material.use_nodes:
            bsdf = next((nd for nd in slot.material.node_tree.nodes
                         if nd.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                bsdf.inputs["Roughness"].default_value = 0.34
                bsdf.inputs["Metallic"].default_value = 0.03
    log(f"granitized {obj.name}")

for obj in groups["finish"]:
    if obj.data.color_attributes:
        granitize(obj)

# ---------------------------------------------------------------------------
# Decimate
# ---------------------------------------------------------------------------
def budget_for(obj):
    n = obj.name
    if n == "Regatta_Board.001": return BUDGETS["board"]
    if n in ("token_p1", "token_p2"): return BUDGETS["token"]
    if n in ("coin_red", "coin_blue"): return None  # already decimated pre-join
    if n in BLOSSOM_STAMPS: return BUDGETS["blossom"]
    if n.startswith("Stamps"): return BUDGETS["stamp"]
    if n.startswith("Regatta_Finish"): return BUDGETS["finish"]
    if n in ZONE_PLANES: return BUDGETS["zone"]
    return BUDGETS["frame"]

total_before = total_after = 0
for obj in board_objs + piece_final:
    t = tri_count(obj)
    total_before += t
    b = budget_for(obj)
    if b is not None:
        decimate_to(obj, b)
    total_after += tri_count(obj)
log(f"decimated: {total_before:,} -> {total_after:,} tris")

# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    kwargs = dict(filepath=path, export_format="GLB", use_selection=True,
                  export_yup=True, export_apply=True, export_animations=False,
                  export_skins=False, export_morph=False)
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="ACTIVE",
                                  export_all_vertex_colors=False)
    except TypeError:
        try:
            bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="ACTIVE")
        except TypeError:
            bpy.ops.export_scene.gltf(**kwargs)
    log("exported", path, f"{os.path.getsize(path)/1e6:.1f} MB")

export(board_objs, os.path.join(OUT, "regatta-raw.glb"))
export(piece_final, os.path.join(OUT, "pieces-raw.glb"))

# ---------------------------------------------------------------------------
# Preview renders (EEVEE): match the game camera, plus straight top-down
# ---------------------------------------------------------------------------
for obj in piece_final:
    obj.hide_render = True

scene = bpy.context.scene
for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        continue
scene.render.resolution_x = 1600
scene.render.resolution_y = 950
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.35, 0.38, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
scene.collection.objects.link(sun)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.angle = math.radians(45)

# Game camera: pos (-0.5, 4.8, 4.8) looking at (-0.5, 0.15, 0)  [game coords]
cam.location = Vector((-0.5, -4.8, 4.8))          # blender coords (y = -game_z)
look = Vector((-0.5, 0.0, 0.15))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.render.filepath = os.path.join(OUT, "preview-game-angle.png")
bpy.ops.render.render(write_still=True)
log("rendered", scene.render.filepath)

cam.location = Vector((0.0, 0.0, 8.0))
cam.rotation_euler = (0.0, 0.0, math.radians(-90))  # top-down, +game_x to the right
scene.render.filepath = os.path.join(OUT, "preview-top.png")
bpy.ops.render.render(write_still=True)
log("rendered", scene.render.filepath)

for obj in piece_final:
    obj.hide_render = False
for obj in board_objs:
    obj.hide_render = True
spread = {"token_p1": (-0.9, 0), "token_p2": (-0.3, 0), "coin_red": (0.3, 0), "coin_blue": (0.9, 0)}
for obj in piece_final:
    gx, gz = spread[obj.name]
    obj.matrix_world = Matrix.Translation((gx, -gz, 0.06))
cam.location = Vector((0.0, -1.9, 1.1))
look = Vector((0.0, 0.0, 0.05))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.render.filepath = os.path.join(OUT, "preview-pieces.png")
bpy.ops.render.render(write_still=True)
log("rendered", scene.render.filepath)

log("DONE")
