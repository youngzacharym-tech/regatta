// ============================================================================
// batch-bot-difficulty.ts — the CPU difficulty SEPARATION GATE.
//
// Plays the three tier pairings (easy-vs-standard, standard-vs-hard,
// easy-vs-hard) headlessly in BOTH rulesets — classic through rulebook.ts,
// Master Killer through the same takeTurn shape as
// batch-random-master-killer-games.ts, run as class MIRRORS so class balance
// can't masquerade as (or hide) skill. Both seatings per pairing, so
// first-move luck cancels.
//
// Then it ASSERTS the ordering (exit 1 on failure) — this is the tuning loop
// for bot.ts/master-killer-bot.ts's hard-tier eval weights, exactly the
// workflow master-killer.ts's CHARGE_CAP-style constants use:
//
//   hard  vs easy      >= HARD_VS_EASY_MIN      (target ~75%)
//   hard  vs standard  >= HARD_VS_STANDARD_MIN
//   standard vs easy   >= STANDARD_VS_EASY_MIN
//
// Run:
//   npx tsx batch-bot-difficulty.ts
//   npx tsx batch-bot-difficulty.ts 4000 1200   <- classic games/pairing, MK games/mirror
// ============================================================================

import {
  applyMove,
  applyNoMove,
  flipCoins,
  getLegalMoves,
  initialState,
  type GameState,
  type PlayerId,
} from "./rulebook.ts";
import {
  applyBlinkStrike,
  applyBless,
  applyBenediction,
  applyBulwark,
  applyHeal,
  applyCharge,
  applyChargedShot,
  applyCorpseExplosion,
  applyExhume,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyRevive,
  applyWarpath,
  breakShieldStreak,
  CHARGE_CAP,
  getLegalPowerMoves,
  grantZeroFlipCharge,
  initialPowerState,
  REFLIPS_PER_TURN,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickThrallForNewTurn,
  type PlayerClass,
  type PowerState,
} from "./master-killer.ts";
import { pickBotMove } from "./bot.ts";
import { pickBotPowerAction } from "./master-killer-bot.ts";
import type { BotDifficulty } from "./bot-difficulty.ts";

const CLASSIC_GAMES_PER_PAIRING = Number(process.argv[2] ?? 2000);
const MK_GAMES_PER_MIRROR = Number(process.argv[3] ?? 600);
const MAX_TURNS_PER_GAME = 1000;

// ---------------------------------------------------------------------------
// GATE THRESHOLDS — named constants with the rationale, per repo convention.
// ---------------------------------------------------------------------------

/** Hard must beat easy decisively — this is the whole point of shipping
 *  tiers. Coin luck caps how lopsided ANY skill gap can look in this game
 *  (a perfect player still loses plenty to four coins), so 65 is "well
 *  clear of noise" rather than 90; the target is ~75. */
const HARD_VS_EASY_MIN = 65;
/** Hard must beat standard by a REAL margin (not noise) or the tier is a
 *  label, not a difficulty. 55 at these sample sizes is ~4+ standard errors
 *  from a coin flip. */
const HARD_VS_STANDARD_MIN = 55;
/** Standard must sit strictly between the outer tiers — same bar as
 *  hard-vs-standard, from the other side. */
const STANDARD_VS_EASY_MIN = 55;

const MK_MIRRORS: PlayerClass[] = ["archer", "mage", "warrior", "necromancer", "cleric"];
const PAIRINGS: [BotDifficulty, BotDifficulty, number][] = [
  // [stronger, weaker, min stronger win%]
  ["standard", "easy", STANDARD_VS_EASY_MIN],
  ["hard", "standard", HARD_VS_STANDARD_MIN],
  ["hard", "easy", HARD_VS_EASY_MIN],
];

// ---------------------------------------------------------------------------
// Classic: flip -> getLegalMoves -> pickBotMove(tier) -> applyMove. Shield
// extra turns fall out of applyMove (currentPlayer stays the mover).
// ---------------------------------------------------------------------------

