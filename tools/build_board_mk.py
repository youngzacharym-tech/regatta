# ============================================================================
# build_board_mk.py — Master Killer's own board: an original dark-stone arena
# built entirely from code. No sculpt and no third-party asset goes in, so the
# result is ours outright (it replaces the licensed pek_andrei board).
#
# Run headless (Windows):
#   "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --factory-startup --python tools/build_board_mk.py
#   (BOARD_PREVIEW=0 skips the EEVEE preview render)
#
# Outputs:
#   stage/public/board.glb        Draco, game space, loaded by main.ts
#   tools/out/board-mk-raw.glb    uncompressed copy for inspection
#   tools/out/board-mk-game.png   EEVEE preview from the game camera
#
# Tile x/z come from stage/src/layout.ts, so the board can never drift from
# the rules' coordinates; every tile top sits at TILE_TOP and layout.ts
# y = TILE_TOP + TOKEN_SEAT (FINISH_TOP for the finish pads).
#
# Layout (everything clear of the pieces that live on the tabletop —
# reserves at z +-2, coins at x -0.5, escaped figures at x > 2.3):
#   - masonry plinth from the table up to the deck, pilasters on the tile
#     boundaries, a coping slab whose top is the deck
#   - square tiles with row-coloured inlays (near red, far blue, middle
#     gold), round glowing medallions for shields, raised daises for finish,
#     all inside a raised gold-lined frame. Icons: an X on every home tile,
#     an infinity sign on the shared water, a pentagram on the shields
#   - crystal lanterns in the two empty side-row slots, corner turrets
#   - stairs at the front, a low crenellated wall at the back
#   - bookends on bastions in line with the middle row: a tall gothic spire
#     off the left end, a squat round keep off the right. Tall things go only
#     at the left: from the fixed camera, anything tall along the back hides
#     the far reserve row, and anything tall at the right hides the far
#     player's escaped figures.
# ============================================================================

import math
import os
import random
import re
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mkgeo import (Geo, aim, annulus, cbox, clear_scene, crystal, export_glb, frustum,  # noqa: E402
                   glow_material, make_obj, prism, strip, vertex_material)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "tools", "out")
os.makedirs(OUT, exist_ok=True)
PUBLIC_GLB = os.path.join(REPO, "stage", "public", "board.glb")
LAYOUT_TS = os.path.join(REPO, "stage", "src", "layout.ts")

rng = random.Random(20261025)


def log(*a):
    print("[board-mk]", *a, flush=True)


# --- game-space constants -----------------------------------------------------
TABLE_Y = -0.42      # tabletop surface (main.ts TABLE_Y)
TILE_TOP = 0.050
FINISH_TOP = 0.115
TOKEN_SEAT = 0.085   # layout y = surface + this
TILE = 0.48          # square tile edge
SHIELD_R = 0.262
DECK_X, DECK_Z = 2.44, 1.07   # deck slab (coping) half extents
CORE_X, CORE_Z = 2.36, 0.99   # plinth wall core half extents
STEP_RISE, STEP_RUN, STEPS = 0.07, 0.085, 5

# Linear vertex colours. Deliberately cool: the game's lamp is warm amber, so
# a neutral grey reads brown on screen; a violet-leaning slate reads as stone.
STONE = (0.060, 0.060, 0.080)
STONE_LIGHT = (0.085, 0.084, 0.108)
DECK = (0.036, 0.035, 0.048)
FLAG = (0.062, 0.060, 0.078)
TILE_RGB = (0.095, 0.092, 0.118)
SHIELD_RGB = (0.085, 0.078, 0.115)
RED_INLAY = (0.550, 0.060, 0.050)
BLUE_INLAY = (0.070, 0.150, 0.450)
GOLD_INLAY = (0.500, 0.360, 0.130)
IRON = (0.045, 0.045, 0.050)
SLATE_ROOF = (0.045, 0.040, 0.065)

# Emissive tints, kept under ~1.6 strength: the game tone-maps (ACES), and
# stronger emission clips to white instead of reading as violet.
VIOLET = (0.50, 0.18, 1.0)
LIGHT_VIOLET = (0.60, 0.35, 1.0)


def jit(rgb, amt):
    k = 1.0 + rng.uniform(-amt, amt)
    return (rgb[0] * k, rgb[1] * k, rgb[2] * k)


