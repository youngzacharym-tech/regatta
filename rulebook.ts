// ============================================================================
// RULEBOOK — pure game logic for Regatta.
//
// No graphics, no networking, no I/O, no randomness inside the pure functions.
// Both the Stage (client) and the Referee (server) import from this file so
// they always agree on what's legal and what a move does.
//
// Design principles:
//   - GameState is immutable. Every function returns a NEW state.
//   - No side effects. Coin flips happen OUTSIDE the pure functions; the
//     caller passes the result in.
//   - Rules are DATA at the top of the file. Behavior functions read them.
//     Flip a constant, get a different rule variant. No hunting through logic.
// ============================================================================


// ============================================================================
// DESIGN DECISIONS (locked in from user Q&A)
//
//   Q1  Path length            = 15 tiles per player (4 safe + 8 contested + 2 safe + 1 finish)
//   Q2  Landing on own token   = blocked (illegal move)
//   Q3  Captured token         = back off the board (into reserve, -1)
//   Q4  Exit rule              = exact roll required to finish. The finish
//                                spot (index 14) is the ESCAPE, not a tile a
//                                token sits on: land on it with the exact
//                                flip and the token leaves the board
//                                immediately. Overshoot/undershoot = no move.
//                                (Settled 2026-07-10 after two play-tests.)
//   Q5  Shield tile does TWO things:
//         (a) protects the token standing on it from being captured
//         (b) grants the mover another flip + move
//   Q6  No legal move          = turn skips to the other player
//   Q7  Symmetry               = a Stage concern (see note at bottom of file);
//                                the Rulebook uses one abstract 0..14 path,
//                                both players walk it.
//
// Change any of these and the logic below follows the constants automatically.
// ============================================================================

export const TOKENS_PER_PLAYER = 4;
export const COINS_PER_PLAYER = 4;
export const PATH_LENGTH_PER_PLAYER = 15;


// ============================================================================
// BOARD LAYOUT
//
// The path is a linear sequence of tiles from index 0 (start) to
// PATH_LENGTH_PER_PLAYER - 1 (finish). A tile can be:
//   - safe      : only this player can occupy
//   - contested : both players can occupy; captures happen here
//   - sword     : contested, and captures are the whole point of the tile
//   - shield    : landing here grants extra turn AND protects from capture
//   - finish    : the last tile before the token escapes the board
//
// The Sword/Shield mix in the middle is a first guess based on the wiki
// description — the actual Regatta board may differ. Tune indices/types
// as we learn the real layout.
// ============================================================================

export type TileType = "safe" | "contested" | "sword" | "shield" | "finish";

export interface Tile {
  index: number;
  type: TileType;
  /** True if the opponent's tokens can also occupy this tile. */
  isContested: boolean;
}

export const BOARD_LAYOUT: Tile[] = [
  // --- own safe start row (4 tiles) — only own tokens; last tile is a shield ---
  { index: 0,  type: "safe",   isContested: false },
  { index: 1,  type: "safe",   isContested: false },
  { index: 2,  type: "safe",   isContested: false },
  { index: 3,  type: "shield", isContested: false }, // 4th tile of safe row
  // --- contested middle row (8 tiles) — swords, with one shield at 4th position ---
  { index: 4,  type: "sword",  isContested: true  }, // 1st of middle
  { index: 5,  type: "sword",  isContested: true  }, // 2nd
  { index: 6,  type: "sword",  isContested: true  }, // 3rd
  { index: 7,  type: "shield", isContested: true  }, // 4th — middle shield
  { index: 8,  type: "sword",  isContested: true  }, // 5th
  { index: 9,  type: "sword",  isContested: true  }, // 6th
  { index: 10, type: "sword",  isContested: true  }, // 7th
  { index: 11, type: "sword",  isContested: true  }, // 8th (last of middle)
  // --- own safe finish row (2 tiles) — last tile is a shield ---
  { index: 12, type: "safe",   isContested: false },
  { index: 13, type: "shield", isContested: false }, // shield at last safe tile
  // --- finish tile — exact roll to enter ---
  { index: 14, type: "finish", isContested: false },
];


// ============================================================================
// STATE TYPES
// ============================================================================

export type PlayerId = "p1" | "p2";

export interface TokenState {
  /** Unique ID across the whole game (0..7). */
  id: number;
  owner: PlayerId;
  /**
   *  -1                      : not yet on the board (reserve)
   *  0..PATH_LENGTH-1        : on a tile
   *  PATH_LENGTH             : escaped (won)
   */
  position: number;
}

export interface GameState {
  tokens: TokenState[];
  currentPlayer: PlayerId;
  /** Number of marked-side-up coins, or null if we haven't flipped yet this turn. */
  lastFlip: number | null;
  winner: PlayerId | null;
  /** True when the previous move landed on a shield and grants another turn. */
  extraTurn: boolean;
}

export interface Move {
  tokenId: number;
  from: number;
  to: number;
  /** IDs of enemy tokens sent back by this move. */
  captures: number[];
  landsOnShield: boolean;
  causesWin: boolean;
}


// ============================================================================
// PURE FUNCTIONS
// ============================================================================

export function initialState(): GameState {
  // Token IDs 0..3 = p1, 4..7 = p2 (contiguous by owner, not interleaved).
  const tokens: TokenState[] = [];
  for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
    tokens.push({ id: i, owner: "p1", position: -1 });
  }
  for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
    tokens.push({ id: i + TOKENS_PER_PLAYER, owner: "p2", position: -1 });
  }
  return {
    tokens,
    currentPlayer: "p1",
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
}

