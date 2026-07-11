// ============================================================================
// layout.ts — where each abstract tile sits in the .glb's world space.
//
// This is the ONE file to re-tune when a new board mesh replaces regatta.glb.
// No THREE dependency — just numbers — so it can also be consumed by
// raycasting / tap detection later.
//
// Rulebook path (15 tiles per player):
//   0..3   own safe start row  (4 tiles, right-to-left, tile 3 is shield)
//   4..11  contested middle    (8 tiles, left-to-right, tile 7 is shield)
//   12..13 own safe finish row (2 tiles, right-to-left, tile 13 is shield)
//   14     finish tile         (right-to-left continuation, exact roll to enter)
//
// These coordinates are MEASURED, not eyeballed: the board GLB is exported
// from regatta-board.blend already in game space (tile-grid centered at
// origin, long axis on X, scale 0.02), and each entry below is the actual
// center of the hand-placed tile stamp, printed by build_board.py during
// export. Per-tile y = stamp top surface + half a token's height.
//
// The board mesh is MIRRORED in main.ts (boardGroup.scale.x = -1) to face
// the direction Regatta's board normally does, so every measured x below is
// negated relative to build_board.py's output.
//
// P1 = red row (near camera, +Z). P2 = blue row (far, -Z). Middle contested
// row is shared, so entries 4..11 are identical in both arrays.
// ============================================================================

import type { PlayerId } from "../../rulebook.ts";

export interface WorldPos {
  x: number;
  y: number;
  z: number;
}

const P1_TILES: WorldPos[] = [
  { x: -0.266, y: 0.178, z: 0.540 }, // 0
  { x: -0.806, y: 0.186, z: 0.540 }, // 1
  { x: -1.346, y: 0.172, z: 0.540 }, // 2
  { x: -1.886, y: 0.185, z: 0.540 }, // 3  SHIELD
  { x: -1.886, y: 0.176, z: 0.060 }, // 4
  { x: -1.348, y: 0.170, z: 0.048 }, // 5
  { x: -0.808, y: 0.170, z: 0.048 }, // 6
  { x: -0.242, y: 0.178, z: -0.009 }, // 7  SHIELD
  { x: 0.292, y: 0.176, z: 0.033 },  // 8
  { x: 0.820, y: 0.195, z: 0.042 },  // 9
  { x: 1.368, y: 0.161, z: 0.056 },  // 10
  { x: 1.886, y: 0.170, z: 0.068 },  // 11
  { x: 1.835, y: 0.212, z: 0.529 },  // 12
  { x: 1.296, y: 0.227, z: 0.540 },  // 13 SHIELD
  { x: 0.620, y: 0.194, z: 0.540 },  // 14 FINISH
];

const P2_TILES: WorldPos[] = [
  { x: -0.266, y: 0.195, z: -0.540 }, // 0
  { x: -0.806, y: 0.195, z: -0.540 }, // 1
  { x: -1.352, y: 0.198, z: -0.521 }, // 2
  { x: -1.886, y: 0.178, z: -0.540 }, // 3  SHIELD
  { x: -1.886, y: 0.176, z: 0.060 },  // 4
  { x: -1.348, y: 0.170, z: 0.048 },  // 5
  { x: -0.808, y: 0.170, z: 0.048 },  // 6
  { x: -0.242, y: 0.178, z: -0.009 }, // 7  SHIELD
  { x: 0.292, y: 0.176, z: 0.033 },   // 8
  { x: 0.820, y: 0.195, z: 0.042 },   // 9
  { x: 1.368, y: 0.161, z: 0.056 },   // 10
  { x: 1.886, y: 0.170, z: 0.068 },   // 11
  { x: 1.831, y: 0.195, z: -0.511 },  // 12
  { x: 1.306, y: 0.180, z: -0.511 },  // 13 SHIELD
  { x: 0.634, y: 0.196, z: -0.540 },  // 14 FINISH
];

export function tileWorldPos(player: PlayerId, tile: number): WorldPos {
  return (player === "p1" ? P1_TILES : P2_TILES)[tile];
}

const OFF_BOARD_Y = 0.18;

/** Reserve pool sits off the board past the start end (-X), own side.
 *  Spacing fits the sculpted tokens (0.485 wide). */
export function reservePos(player: PlayerId, slot: number): WorldPos {
  return {
    x: -1.9 - slot * 0.52,
    y: OFF_BOARD_Y,
    z: player === "p1" ? 1.65 : -1.65,
  };
}

/** Escaped tokens line up past the finish end (+X), own side. */
export function escapedPos(player: PlayerId, slot: number): WorldPos {
  return {
    x: 2.3 + slot * 0.52,
    y: OFF_BOARD_Y,
    z: player === "p1" ? 1.65 : -1.65,
  };
}