stone = Geo("board_stone", facing=True, ao=(TABLE_Y, 0.02, 0.55))
iron = Geo("board_iron")
glow_violet = Geo("board_glow_violet", colored=False)
glow_red = Geo("board_glow_red", colored=False)
glow_blue = Geo("board_glow_blue", colored=False)

# Point lights travel inside the GLB (KHR_lights_punctual): (x, y, z, candela).
LIGHTS = []


def pyramid_cap(g, x, z, half, y0, y1, rgb):
    frustum(g, x, z, half * math.sqrt(2), 0.0, y0, y1, 4, rgb, rot=math.pi / 4)


def pinnacle(x, z, half, y0, y1, rgb=STONE_LIGHT):
    """Square post with a moulded collar and a pointed cap (top at y1)."""
    body_top = y0 + (y1 - y0) * 0.62
    cbox(stone, (x, (y0 + body_top) / 2, z), (half * 2, body_top - y0, half * 2), jit(rgb, 0.08), b=0.010)
    cbox(stone, (x, body_top + 0.012, z), (half * 2.5, 0.024, half * 2.5), jit(rgb, 0.08), b=0.006)
    pyramid_cap(stone, x, z, half * 1.05, body_top + 0.024, y1, jit(rgb, 0.08))


def crystal_post(x, z, half, y0, y1):
    """Stair-head post crowned with a small violet crystal."""
    cbox(stone, (x, (y0 + y1) / 2, z), (half * 2, y1 - y0, half * 2), jit(STONE_LIGHT, 0.08), b=0.010)
    cbox(stone, (x, y1 + 0.012, z), (half * 2.6, 0.024, half * 2.6), jit(STONE_LIGHT, 0.08), b=0.006)
    crystal(glow_violet, x, z, y1 + 0.024, y1 + 0.13, 0.026, rot=0.4)


def tangent_rot(a):
    """rot for a box placed on a circle at angle a, its local x tangent."""
    return math.atan2(-math.cos(a), -math.sin(a))


# --- the tile grid (from layout.ts) -------------------------------------------

def read_layout():
    src = open(LAYOUT_TS, encoding="utf-8").read()
    out = {}
    for name in ("P1_TILES", "P2_TILES"):
        block = re.search(name + r"[^=]*=\s*\[(.*?)\];", src, re.S).group(1)
        pts = re.findall(r"x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)", block)
        assert len(pts) == 15, f"{name}: expected 15 tiles, got {len(pts)}"
        out[name] = [(float(px), float(pz)) for px, _, pz in pts]
    return out


LAYOUT = read_layout()
SHIELD_IDX = (3, 7, 13)
FINISH_IDX = 14

tiles = {}   # (x, z) rounded -> kind
for name in ("P1_TILES", "P2_TILES"):
    for i, (tx, tz) in enumerate(LAYOUT[name]):
        kind = "finish" if i == FINISH_IDX else ("shield" if i in SHIELD_IDX else "tile")
        tiles[(round(tx, 3), round(tz, 3))] = kind
log(f"{len(tiles)} board positions from layout.ts "
    f"({sum(1 for k in tiles.values() if k == 'shield')} shields, "
    f"{sum(1 for k in tiles.values() if k == 'finish')} finish pads)")


def row_inlay(z):
    if z > 0.3:
        return RED_INLAY
    if z < -0.3:
        return BLUE_INLAY
    return GOLD_INLAY


def build_tile(tx, tz):
    # A hair of height/twist per slab so the grid reads hand-laid, not CAD.
    hj = rng.uniform(-0.002, 0.002)
    cbox(stone, (tx, (TILE_TOP + hj) / 2, tz), (TILE, TILE_TOP + hj, TILE), jit(TILE_RGB, 0.12), b=0.014,
         rot=math.radians(rng.uniform(-1.0, 1.0)))
    inlay = row_inlay(tz)
    e = 0.212
    for p, q in (((-e, -e), (e, -e)), ((e, -e), (e, e)), ((e, e), (-e, e)), ((-e, e), (-e, -e))):
        strip(stone, (tx + p[0], tz + p[1]), (tx + q[0], tz + q[1]), TILE_TOP, 0.012, 0.003, inlay)
    # Tile icons (Zach's sheet, 2026-10-25): home tiles = X, the shared
    # water down the middle = infinity (shields keep the pentagram).
    if inlay is GOLD_INLAY:
        a, n = 0.150, 48   # lemniscate of Bernoulli, lying along the board
        pts = []
        for i in range(n + 1):
            t = 2 * math.pi * i / n
            d = 1 + math.sin(t) ** 2
            pts.append((tx + a * math.cos(t) / d, tz + a * math.sin(t) * math.cos(t) / d))
        for p, q in zip(pts, pts[1:]):
            strip(stone, p, q, TILE_TOP, 0.017, 0.004, inlay)
    else:
        sc = 0.112
        for p, q in (((-1, -1), (1, 1)), ((-1, 1), (1, -1))):
            strip(stone, (tx + p[0] * sc, tz + p[1] * sc), (tx + q[0] * sc, tz + q[1] * sc),
                  TILE_TOP, 0.018, 0.004, inlay)


