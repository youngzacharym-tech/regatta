// ============================================================================
// batch-random-master-killer-games.ts
//
// Mirrors batch-random-games.ts's role for the classic game: plays many
// simulated matches and reports aggregate stats — but across all 6 class
// matchups (both seatings each, to cancel first-move bias), with both sides
// driven by pickBotPowerAction. This is the tuning tool for
// CHARGE_CAP/PUSH_DISTANCE/WARD_SCOPE in master-killer.ts: run it, read the
// win splits, adjust a constant, run it again.
//
// Run:
//   npx tsx batch-random-master-killer-games.ts
//   npx tsx batch-random-master-killer-games.ts 2000    <- override game count per matchup
// ============================================================================

import { initialState, flipCoins, applyNoMove, type GameState, type PlayerId } from "./rulebook.ts";
import {
  applyCharge,
  applyPowerMove,
  applyPush,
  applyReflip,
  getLegalPowerMoves,
  grantZeroFlipCharge,
  initialPowerState,
  type PlayerClass,
  type PowerState,
} from "./master-killer.ts";
import { pickBotPowerAction } from "./master-killer-bot.ts";

const GAMES_PER_MATCHUP = Number(process.argv[2] ?? 2000);
const MAX_TURNS_PER_GAME = 1000;

const CLASSES: PlayerClass[] = ["archer", "mage", "warrior"];

interface GameResult {
  winner: PlayerId | null;
  turns: number; // player control-cycles (a reflip does NOT add to this)
  flips: number; // total coin flips, including reflips
  maxSweepCaptures: number; // largest single-move capture count observed
  usage: { snipe: number; push: number; reflip: number; charge: number };
}

/** Drive one player's turn to completion, including a possible Re-flip
 *  (which re-rolls and re-decides within the same "turn"). Returns the
 *  updated state/power plus what happened, for stat bookkeeping. */
function takeTurn(
  state: GameState,
  power: PowerState,
  rand: () => number,
): { state: GameState; power: PowerState; flips: number; sweepSize: number; usage: Partial<GameResult["usage"]> } {
  const mover = state.currentPlayer;
  let flips = 1;
  let flip = flipCoins();
  let moves = getLegalPowerMoves(state, power, flip);
  let action = pickBotPowerAction(state, power, moves, flip, rand);

  if (action?.kind === "reflip") {
    power = applyReflip(power, mover);
    flips++;
    flip = flipCoins();
    moves = getLegalPowerMoves(state, power, flip);
    action = pickBotPowerAction(state, power, moves, flip, rand);
  }

  // A second "reflip" here would mean the bot ignored its own once-per-turn
  // guard — shouldn't happen at runtime (pickBotPowerAction checks
  // reflipUsedThisTurn), but the return TYPE can't prove that statically, so
  // it's treated the same as "no action" rather than left unhandled.
  if (action === null || action.kind === "reflip") {
    if (flip === 0) power = grantZeroFlipCharge(power, mover);
    return { state: applyNoMove(state), power, flips, sweepSize: 0, usage: {} };
  }

  switch (action.kind) {
    case "move": {
      const r = applyPowerMove(state, power, action.move, mover);
      const sweepSize = action.move.captures.length + action.move.bonusCaptures.length;
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize,
        usage: action.move.bonusCaptures.length > 0 ? { snipe: 1 } : {},
      };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover);
      const sweepSize =
        action.move.captures.length + action.move.bonusCaptures.length + action.move.chargeSweepCaptures.length;
      return { state: r.state, power: r.power, flips, sweepSize, usage: { charge: 1 } };
    }
    case "push": {
      const r = applyPush(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { push: 1 } };
    }
  }
}