function playClassic(p1Tier: BotDifficulty, p2Tier: BotDifficulty): PlayerId | null {
  let state = initialState();
  let turns = 0;
  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const flip = flipCoins();
    const moves = getLegalMoves(state, flip);
    if (moves.length === 0) {
      state = applyNoMove(state);
      continue;
    }
    const tier = state.currentPlayer === "p1" ? p1Tier : p2Tier;
    state = applyMove(state, moves[pickBotMove(state, moves, Math.random, tier)]);
  }
  return state.winner;
}

// ---------------------------------------------------------------------------
// Master Killer: the exact takeTurn shape batch-random-master-killer-games.ts
// drives (zero-flip charge on the flip commit, thrall tick before move gen,
// Bulwark ticks, the bounded reflip/revive-then-redecide loop — a Revive
// keeps the SAME flip per applyRevive's contract), with a per-seat
// difficulty threaded through.
// ---------------------------------------------------------------------------

function takeTurnMK(
  state: GameState,
  power: PowerState,
  tier: BotDifficulty,
): { state: GameState; power: PowerState } {
  const mover = state.currentPlayer;
  let flip = flipCoins();
  if (flip === 0) power = grantZeroFlipCharge(power, mover);
  const thrallTick = tickThrallForNewTurn(state, power);
  state = thrallTick.state;
  power = thrallTick.power;
  let moves = getLegalPowerMoves(state, power, flip);
  power = tickBulwarkForNewTurn(state, power, flip).power;
  let action = pickBotPowerAction(state, power, moves, flip, Math.random, tier);

  // Cleric Bless joined the turn-keeping club (applyBless's contract; Heal
  // did NOT — it ends the turn, see HEAL_COST's doc) — same three-kind
  // loop as batch-random-master-killer-games.ts's takeTurn.
  for (
    let i = 0;
    (action?.kind === "reflip" || action?.kind === "revive" || action?.kind === "bless") &&
    i <= REFLIPS_PER_TURN + CHARGE_CAP * 2 + 1;
    i++
  ) {
    if (action.kind === "reflip") {
      power = applyReflip(power, mover);
      flip = flipCoins();
      if (flip === 0) power = grantZeroFlipCharge(power, mover);
    } else if (action.kind === "revive") {
      const r = applyRevive(state, power, mover);
      state = r.state;
      power = r.power;
    } else {
      const r = applyBless(state, power, action.targetTokenId, mover);
      state = r.state;
      power = r.power;
    }
    moves = getLegalPowerMoves(state, power, flip);
    power = tickBulwarkForReflip(state, power, flip).power;
    action = pickBotPowerAction(state, power, moves, flip, Math.random, tier);
  }

  if (action === null || action.kind === "reflip" || action.kind === "revive" || action.kind === "bless") {
    // Skip breaks a live shield streak, matching room-engine's auto-skip
    // (see batch-random-master-killer-games.ts's dead-end branch).
    return { state: applyNoMove(state), power: breakShieldStreak(power, mover) };
  }
  switch (action.kind) {
    case "move": {
      const r = applyPowerMove(state, power, action.move, mover, Math.random);
      return { state: r.state, power: r.power };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover, Math.random);
      return { state: r.state, power: r.power };
    }
    case "push":
      return applyPush(state, power, action.targetTokenId, mover);
    case "chargedShot":
      return applyChargedShot(state, power, action.targetTokenId, mover);
    case "blinkStrike": {
      const r = applyBlinkStrike(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power };
    }
    case "warpath": {
      const r = applyWarpath(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power };
    }
    case "bulwark":
      return applyBulwark(state, power, action.tokenId, mover, action.reinforced ?? false);
    case "corpseExplosion": {
      const r = applyCorpseExplosion(state, power, mover);
      return { state: r.state, power: r.power };
    }
    case "exhume": {
      const r = applyExhume(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power };
    }
    case "heal":
      return applyHeal(state, power, action.targetTokenId, mover);
    case "benediction": {
      const r = applyBenediction(state, power, mover);
      return { state: r.state, power: r.power };
    }
  }
}