def build_shield(tx, tz):
    col = jit(SHIELD_RGB, 0.05)
    frustum(stone, tx, tz, SHIELD_R, SHIELD_R, 0.0, TILE_TOP - 0.008, 40, col, top=False)
    frustum(stone, tx, tz, SHIELD_R, SHIELD_R - 0.010, TILE_TOP - 0.008, TILE_TOP, 40, col)
    annulus(glow_violet, tx, tz, 0.214, 0.238, TILE_TOP, 0.0025, 48, None)
    # Gold pentagram in a circle, one point toward the far side (screen-up
    # from the shared camera).
    r = 0.13
    pts = [(tx + r * math.cos(-math.pi / 2 + k * 2 * math.pi / 5),
            tz + r * math.sin(-math.pi / 2 + k * 2 * math.pi / 5)) for k in range(5)]
    for k in range(5):
        strip(stone, pts[k], pts[(k + 2) % 5], TILE_TOP, 0.014, 0.004, GOLD_INLAY)
    annulus(stone, tx, tz, 0.137, 0.148, TILE_TOP, 0.003, 40, GOLD_INLAY)


def build_finish(tx, tz):
    glow = glow_red if tz > 0 else glow_blue
    lo, hi = jit(STONE_LIGHT, 0.04), jit(TILE_RGB, 0.04)
    frustum(stone, tx, tz, 0.272, 0.272, 0.0, 0.052, 40, lo, top=False)
    frustum(stone, tx, tz, 0.272, 0.262, 0.052, 0.060, 40, lo)
    annulus(glow, tx, tz, 0.230, 0.256, 0.060, 0.0025, 48, None)
    frustum(stone, tx, tz, 0.214, 0.214, 0.060, FINISH_TOP - 0.008, 36, hi, top=False)
    frustum(stone, tx, tz, 0.214, 0.204, FINISH_TOP - 0.008, FINISH_TOP, 36, hi)
    inlay = row_inlay(tz)
    for k in range(4):
        a = k * math.pi / 4
        strip(stone, (tx + 0.15 * math.cos(a), tz + 0.15 * math.sin(a)),
              (tx - 0.15 * math.cos(a), tz - 0.15 * math.sin(a)), FINISH_TOP, 0.014, 0.004, inlay)


for (tx, tz), kind in sorted(tiles.items()):
    if kind == "tile":
        build_tile(tx, tz)
    elif kind == "shield":
        build_shield(tx, tz)
    else:
        build_finish(tx, tz)

# Four violet studs in the gap corners around the middle shield (tile 7).
mid_shield = next((x, z) for (x, z), k in tiles.items() if k == "shield" and abs(z) < 0.1)
for k in range(4):
    a = math.pi / 4 + k * math.pi / 2
    frustum(glow_violet, mid_shield[0] + 0.335 * math.cos(a), mid_shield[1] + 0.335 * math.sin(a),
            0.016, 0.012, 0.0, 0.010, 10, None)


# --- the plinth ----------------------------------------------------------------

cbox(stone, (0, -0.03, 0), (DECK_X * 2, 0.06, DECK_Z * 2), DECK, b=0.016)           # deck slab
cbox(stone, (0, -0.21, 0), (CORE_X * 2, 0.30, CORE_Z * 2), (0.025, 0.024, 0.030))  # wall core
cbox(stone, (0, -0.375, 0), (DECK_X * 2 + 0.04, 0.09, DECK_Z * 2 + 0.04), STONE, b=0.016)  # base

FRONT_STAIR = (-0.97, -0.03)   # x range incl. cheek walls
BASTION_Z = 0.30               # half width of the bastions at both ends


