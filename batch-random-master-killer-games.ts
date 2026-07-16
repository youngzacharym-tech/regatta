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
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyWarpath,
  getLegalPowerMoves,
  grantZeroFlipCharge,
  initialPowerState,
  REFLIPS_PER_TURN,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
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
  usage: {
    snipe: number;
    push: number;
    chargedShot: number;
    chargedShotSendsHome: number;
    reflip: number;
    charge: number;
    rainOfArrows: number;
    blinkStrike: number;
    warpath: number;
    bulwark: number;
    bulwarkReinforced: number; // full-bank Reinforced Bulwark casts (subset of bulwark)
    bulwarkBlock: number;
  };
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
  // The zero-flip charge is granted ON THE FLIP COMMIT, before the mover
  // decides anything — same order as room-engine's commitTurnFlip — so a
  // 0-charge Mage rolling a zero banks the charge in time to Re-flip out of
  // it, exactly like the real server. (Used to be granted only in the
  // skip path below, which under-modeled that rescue.)
  if (flip === 0) power = grantZeroFlipCharge(power, mover);
  let moves = getLegalPowerMoves(state, power, flip);
  // Warrior Bulwark: tick the mover's own countdown, and consume any
  // Bulwark this exact flip's moves reveal as blocked for the opponent —
  // same hook referee.ts/api/ws.ts use at the start of every fresh turn.
  const newTurnBulwark = tickBulwarkForNewTurn(state, power, flip);
  power = newTurnBulwark.power;
  let bulwarkBlockedThisTurn = newTurnBulwark.blockedIds.length > 0;
  let action = pickBotPowerAction(state, power, moves, flip, rand);

  // A Re-flip doesn't end the turn, and a Mage holding both charges may fire
  // up to REFLIPS_PER_TURN of them back-to-back — loop (bounded by the same
  // cap, plus one for safety against a bot bug) exactly like the server's
  // own reflip-then-redecide cycle. NOTE: a re-rolled zero grants its charge
  // back inside the real server path (applyMkReflip); mirrored here so the
  // sim's charge economy can't drift from the transports'.
  for (let i = 0; action?.kind === "reflip" && i <= REFLIPS_PER_TURN; i++) {
    power = applyReflip(power, mover);
    flips++;
    flip = flipCoins();
    if (flip === 0) power = grantZeroFlipCharge(power, mover);
    moves = getLegalPowerMoves(state, power, flip);
    const reflipBulwark = tickBulwarkForReflip(state, power, flip);
    power = reflipBulwark.power;
    if (reflipBulwark.blockedIds.length > 0) bulwarkBlockedThisTurn = true;
    action = pickBotPowerAction(state, power, moves, flip, rand);
  }

  const blockUsage: Partial<GameResult["usage"]> = bulwarkBlockedThisTurn ? { bulwarkBlock: 1 } : {};

  // A leftover "reflip" here would mean the bot ignored its own per-turn
  // guard past the loop's safety bound — shouldn't happen at runtime
  // (pickBotPowerAction checks canReflipAgain), but the return TYPE can't
  // prove that statically, so it's treated the same as "no action" rather
  // than left unhandled.
  if (action === null || action.kind === "reflip") {
    // No zero-flip grant here — it already happened on the flip commit
    // above (or inside the re-flip loop), matching the server's ordering.
    return { state: applyNoMove(state), power, flips, sweepSize: 0, usage: blockUsage };
  }

  switch (action.kind) {
    case "move": {
      const r = applyPowerMove(state, power, action.move, mover, rand);
      const rainHit = r.rainOfArrows?.targetTokenId != null;
      const sweepSize = action.move.captures.length + action.move.bonusCaptures.length + (rainHit ? 1 : 0);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize,
        usage: {
          ...blockUsage,
          ...(action.move.bonusCaptures.length > 0 ? { snipe: 1 } : {}),
          ...(rainHit ? { rainOfArrows: 1 } : {}),
        },
      };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover, rand);
      const rainHit = r.rainOfArrows?.targetTokenId != null;
      const sweepSize =
        action.move.captures.length + action.move.bonusCaptures.length + action.move.chargeSweepCaptures.length +
        (rainHit ? 1 : 0);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize,
        usage: { ...blockUsage, ...(rainHit ? { charge: 1, rainOfArrows: 1 } : { charge: 1 }) },
      };
    }
    case "push": {
      const r = applyPush(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...blockUsage, push: 1 } };
    }
    case "chargedShot": {
      const r = applyChargedShot(state, power, action.targetTokenId, mover);
      const sentHome = r.state.tokens.find((t) => t.id === action.targetTokenId)?.position === -1;
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...blockUsage, chargedShot: 1, ...(sentHome ? { chargedShotSendsHome: 1 } : {}) },
      };
    }
    case "blinkStrike": {
      const r = applyBlinkStrike(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 1 + r.sweptTokenIds.length,
        usage: { ...blockUsage, blinkStrike: 1 },
      };
    }
    case "warpath": {
      const r = applyWarpath(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 1 + r.sweptTokenIds.length,
        usage: { ...blockUsage, warpath: 1 },
      };
    }
    case "bulwark": {
      const r = applyBulwark(state, power, action.tokenId, mover, action.reinforced ?? false);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...blockUsage, bulwark: 1, ...(action.reinforced ? { bulwarkReinforced: 1 } : {}) },
      };
    }
  }
}