/**
 * Flip 4 coins, return the number showing the marked side.
 * NOT a pure function — the caller (Referee or a test) supplies randomness.
 * Kept here so both sides use the same distribution.
 */
export function flipCoins(rand: () => number = Math.random): number {
  let marked = 0;
  for (let i = 0; i < COINS_PER_PLAYER; i++) {
    if (rand() < 0.5) marked++;
  }
  return marked;
}

/**
 * Return every legal move for the current player given a coin flip count.
 * If the return array is empty, the caller applies applyNoMove (Q6: skip).
 *
 * Move filtering rules:
 *   - Own token on destination           -> blocked (Q2)
 *   - Enemy token on safe (non-contested) -> blocked (safe-tile protection)
 *   - Enemy token on a shield             -> blocked (Q5a: shield protects)
 *   - Overshoot the finish                -> blocked (Q4: exact roll)
 *   - Enemy token on any other contested  -> legal AND captures
 */
export function getLegalMoves(state: GameState, flip: number): Move[] {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];

  const player = state.currentPlayer;
  const moves: Move[] = [];

  for (const token of state.tokens) {
    if (token.owner !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue; // already escaped

    const from = token.position;
    const to = from === -1 ? flip - 1 : from + flip;

    // Escape (Q4): the finish spot IS the escape — a token never sits on it.
    // Landing there requires the EXACT flip (from tile 13 that's a 1, from
    // 12 a 2, ...); the token immediately leaves the board. Overshoot = this
    // token has no move. No smaller or larger flip works.
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue; // exact roll only
      // Win requires ALL 4 tokens to escape. Include reserve (position -1) —
      // a token that hasn't come on the board yet still counts as "not escaped."
      const remaining = state.tokens.filter(
        (t) =>
          t.owner === player &&
          t.id !== token.id &&
          t.position < PATH_LENGTH_PER_PLAYER,
      );
      moves.push({
        tokenId: token.id,
        from,
        to: PATH_LENGTH_PER_PLAYER,
        captures: [],
        landsOnShield: false,
        causesWin: remaining.length === 0,
      });
      continue;
    }

    // On-board landing. Inspect destination tile and occupants.
    //
    // KEY MODEL POINT: the 0..14 path is abstract. Both players walk it, but
    // safe tiles are PRIVATE to each player's physical row on the board.
    // p1's "tile 0" and p2's "tile 0" are different physical squares — they
    // just share an index in this model. So when the destination is a safe
    // (non-contested) tile, enemy tokens with the same position number aren't
    // actually here; they're on their own private row.
    const destTile = BOARD_LAYOUT[to];
    const occupants = state.tokens.filter(
      (t) =>
        t.position === to &&
        t.id !== token.id &&
        (destTile.isContested || t.owner === player),
    );
    const self = occupants.find((t) => t.owner === player);
    const enemy = occupants.find((t) => t.owner !== player);

    if (self) continue;                                // Q2: own-token blocks
    if (enemy && destTile.type === "shield") continue; // Q5a: shield protects

    moves.push({
      tokenId: token.id,
      from,
      to,
      captures: enemy ? [enemy.id] : [],
      landsOnShield: destTile.type === "shield",
      causesWin: false,
    });
  }

  return moves;
}

/**
 * Apply a move to a state, returning the new state.
 * Caller is responsible for having pulled `move` from getLegalMoves — this
 * function trusts its input and does not re-validate.
 */
export function applyMove(state: GameState, move: Move): GameState {
  const tokens = state.tokens.map((t) => {
    if (t.id === move.tokenId) return { ...t, position: move.to };
    if (move.captures.includes(t.id)) return { ...t, position: -1 }; // Q3: back to reserve
    return t;
  });

  const extraTurn = move.landsOnShield; // Q5b
  const nextPlayer = extraTurn
    ? state.currentPlayer
    : otherPlayer(state.currentPlayer);

  return {
    tokens,
    currentPlayer: nextPlayer,
    lastFlip: null, // Q5b: shield extra turn = fresh flip
    winner: move.causesWin ? state.currentPlayer : null,
    extraTurn,
  };
}

/** Called by the Referee when getLegalMoves returned []. Q6: turn skips. */
export function applyNoMove(state: GameState): GameState {
  return {
    ...state,
    currentPlayer: otherPlayer(state.currentPlayer),
    lastFlip: null,
    extraTurn: false,
  };
}

export function checkWin(state: GameState): PlayerId | null {
  return state.winner;
}

function otherPlayer(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}


// ============================================================================
// Q7 CLARIFICATION — what "symmetry" meant
//
// Both players walk a path of the same LENGTH (15) with the same TILE TYPES
// in the same ORDER. In the Rulebook they're identical; the abstract path
// indexed 0..14 is what getLegalMoves and applyMove operate on.
//
// The physical difference is where each abstract tile SITS on the 3D board.
// Looking at the board diagram: p1 starts bottom-red row and walks toward
// the green half; p2 starts top-blue row and walks toward the green half.
// Same abstract path, mirrored world coordinates.
//
// That mapping — "p1 tile 4 is at world (x, y, z), p2 tile 4 is at world
// (-x, y, z)" — is the Stage's job, not the Rulebook's. The Rulebook stays
// symmetric. That's what "mirrored" means here.
// ============================================================================