def subtract(a, b, skips):
    spans = [(a, b)]
    for s0, s1 in skips:
        nxt = []
        for p, q in spans:
            if q <= s0 or p >= s1:
                nxt.append((p, q))
            else:
                if p < s0:
                    nxt.append((p, s0))
                if q > s1:
                    nxt.append((s1, q))
        spans = nxt
    return spans


def masonry(axis, w_face, ns, u0, u1, skips, y0=-0.33, y1=-0.06, rows=3):
    """Running-bond blocks proud of a wall face. axis 'x': the wall runs along
    x at z = w_face (outward normal ns * +z); axis 'z': along z at x = w_face."""
    rh = (y1 - y0) / rows
    gap = 0.009
    for r in range(rows):
        u = u0 - rng.uniform(0.0, 0.2)
        yc = y0 + rh * (r + 0.5)
        while u < u1:
            L = rng.uniform(0.13, 0.27)
            for a, b in subtract(max(u, u0), min(u + L, u1), skips):
                if b - a < 0.04:
                    continue
                d = rng.uniform(0.014, 0.024)
                wc = w_face + ns * (d / 2 - 0.004)
                ln = b - a - gap
                col = jit(STONE, 0.16)
                if axis == "x":
                    cbox(stone, ((a + b) / 2, yc, wc), (ln, rh - gap, d), col, b=0.006, bottom=True)
                else:
                    cbox(stone, (wc, yc, (a + b) / 2), (d, rh - gap, ln), col, b=0.006, bottom=True)
            u += L


masonry("x", CORE_Z, 1, -CORE_X, CORE_X, [FRONT_STAIR])
masonry("x", -CORE_Z, -1, -CORE_X, CORE_X, [])
masonry("z", -CORE_X, -1, -CORE_Z, CORE_Z, [(-BASTION_Z, BASTION_Z)])
masonry("z", CORE_X, 1, -CORE_Z, CORE_Z, [(-BASTION_Z, BASTION_Z)])

# Pilasters on the tile boundaries (front/back) and row boundaries (ends),
# plus heavier corner piers that hide the masonry seams.
for bx in [round(-2.159 + 0.5398 * k, 3) for k in range(9)]:
    for ns in (1, -1):
        if ns == 1 and FRONT_STAIR[0] - 0.04 < bx < FRONT_STAIR[1] + 0.04:
            continue
        cbox(stone, (bx, -0.195, ns * (CORE_Z + 0.028)), (0.075, 0.27, 0.056), jit(STONE_LIGHT, 0.06), b=0.008)
for bz in (-0.81, 0.81):
    for ns in (1, -1):
        cbox(stone, (ns * (CORE_X + 0.028), -0.195, bz), (0.056, 0.27, 0.075), jit(STONE_LIGHT, 0.06), b=0.008)
for sx in (-1, 1):
    for sz in (-1, 1):
        cbox(stone, (sx * (CORE_X + 0.02), -0.195, sz * (CORE_Z + 0.02)), (0.13, 0.27, 0.13),
             jit(STONE_LIGHT, 0.06), b=0.010)

# Raised frame around the tile field, gold line on top. It sits just outside
# the finish daises (z up to 0.861); the flagstone band starts beyond it.
FRAME_X, FRAME_Z, FRAME_W = 2.20, 0.895, 0.045
for sx in (-1, 1):
    cbox(stone, (sx * FRAME_X, 0.016, 0), (FRAME_W, 0.032, FRAME_Z * 2 + FRAME_W), jit(STONE_LIGHT, 0.04), b=0.008)
    strip(stone, (sx * FRAME_X, -FRAME_Z), (sx * FRAME_X, FRAME_Z), 0.032, 0.010, 0.003, GOLD_INLAY)
for sz in (-1, 1):
    cbox(stone, (0, 0.016, sz * FRAME_Z), (FRAME_X * 2 + FRAME_W, 0.032, FRAME_W), jit(STONE_LIGHT, 0.04), b=0.008)
    strip(stone, (-FRAME_X, sz * FRAME_Z), (FRAME_X, sz * FRAME_Z), 0.032, 0.010, 0.003, GOLD_INLAY)
GRID_X, GRID_Z = FRAME_X + FRAME_W / 2, FRAME_Z + FRAME_W / 2

