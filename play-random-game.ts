// ============================================================================
// play-random-game.ts
//
// Drives the Rulebook end to end with random choices, one turn per iteration:
//   1. Flip coins
//   2. Ask Rulebook for legal moves
//   3. Pick one at random (or skip turn if none exist)
//   4. Apply and repeat until someone wins (or safety cap hits)
//
// This is a smoke test for the pure rules. If a game finishes in a reasonable
// number of turns, captures happen, both players sometimes win, and no move
// ever produces an impossible position — the rulebook is coherent.
//
// Run:
//   bun run play-random-game.ts
//   -- or --
//   npx tsx play-random-game.ts
// ============================================================================

import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type Move,
  type PlayerId,
} from "./rulebook.ts";

const MAX_TURNS = 500;   // safety cap — real games shouldn't approach this
const VERBOSE = true;    // set false to only see the summary

function posLabel(pos: number): string {
  if (pos === -1) return "-";
  if (pos >= PATH_LENGTH_PER_PLAYER) return "OUT";
  return String(pos).padStart(2, " ");
}

function playerTokens(state: GameState, player: PlayerId): string {
  return state.tokens
    .filter((t) => t.owner === player)
    .map((t) => posLabel(t.position))
    .join(" ");
}

function summarize(state: GameState): string {
  return `p1=[${playerTokens(state, "p1")}]  p2=[${playerTokens(state, "p2")}]`;
}

function moveLabel(move: Move): string {
  const from = move.from === -1 ? "res" : `t${String(move.from).padStart(2, "0")}`;
  const to =
    move.to === PATH_LENGTH_PER_PLAYER
      ? "ESCAPE"
      : `t${String(move.to).padStart(2, "0")}`;
  const caps = move.captures.length > 0 ? ` CAPTURE(${move.captures.join(",")})` : "";
  const shield = move.landsOnShield ? " +SHIELD" : "";
  const win = move.causesWin ? " WIN" : "";
  return `tok${move.tokenId} ${from}->${to}${caps}${shield}${win}`;
}

// ---------------------------------------------------------------------------

console.log("=".repeat(74));
console.log("RANDOM REGATTA — smoke test for rulebook.ts");
console.log("=".repeat(74));

let state = initialState();
let turn = 0;
let captureCount = 0;
let shieldLandCount = 0;
let noMoveCount = 0;
const winsByPlayer: Record<PlayerId, number> = { p1: 0, p2: 0 };

while (state.winner === null && turn < MAX_TURNS) {
  turn++;
  const player = state.currentPlayer;
  const flip = flipCoins();
  const moves = getLegalMoves(state, flip);

  if (moves.length === 0) {
    noMoveCount++;
    if (VERBOSE) {
      const reason = flip === 0 ? "flip=0" : "no legal move";
      console.log(
        `${String(turn).padStart(3)} ${player} flip=${flip} choices=0  SKIP (${reason})`,
      );
    }
    state = applyNoMove(state);
    continue;
  }

  const pick = moves[Math.floor(Math.random() * moves.length)];
  captureCount += pick.captures.length;
  if (pick.landsOnShield) shieldLandCount++;
  if (pick.causesWin) winsByPlayer[player]++;

  if (VERBOSE) {
    console.log(
      `${String(turn).padStart(3)} ${player} flip=${flip} choices=${moves.length}  ${moveLabel(pick)}`,
    );
  }

  state = applyMove(state, pick);
}

console.log("-".repeat(74));
if (state.winner) {
  console.log(`WINNER: ${state.winner} after ${turn} turns`);
} else {
  console.log(`STALEMATE — hit MAX_TURNS=${MAX_TURNS}, no winner`);
}
console.log(
  `stats: captures=${captureCount}  shield-lands=${shieldLandCount}  skips=${noMoveCount}`,
);
console.log(`final: ${summarize(state)}`);
console.log("=".repeat(74));
