// ============================================================================
// batch-random-games.ts
//
// Plays N games silently, reports aggregate stats.
// Answers: is the game balanced? Are turn counts reasonable? How often do
// captures actually happen?
//
// Run:
//   node batch-random-games.ts
//   node batch-random-games.ts 5000    <- override game count
// ============================================================================

import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type PlayerId,
} from "./rulebook.ts";

const GAMES = Number(process.argv[2] ?? 1000);
const MAX_TURNS_PER_GAME = 1000;

interface GameResult {
  winner: PlayerId | null; // null = stalemate
  turns: number;
  captures: number;
  shieldLands: number;
  skips: number;
}

function playOne(): GameResult {
  let state: GameState = initialState();
  let turns = 0;
  let captures = 0;
  let shieldLands = 0;
  let skips = 0;

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const flip = flipCoins();
    const moves = getLegalMoves(state, flip);
    if (moves.length === 0) {
      skips++;
      state = applyNoMove(state);
      continue;
    }
    const pick = moves[Math.floor(Math.random() * moves.length)];
    captures += pick.captures.length;
    if (pick.landsOnShield) shieldLands++;
    state = applyMove(state, pick);
  }

  return { winner: state.winner, turns, captures, shieldLands, skips };
}

function pct(n: number, total: number): string {
  return ((n / total) * 100).toFixed(1) + "%";
}

function stats(nums: number[]): { mean: number; min: number; max: number; median: number } {
  const sorted = [...nums].sort((a, b) => a - b);
  return {
    mean: nums.reduce((a, b) => a + b, 0) / nums.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

// ---------------------------------------------------------------------------

console.log(`Playing ${GAMES} random games...`);
const start = Date.now();
const results: GameResult[] = [];
for (let i = 0; i < GAMES; i++) results.push(playOne());
const elapsed = ((Date.now() - start) / 1000).toFixed(2);

const p1Wins = results.filter((r) => r.winner === "p1").length;
const p2Wins = results.filter((r) => r.winner === "p2").length;
const stalemates = results.filter((r) => r.winner === null).length;

const turnStats = stats(results.map((r) => r.turns));
const capStats = stats(results.map((r) => r.captures));
const shieldStats = stats(results.map((r) => r.shieldLands));
const skipStats = stats(results.map((r) => r.skips));

console.log("=".repeat(66));
console.log(`Random Regatta — ${GAMES} games in ${elapsed}s`);
console.log("=".repeat(66));
console.log(`Win split:  p1 ${p1Wins} (${pct(p1Wins, GAMES)})   `
          + `p2 ${p2Wins} (${pct(p2Wins, GAMES)})   `
          + `stalemate ${stalemates} (${pct(stalemates, GAMES)})`);
console.log("");
console.log(`Turns / game        mean ${turnStats.mean.toFixed(1).padStart(6)}   `
          + `median ${String(turnStats.median).padStart(4)}   `
          + `min ${String(turnStats.min).padStart(3)}   `
          + `max ${String(turnStats.max).padStart(4)}`);
console.log(`Captures / game     mean ${capStats.mean.toFixed(1).padStart(6)}   `
          + `median ${String(capStats.median).padStart(4)}   `
          + `min ${String(capStats.min).padStart(3)}   `
          + `max ${String(capStats.max).padStart(4)}`);
console.log(`Shield-lands / game mean ${shieldStats.mean.toFixed(1).padStart(6)}   `
          + `median ${String(shieldStats.median).padStart(4)}   `
          + `min ${String(shieldStats.min).padStart(3)}   `
          + `max ${String(shieldStats.max).padStart(4)}`);
console.log(`Skips / game        mean ${skipStats.mean.toFixed(1).padStart(6)}   `
          + `median ${String(skipStats.median).padStart(4)}   `
          + `min ${String(skipStats.min).padStart(3)}   `
          + `max ${String(skipStats.max).padStart(4)}`);
console.log("=".repeat(66));