# Flagstones on the deck band outside the frame.
for axis, (w0, w1), (a0, a1) in (
    ("x", (GRID_Z + 0.012, DECK_Z - 0.03), (-DECK_X + 0.03, DECK_X - 0.03)),
    ("x", (-DECK_Z + 0.03, -GRID_Z - 0.012), (-DECK_X + 0.03, DECK_X - 0.03)),
    ("z", (-DECK_X + 0.03, -GRID_X - 0.012), (-GRID_Z - 0.012, GRID_Z + 0.012)),
    ("z", (GRID_X + 0.012, DECK_X - 0.03), (-GRID_Z - 0.012, GRID_Z + 0.012)),
):
    u = a0
    while u < a1 - 0.05:
        L = min(rng.uniform(0.2, 0.38), a1 - u)
        hgt = 0.012 + rng.uniform(-0.003, 0.003)
        wc, wd = (w0 + w1) / 2, (w1 - w0) - 0.012
        if axis == "x":
            cbox(stone, (u + L / 2, hgt / 2, wc), (L - 0.012, hgt, wd), jit(FLAG, 0.18), b=0.005)
        else:
            cbox(stone, (wc, hgt / 2, u + L / 2), (wd, hgt, L - 0.012), jit(FLAG, 0.18), b=0.005)
        u += L


# --- stairs ------------------------------------------------------------------

def stairs(axis, sign, c0, c1):
    """STEPS steps from the deck edge down to the table. axis 'z': front
    stairs over x in [c0, c1] toward +z; axis 'x': end stairs over z in
    [c0, c1] toward sign * x."""
    inner = CORE_Z if axis == "z" else CORE_X
    edge = DECK_Z if axis == "z" else DECK_X
    for k in range(1, STEPS + 1):
        top = -STEP_RISE * k
        depth = edge + STEP_RUN * k - inner
        h = top - TABLE_Y
        mid = sign * (inner + depth / 2)
        if axis == "z":
            cbox(stone, ((c0 + c1) / 2, TABLE_Y + h / 2, mid), (c1 - c0, h, depth), jit(STONE_LIGHT, 0.08), b=0.008)
        else:
            cbox(stone, (mid, TABLE_Y + h / 2, (c0 + c1) / 2), (depth, h, c1 - c0), jit(STONE_LIGHT, 0.08), b=0.008)
    # Cheek walls: flat top by the deck, sloping down to the table.
    reach = edge + STEP_RUN * STEPS + 0.06
    outline = [(inner, TABLE_Y), (reach, TABLE_Y), (reach, -0.30), (inner + 0.11, 0.05), (inner, 0.05)]
    pts = [(u * sign, v) for u, v in outline]
    if sign < 0:
        pts.reverse()
    for e, d in ((c0, -1), (c1, 1)):
        cw = e + d * 0.045
        if axis == "z":
            prism(stone, pts, (cw - 0.045, 0, 0), (0, 0, 1), (0, 1, 0), (1, 0, 0), 0.09, jit(STONE, 0.08))
            crystal_post(cw, sign * (inner + 0.05), 0.05, 0.05, 0.22)
            pinnacle(cw, sign * (reach - 0.05), 0.055, TABLE_Y, -0.16)
        else:
            prism(stone, pts, (0, 0, cw - 0.045), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.09, jit(STONE, 0.08))
            pinnacle(sign * (inner + 0.05), cw, 0.05, 0.05, 0.25)
            pinnacle(sign * (reach - 0.05), cw, 0.055, TABLE_Y, -0.16)


stairs("z", 1, FRONT_STAIR[0] + 0.09, FRONT_STAIR[1] - 0.09)


# --- parapets, corner turrets ----------------------------------------------------
# Kept low: anything along the back taller than ~0.35 starts hiding the far
# player's reserve figures (z -1.9) from the fixed camera.

def parapet(axis, fixed, a0, a1):
    L = a1 - a0
    mid = (a0 + a1) / 2
    if axis == "x":
        cbox(stone, (mid, 0.045, fixed), (L, 0.09, 0.08), jit(STONE, 0.06), b=0.010)
    else:
        cbox(stone, (fixed, 0.045, mid), (0.08, 0.09, L), jit(STONE, 0.06), b=0.010)
    n = max(1, int(L / 0.25))
    step = L / n
    for k in range(n):
        u = a0 + step * (k + 0.5)
        if axis == "x":
            cbox(stone, (u, 0.125, fixed), (step * 0.52, 0.07, 0.09), jit(STONE_LIGHT, 0.08), b=0.008)
        else:
            cbox(stone, (fixed, 0.125, u), (0.09, 0.07, step * 0.52), jit(STONE_LIGHT, 0.08), b=0.008)