function playMK(cls: PlayerClass, p1Tier: BotDifficulty, p2Tier: BotDifficulty): PlayerId | null {
  let state = initialState();
  let power: PowerState = { ...initialPowerState(), classes: { p1: cls, p2: cls } };
  let turns = 0;
  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const r = takeTurnMK(state, power, state.currentPlayer === "p1" ? p1Tier : p2Tier);
    state = r.state;
    power = r.power;
  }
  return state.winner;
}

// ---------------------------------------------------------------------------
// Harness: both seatings, aggregate, assert.
// ---------------------------------------------------------------------------

interface PairResult {
  strongWins: number;
  weakWins: number;
  stalemates: number;
}

/** Play `games` with the stronger tier alternating seats (relabeled back). */
function runPair(games: number, play: (p1: BotDifficulty, p2: BotDifficulty) => PlayerId | null, strong: BotDifficulty, weak: BotDifficulty): PairResult {
  const out: PairResult = { strongWins: 0, weakWins: 0, stalemates: 0 };
  for (let i = 0; i < games; i++) {
    const swapped = i % 2 === 1;
    const winner = swapped ? play(weak, strong) : play(strong, weak);
    if (winner === null) out.stalemates++;
    else if ((winner === "p1") !== swapped) out.strongWins++;
    else out.weakWins++;
  }
  return out;
}

function winPct(r: PairResult): number {
  const decided = r.strongWins + r.weakWins;
  return decided === 0 ? 0 : (r.strongWins / decided) * 100;
}

let failures = 0;
function gate(label: string, pctValue: number, min: number) {
  const ok = pctValue >= min;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${pctValue.toFixed(1)}% (need >= ${min}%)`);
}

const start = Date.now();
console.log(
  `CPU difficulty separation gate — classic ${CLASSIC_GAMES_PER_PAIRING} games/pairing, ` +
    `MK ${MK_GAMES_PER_MIRROR} games/mirror, both seatings.`,
);
console.log("=".repeat(90));

for (const [strong, weak, min] of PAIRINGS) {
  console.log(`\n${strong} vs ${weak}`);

  const c = runPair(CLASSIC_GAMES_PER_PAIRING, playClassic, strong, weak);
  console.log(
    `  classic              ${strong}=${winPct(c).toFixed(1)}%  (${c.strongWins}-${c.weakWins}, stalemates=${c.stalemates})`,
  );

  const mkTotal: PairResult = { strongWins: 0, weakWins: 0, stalemates: 0 };
  for (const cls of MK_MIRRORS) {
    const m = runPair(MK_GAMES_PER_MIRROR, (a, b) => playMK(cls, a, b), strong, weak);
    mkTotal.strongWins += m.strongWins;
    mkTotal.weakWins += m.weakWins;
    mkTotal.stalemates += m.stalemates;
    console.log(
      `  mk ${cls.padEnd(8)} mirror   ${strong}=${winPct(m).toFixed(1)}%  (${m.strongWins}-${m.weakWins}, stalemates=${m.stalemates})`,
    );
  }
  console.log(
    `  mk aggregate         ${strong}=${winPct(mkTotal).toFixed(1)}%  (${mkTotal.strongWins}-${mkTotal.weakWins}, stalemates=${mkTotal.stalemates})`,
  );

  gate(`classic ${strong} vs ${weak}`, winPct(c), min);
  gate(`mk      ${strong} vs ${weak}`, winPct(mkTotal), min);
}

console.log("\n" + "=".repeat(90));
console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
if (failures > 0) {
  console.error(`\n${failures} separation gate(s) FAILED.`);
  process.exit(1);
}
console.log("All separation gates passed.");