function playOne(p1Class: PlayerClass, p2Class: PlayerClass): GameResult {
  let state: GameState = initialState();
  let power: PowerState = { ...initialPowerState(), classes: { p1: p1Class, p2: p2Class } };
  let turns = 0;
  let flips = 0;
  let maxSweepCaptures = 0;
  const usage = { snipe: 0, push: 0, reflip: 0, charge: 0 };
  const rand = Math.random;

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const wasReflipEligible = power.classes[state.currentPlayer] === "mage" && power.charges[state.currentPlayer] >= 1;
    const r = takeTurn(state, power, rand);
    state = r.state;
    power = r.power;
    flips += r.flips;
    if (r.flips > 1) usage.reflip++; // a 2-flip turn means Re-flip was used
    maxSweepCaptures = Math.max(maxSweepCaptures, r.sweepSize);
    if (r.usage.snipe) usage.snipe++;
    if (r.usage.push) usage.push++;
    if (r.usage.charge) usage.charge++;
    void wasReflipEligible; // kept for potential future eligibility-rate stat
  }

  return { winner: state.winner, turns, flips, maxSweepCaptures, usage };
}

function pct(n: number, total: number): string {
  return ((n / total) * 100).toFixed(1) + "%";
}
function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
/** Games are always played with the first-listed class as p1 for one half
 *  of the samples and swapped for the other half (to cancel first-move
 *  bias); this relabels a swapped game's winner back to "was it class A or
 *  class B that won" so both halves aggregate on the same axis. */
function swapWinner(r: GameResult): GameResult {
  return { ...r, winner: r.winner === "p1" ? "p2" : r.winner === "p2" ? "p1" : null };
}

// ---------------------------------------------------------------------------

const matchups: [PlayerClass, PlayerClass][] = [];
for (let i = 0; i < CLASSES.length; i++) {
  for (let j = i; j < CLASSES.length; j++) {
    matchups.push([CLASSES[i], CLASSES[j]]);
  }
}

console.log(`Master Killer balance sim — ${GAMES_PER_MATCHUP} games per matchup, both seatings.`);
console.log("=".repeat(90));

const start = Date.now();
for (const [a, b] of matchups) {
  const label = a === b ? `${a} mirror` : `${a} vs ${b}`;
  const results: GameResult[] = [];
  // Both seatings cancel first-move bias (p1 always moves first in
  // initialState(), same convention batch-random-games.ts uses).
  for (let i = 0; i < GAMES_PER_MATCHUP; i++) {
    results.push(i % 2 === 0 ? playOne(a, b) : swapWinner(playOne(b, a)));
  }

  const aWins = results.filter((r) => r.winner === "p1").length;
  const bWins = results.filter((r) => r.winner === "p2").length;
  const stalemates = results.filter((r) => r.winner === null).length;
  const avgTurns = mean(results.map((r) => r.turns));
  const maxTurns = Math.max(...results.map((r) => r.turns));
  const avgFlips = mean(results.map((r) => r.flips));
  const maxSweep = Math.max(...results.map((r) => r.maxSweepCaptures));
  const avgSnipe = mean(results.map((r) => r.usage.snipe));
  const avgPush = mean(results.map((r) => r.usage.push));
  const avgReflip = mean(results.map((r) => r.usage.reflip));
  const avgCharge = mean(results.map((r) => r.usage.charge));

  console.log(`${label.padEnd(20)} ${a}=${pct(aWins, GAMES_PER_MATCHUP).padStart(6)}  ${b}=${pct(bWins, GAMES_PER_MATCHUP).padStart(6)}  stalemate=${pct(stalemates, GAMES_PER_MATCHUP)}`);
  console.log(
    `  turns=${avgTurns.toFixed(1).padStart(6)}  maxTurns=${maxTurns}  flips=${avgFlips.toFixed(1).padStart(6)}  maxSweep=${maxSweep}` +
      `  snipe/g=${avgSnipe.toFixed(2)}  push/g=${avgPush.toFixed(2)}  reflip/g=${avgReflip.toFixed(2)}  charge/g=${avgCharge.toFixed(2)}`,
  );
}
const elapsed = ((Date.now() - start) / 1000).toFixed(2);
console.log("=".repeat(90));
console.log(`Done in ${elapsed}s.`);