def turret(x, z, tall):
    """Corner turret. Front ones get a cone roof; back ones stay squat (top
    under ~0.32) so they never cover the far reserve row."""
    r = 0.115
    body_top = 0.26 if tall else 0.18
    frustum(stone, x, z, r, r * 0.95, 0.0, body_top, 16, jit(STONE, 0.05), top=False)
    frustum(stone, x, z, r * 0.95, r * 1.18, body_top, body_top + 0.03, 16, STONE_LIGHT, top=False)
    frustum(stone, x, z, r * 1.18, r * 1.18, body_top + 0.03, body_top + 0.06, 16, jit(STONE_LIGHT, 0.05))
    for k in range(7):
        a = 2 * math.pi * k / 7
        cbox(stone, (x + r * 1.08 * math.cos(a), body_top + 0.085, z + r * 1.08 * math.sin(a)),
             (0.045, 0.05, 0.035), jit(STONE_LIGHT, 0.08), rot=tangent_rot(a))
    if tall:
        frustum(stone, x, z, r * 1.0, 0.0, body_top + 0.06, body_top + 0.26, 16, SLATE_ROOF)
        crystal(glow_violet, x, z, body_top + 0.25, body_top + 0.31, 0.014)
    else:
        crystal(glow_violet, x, z, body_top + 0.06, body_top + 0.13, 0.022)
    cbox(glow_violet, (x + r * 0.96 * math.cos(1.0), body_top * 0.55, z + r * 0.96 * math.sin(1.0)),
         (0.022, 0.06, 0.012), None, rot=tangent_rot(1.0), bottom=True)


parapet("x", -(DECK_Z - 0.05), -DECK_X + 0.12, DECK_X - 0.12)
for sx in (-1, 1):
    parapet("z", sx * (DECK_X - 0.05), -DECK_Z + 0.12, -BASTION_Z - 0.02)
    parapet("z", sx * (DECK_X - 0.05), BASTION_Z + 0.02, DECK_Z - 0.12)
    for sz in (-1, 1):
        turret(sx * (DECK_X - 0.09), sz * (DECK_Z - 0.09), tall=sz > 0)


# --- crystal lanterns in the empty side-row slots --------------------------------
# Tops stay under y ~0.55: anything taller in the near row starts covering the
# middle-row tile behind it from the camera.

for lx, lz in ((0.27, 0.539), (0.27, -0.539)):
    assert (round(lx, 3), round(lz, 3)) not in tiles, "lantern slot collides with a tile"
    cbox(stone, (lx, 0.025, lz), (0.25, 0.05, 0.25), jit(STONE_LIGHT, 0.05), b=0.014)
    cbox(stone, (lx, 0.12, lz), (0.12, 0.14, 0.12), jit(STONE, 0.05), b=0.012)
    cbox(stone, (lx, 0.197, lz), (0.17, 0.018, 0.17), jit(STONE_LIGHT, 0.05), b=0.006)
    for sx in (-1, 1):
        for sz in (-1, 1):
            cbox(iron, (lx + sx * 0.068, 0.31, lz + sz * 0.068), (0.014, 0.21, 0.014), IRON)
    cbox(iron, (lx, 0.421, lz), (0.18, 0.016, 0.18), IRON, b=0.004)
    pyramid_cap(iron, lx, lz, 0.085, 0.429, 0.51, IRON)
    frustum(iron, lx, lz, 0.011, 0.011, 0.51, 0.545, 6, IRON)
    crystal(glow_violet, lx, lz, 0.215, 0.405, 0.050, rot=0.3)
    LIGHTS.append((lx, 0.31, lz, 0.55))


# --- the two ends: gothic spire (left) and squat keep (right) ---------------------
# Each stands on a bastion jutting from the centre of its end, in line with the
# middle row: a matched pair of bookends. From the camera, nothing important
# sits behind the left end at this depth (the far reserve row is checked to
# x -2.98), so the spire can be tall; behind the right end sit the far
# player's ESCAPED figures, so the keep stays under y ~0.85.

