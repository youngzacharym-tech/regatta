// ============================================================================
// test-master-killer-drift.ts — anti-drift regression.
//
// master-killer.ts reimplements rulebook.getLegalMoves()'s from/to/occupancy
// walk rather than wrapping it (see the note in master-killer.ts for why).
// That duplication needs a safety net: this script plays random games
// through the CLASSIC rulebook (the trusted reference) and, at every single
// turn, independently asks master-killer.ts what it would generate for the
// exact same state+flip — using a frozen zero-charge Warrior-vs-Warrior
// PowerState, which neutralizes every power (no charges means no wards to
// break or trigger Ward Breaker against; Warrior is the one class whose
// passive has zero effect without an active ward to interact with — Archer's
// Snipe, by contrast, is free/charge-independent, so it's deliberately
// excluded from this comparison and gets its own dedicated scenario tests
// in test-master-killer.ts instead).
//
// Any mismatch — move count, or any shared field (tokenId/from/to/captures/
// landsOnShield/causesWin) — is a drift bug and fails loudly.
//
// Run: npx tsx test-master-killer-drift.ts [games]
// ============================================================================

import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  type GameState,
  type Move,
} from "./rulebook.ts";
import { getLegalPowerMoves, type PowerMove, type PowerState } from "./master-killer.ts";

const GAMES = Number(process.argv[2] ?? 500);
const MAX_TURNS_PER_GAME = 1000;

// Frozen throughout — never mutated, never advanced. Zero charges makes
// Ward impossible (isWarded requires charges===CHARGE_CAP); Warrior's own
// passive only matters against a ward, so it's inert here too.
const NEUTRAL_POWER: PowerState = {
  classes: { p1: "warrior", p2: "warrior" },
  charges: { p1: 0, p2: 0 },
  safeTokens: new Set(),
  reflipsUsedThisTurn: 0,
  // Rain of Arrows is Archer-only (this fixture is Warrior-vs-Warrior, gated
  // out entirely) and getLegalPowerMoves itself never reads these fields —
  // see test-master-killer.ts for the ultimate's dedicated scenario coverage.
  shieldStreak: { p1: 0, p2: 0 },
  ultimateReady: { p1: false, p2: false },
  // Bulwark is Warrior-only and starts empty here too — getLegalPowerMoves
  // never populates it (only applyBulwark does), so an empty map is the
  // only value this fixture could ever need. Same for bulwarkSaves
  // (reinforced-Bulwark bookkeeping).
  bulwarked: {},
  bulwarkSaves: {},
};

function sharedFieldsMatch(a: Move, b: PowerMove): boolean {
  return (
    a.tokenId === b.tokenId &&
    a.from === b.from &&
    a.to === b.to &&
    a.landsOnShield === b.landsOnShield &&
    a.causesWin === b.causesWin &&
    a.captures.length === b.captures.length &&
    a.captures.every((id, i) => id === b.captures[i])
  );
}

let turnsCompared = 0;
let mismatches = 0;
const mismatchDetails: string[] = [];

function playOneAndCompare(): void {
  let state: GameState = initialState();
  let turns = 0;

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const flip = flipCoins();
    const classicMoves = getLegalMoves(state, flip);
    const powerMoves = getLegalPowerMoves(state, NEUTRAL_POWER, flip);
    turnsCompared++;

    if (classicMoves.length !== powerMoves.length) {
      mismatches++;
      mismatchDetails.push(
        `turn ${turns}: move COUNT differs — classic ${classicMoves.length}, power ${powerMoves.length} ` +
          `(flip=${flip}, player=${state.currentPlayer})`,
      );
    } else {
      for (let i = 0; i < classicMoves.length; i++) {
        if (!sharedFieldsMatch(classicMoves[i], powerMoves[i])) {
          mismatches++;
          mismatchDetails.push(
            `turn ${turns}, move[${i}]: classic=${JSON.stringify(classicMoves[i])} ` +
              `power=${JSON.stringify(powerMoves[i])}`,
          );
        }
      }
    }

    if (classicMoves.length === 0) {
      state = applyNoMove(state);
      continue;
    }
    const pick = classicMoves[Math.floor(Math.random() * classicMoves.length)];
    state = applyMove(state, pick);
  }
}

console.log(`Comparing master-killer.ts's move generation against rulebook.ts across ${GAMES} games...`);
const start = Date.now();
for (let i = 0; i < GAMES && mismatchDetails.length < 20; i++) playOneAndCompare();
const elapsed = ((Date.now() - start) / 1000).toFixed(2);

console.log(`${turnsCompared} turns compared in ${elapsed}s.`);
if (mismatches > 0) {
  console.log(`\n${mismatches} MISMATCHES FOUND (showing up to 20):`);
  for (const d of mismatchDetails) console.log(`  - ${d}`);
  process.exit(1);
}
console.log("No drift: master-killer.ts's neutral-state move generation is identical to rulebook.ts.");