function playOne(p1Class: PlayerClass, p2Class: PlayerClass): GameResult {
  let state: GameState = initialState();
  let power: PowerState = { ...initialPowerState(), classes: { p1: p1Class, p2: p2Class } };
  let turns = 0;
  let flips = 0;
  let maxSweepCaptures = 0;
  const usage = {
    snipe: 0,
    push: 0,
    chargedShot: 0,
    chargedShotSendsHome: 0,
    reflip: 0,
    charge: 0,
    rainOfArrows: 0,
    blinkStrike: 0,
    warpath: 0,
    bulwark: 0,
    bulwarkReinforced: 0,
    bulwarkBlock: 0,
  };
  const rand = Math.random;

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const wasReflipEligible = power.classes[state.currentPlayer] === "mage" && power.charges[state.currentPlayer] >= 1;
    const r = takeTurn(state, power, rand);
    state = r.state;
    power = r.power;
    flips += r.flips;
    usage.reflip += r.flips - 1; // every flip past the first is a Re-flip (a turn can now hold up to REFLIPS_PER_TURN)
    maxSweepCaptures = Math.max(maxSweepCaptures, r.sweepSize);
    if (r.usage.snipe) usage.snipe++;
    if (r.usage.push) usage.push++;
    if (r.usage.chargedShot) usage.chargedShot++;
    if (r.usage.chargedShotSendsHome) usage.chargedShotSendsHome++;
    if (r.usage.charge) usage.charge++;
    if (r.usage.rainOfArrows) usage.rainOfArrows++;
    if (r.usage.blinkStrike) usage.blinkStrike++;
    if (r.usage.warpath) usage.warpath++;
    if (r.usage.bulwark) usage.bulwark++;
    if (r.usage.bulwarkReinforced) usage.bulwarkReinforced++;
    if (r.usage.bulwarkBlock) usage.bulwarkBlock++;
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
  const avgChargedShot = mean(results.map((r) => r.usage.chargedShot));
  const avgChargedShotSendsHome = mean(results.map((r) => r.usage.chargedShotSendsHome));
  const avgReflip = mean(results.map((r) => r.usage.reflip));
  const avgCharge = mean(results.map((r) => r.usage.charge));
  const avgRainOfArrows = mean(results.map((r) => r.usage.rainOfArrows));
  const avgBlinkStrike = mean(results.map((r) => r.usage.blinkStrike));
  const avgWarpath = mean(results.map((r) => r.usage.warpath));
  const avgBulwark = mean(results.map((r) => r.usage.bulwark));
  const avgBulwarkReinforced = mean(results.map((r) => r.usage.bulwarkReinforced));
  const avgBulwarkBlock = mean(results.map((r) => r.usage.bulwarkBlock));

  console.log(`${label.padEnd(20)} ${a}=${pct(aWins, GAMES_PER_MATCHUP).padStart(6)}  ${b}=${pct(bWins, GAMES_PER_MATCHUP).padStart(6)}  stalemate=${pct(stalemates, GAMES_PER_MATCHUP)}`);
  console.log(
    `  turns=${avgTurns.toFixed(1).padStart(6)}  maxTurns=${maxTurns}  flips=${avgFlips.toFixed(1).padStart(6)}  maxSweep=${maxSweep}` +
      `  snipe/g=${avgSnipe.toFixed(2)}  push/g=${avgPush.toFixed(2)}  chargedShot/g=${avgChargedShot.toFixed(3)}` +
      `  chargedShotHome/g=${avgChargedShotSendsHome.toFixed(3)}  reflip/g=${avgReflip.toFixed(2)}  charge/g=${avgCharge.toFixed(2)}` +
      `  rainOfArrows/g=${avgRainOfArrows.toFixed(4)}  blinkStrike/g=${avgBlinkStrike.toFixed(4)}  warpath/g=${avgWarpath.toFixed(4)}` +
      `  bulwark/g=${avgBulwark.toFixed(2)}  bulwarkReinf/g=${avgBulwarkReinforced.toFixed(3)}  bulwarkBlock/g=${avgBulwarkBlock.toFixed(3)}`,
  );
}
const elapsed = ((Date.now() - start) / 1000).toFixed(2);
console.log("=".repeat(90));
console.log(`Done in ${elapsed}s.`);