def lancet(x, z, a, r, yc, h, w):
    """Glowing pointed window on a round/octagonal wall at angle a."""
    wx, wz = x + r * math.cos(a), z + r * math.sin(a)
    cbox(glow_violet, (wx, yc, wz), (w, h, 0.016), None, rot=tangent_rot(a), bottom=True)
    pyramid_cap(glow_violet, wx, wz, w * 0.5, yc + h / 2, yc + h / 2 + w * 0.8, None)


def bastion(sign):
    """Deck-height platform off one end (sign -1 left, +1 right); returns its
    centre x."""
    x0, x1 = sign * DECK_X, sign * 2.98
    cx = (x0 + x1) / 2
    depth = abs(x1 - x0)
    cbox(stone, (cx - sign * 0.04, -0.21, 0), (depth + 0.08, 0.30, BASTION_Z * 2), (0.025, 0.024, 0.030))
    cbox(stone, (cx + sign * 0.02, -0.03, 0), (depth + 0.04, 0.06, BASTION_Z * 2 + 0.08), DECK, b=0.016)
    cbox(stone, (cx + sign * 0.03, -0.375, 0), (depth + 0.06, 0.09, BASTION_Z * 2 + 0.12), STONE, b=0.016)
    masonry("z", x1, sign, -BASTION_Z, BASTION_Z, [])
    lo, hi = sorted((x1, x0 - sign * 0.08))
    masonry("x", BASTION_Z, 1, lo, hi, [])
    masonry("x", -BASTION_Z, -1, lo, hi, [])
    for sz in (-1, 1):
        cbox(stone, (x1 + sign * 0.02, -0.195, sz * (BASTION_Z + 0.02)), (0.12, 0.27, 0.12),
             jit(STONE_LIGHT, 0.06), b=0.010)
        pinnacle(x1 - sign * 0.035, sz * (BASTION_Z + 0.005), 0.040, 0.0, 0.22)
    return cx + sign * 0.02


# Gothic spire: square plinth, octagonal shaft with two tiers of lancets, a
# pinnacled gallery, then a slate spire with crockets and a crystal finial.
SX = bastion(-1)
cbox(stone, (SX, 0.035, 0), (0.34, 0.07, 0.34), jit(STONE, 0.05), b=0.014)
cbox(stone, (SX, 0.08, 0), (0.38, 0.02, 0.38), STONE_LIGHT, b=0.006)
frustum(stone, SX, 0, 0.145, 0.135, 0.09, 0.64, 8, jit(STONE, 0.04), top=False, rot=math.pi / 8)
frustum(stone, SX, 0, 0.150, 0.150, 0.30, 0.325, 8, STONE_LIGHT, top=False, rot=math.pi / 8)
for k in range(8):
    a = 2 * math.pi * k / 8
    if math.cos(a - math.radians(66)) > -0.2:   # only the camera-facing sides
        lancet(SX, 0, a, 0.130, 0.20, 0.13, 0.032)
        lancet(SX, 0, a, 0.127, 0.47, 0.11, 0.028)
frustum(stone, SX, 0, 0.135, 0.172, 0.64, 0.68, 8, STONE_LIGHT, top=False, rot=math.pi / 8)
frustum(stone, SX, 0, 0.172, 0.172, 0.68, 0.71, 8, jit(STONE_LIGHT, 0.04), rot=math.pi / 8)
for k in range(8):
    a = 2 * math.pi * k / 8
    pinnacle(SX + 0.158 * math.cos(a), 0.158 * math.sin(a), 0.018, 0.71, 0.83)
frustum(stone, SX, 0, 0.122, 0.0, 0.71, 1.55, 8, SLATE_ROOF, rot=math.pi / 8)
for k in range(8):
    a = 2 * math.pi * k / 8 + math.pi / 8
    for t in (0.18, 0.36, 0.54, 0.72):
        rr = 0.127 * (1 - t)
        cbox(stone, (SX + rr * math.cos(a), 0.71 + 0.84 * t, rr * math.sin(a)), (0.022, 0.03, 0.022),
             STONE_LIGHT, rot=tangent_rot(a))
crystal(glow_violet, SX, 0, 1.53, 1.66, 0.028, rot=0.3)
LIGHTS.append((SX, 1.45, 0.0, 0.5))

# Squat round keep: corbelled battlement and a brazier holding the beacon.
KX = bastion(1)
R = 0.215
frustum(stone, KX, 0, R + 0.01, R, 0.0, 0.46, 24, jit(STONE, 0.04), top=False)
frustum(stone, KX, 0, R + 0.012, R + 0.012, 0.20, 0.225, 24, STONE_LIGHT, top=False)
for k in range(22):
    a = 2 * math.pi * (k + 0.5) / 22
    cbox(stone, (KX + R * math.cos(a), 0.445, R * math.sin(a)), (0.03, 0.045, 0.045),
         jit(STONE_LIGHT, 0.08), rot=tangent_rot(a))
frustum(stone, KX, 0, R - 0.005, R + 0.04, 0.46, 0.51, 24, STONE_LIGHT, top=False)
frustum(stone, KX, 0, R + 0.04, R + 0.04, 0.51, 0.57, 24, jit(STONE, 0.04))
for k in range(9):
    a = 2 * math.pi * k / 9
    cbox(stone, (KX + (R + 0.02) * math.cos(a), 0.61, (R + 0.02) * math.sin(a)), (0.075, 0.08, 0.06),
         jit(STONE_LIGHT, 0.08), b=0.008, rot=tangent_rot(a))
for ang in (75, 115, 155):
    lancet(KX, 0, math.radians(ang), R - 0.003, 0.12, 0.10, 0.032)
    lancet(KX, 0, math.radians(ang + 20), R - 0.003, 0.34, 0.08, 0.028)
frustum(stone, KX, 0, 0.05, 0.05, 0.57, 0.60, 12, STONE_LIGHT, top=False)
frustum(stone, KX, 0, 0.05, 0.085, 0.60, 0.65, 12, STONE_LIGHT)
crystal(glow_violet, KX, 0, 0.62, 0.84, 0.055, rot=0.2)
LIGHTS.append((KX, 0.78, 0.0, 0.8))


# --- objects, materials, export ---------------------------------------------------

clear_scene()
objs = [
    make_obj(stone, vertex_material("mk_stone", 0.88), smooth_angle=35),
    make_obj(iron, vertex_material("mk_iron", 0.45, metal=0.8)),
    make_obj(glow_violet, glow_material("mk_glow_violet", VIOLET, 1.6)),
    make_obj(glow_red, glow_material("mk_glow_red", (1.0, 0.18, 0.06), 1.4)),
    make_obj(glow_blue, glow_material("mk_glow_blue", (0.15, 0.38, 1.0), 1.4)),
]
LIGHTS.append((0.0, 1.7, 0.1, 0.9))   # faint violet wash over the whole field
for i, (lx, ly, lz, cd) in enumerate(LIGHTS):
    ld = bpy.data.lights.new(f"mk_light_{i}", "POINT")
    ld.energy = cd
    ld.color = LIGHT_VIOLET
    ld.shadow_soft_size = 0.05
    lo = bpy.data.objects.new(f"mk_light_{i}", ld)
    lo.location = (lx, ly, lz)
    bpy.context.scene.collection.objects.link(lo)
    objs.append(lo)
log(f"{sum(g.tris() for g in (stone, iron, glow_violet, glow_red, glow_blue)):,} triangles, "
    f"{len(LIGHTS)} point lights")

export_glb(objs, os.path.join(OUT, "board-mk-raw.glb"), draco=False, lights=True, log=log)
export_glb(objs, PUBLIC_GLB, draco=True, lights=True, log=log)


# --- preview (EEVEE; the real check is the game itself) --------------------------

if os.environ.get("BOARD_PREVIEW", "1") == "1":
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.009, 0.007, 1)
    scene.world = world
    table = Geo("table")
    cbox(table, (-0.15, TABLE_Y - 0.05, 0.15), (8.7, 0.1, 5.8), (0.10, 0.055, 0.028))
    make_obj(table, vertex_material("table", 0.95))
    lamp = bpy.data.objects.new("lamp", bpy.data.lights.new("lamp", "SPOT"))
    lamp.data.energy = 900
    lamp.data.color = (1.0, 0.79, 0.54)
    lamp.data.spot_size = math.pi / 2.2
    lamp.data.spot_blend = 0.6
    scene.collection.objects.link(lamp)
    aim(lamp, (-1.0, 5.6, 1.4), (-0.4, 0, 0))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle = math.radians(45)
    aim(cam, (-0.5, 4.6, 5.0), (-0.5, 0.15, 0.95))
    scene.render.filepath = os.path.join(OUT, "board-mk-game.png")
    bpy.ops.render.render(write_still=True)
    log("rendered", os.path.relpath(scene.render.filepath, REPO))

log("DONE")
