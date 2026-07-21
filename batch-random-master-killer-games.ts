// ============================================================================
// batch-random-master-killer-games.ts
//
// Mirrors batch-random-games.ts's role for the classic game: plays many
// simulated matches and reports aggregate stats — but across all 10 class
// matchups (both seatings each, to cancel first-move bias), with both sides
// driven by pickBotPowerAction. This is the tuning tool for
// CHARGE_CAP/PUSH_DISTANCE/WARD_SCOPE (and the necromancer's
// RAISE_POSITION/DARK_RESURRECTION_POSITION/EXHUME_RETURN_POSITION) in
// master-killer.ts: run it, read the win splits, adjust a constant, run it
// again.
//
// Run:
//   npx tsx batch-random-master-killer-games.ts
//   npx tsx batch-random-master-killer-games.ts 2000    <- override game count per matchup
// ============================================================================

import { initialState, flipCoins, applyNoMove, type GameState, type PlayerId } from "./rulebook.ts";
import {
  applyBackstab,
  applyBless,
  applyBenediction,
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyCorpseExplosion,
  applyExhume,
  applyGrandHeist,
  applyHeal,
  applyPickpocket,
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
  possessorOf,
  REFLIPS_PER_TURN,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickThrallForNewTurn,
  type PlayerClass,
  type PowerState,
} from "./master-killer.ts";
import { pickBotPowerAction } from "./master-killer-bot.ts";

const GAMES_PER_MATCHUP = Number(process.argv[2] ?? 2000);
const MAX_TURNS_PER_GAME = 1000;

const CLASSES: PlayerClass[] = ["archer", "mage", "warrior", "necromancer", "cleric", "rogue"];

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
    revive: number; // full-soul-bank Revive casts (thralls raised)
    corpseExplosion: number; // 2-soul blasts (the corpse's cheap spend)
    explosionSendsHome: number; // blast victims sent all the way home
    thrallKill: number; // captures made BY a thrall (the chain-necromancy engine)
    corpseDeny: number; // corpse voided by the victim re-entering the marked token
    thrallExpired: number; // thralls that crumbled at full duration (vs being killed)
    exhume: number;
    bless: number; // Cleric Bless casts
    heal: number; // Cleric Heal casts
    benediction: number; // Benediction ultimates fired
    wound: number; // blessings broken (captures/knockbacks absorbed as wounds)
    mend: number; // stones mended by Sanctified Ground shield landings
    pickpocket: number; // Rogue Pickpocket casts (turn-keeping bank drain)
    backstab: number; // Rogue Backstab casts (guaranteed hit, kill or wound)
    grandHeist: number; // Grand Heist ultimates fired
  };
}

/** Drive one player's turn to completion, including a possible Re-flip
 *  (which re-rolls and re-decides within the same "turn") or Raise Dead
 *  (which re-decides with the SAME flip over the changed board). Returns
 *  the updated state/power plus what happened, for stat bookkeeping. */
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
  // Necromancer thrall: tick the mover's own possession BEFORE move gen —
  // a crumbling thrall changes the board the move list must read. Same
  // order as room-engine's commitTurnFlip.
  const thrallTick = tickThrallForNewTurn(state, power);
  state = thrallTick.state;
  power = thrallTick.power;
  const thrallExpiredThisTurn = thrallTick.expiredTokenId !== null;
  let moves = getLegalPowerMoves(state, power, flip);
  // Warrior Bulwark: tick the mover's own countdown, and consume any
  // Bulwark this exact flip's moves reveal as blocked for the opponent —
  // same hook referee.ts/api/ws.ts use at the start of every fresh turn.
  const newTurnBulwark = tickBulwarkForNewTurn(state, power, flip);
  power = newTurnBulwark.power;
  let bulwarkBlockedThisTurn = newTurnBulwark.blockedIds.length > 0;
  let action = pickBotPowerAction(state, power, moves, flip, rand);

  // Neither a Re-flip nor a Revive ends the turn: a Mage holding both
  // charges may fire up to REFLIPS_PER_TURN Re-flips back-to-back, and a
  // Necromancer may Revive (structurally at most once per turn — the cast
  // fills the thrall slot and empties the bank). One loop handles both,
  // bounded by the sum of those caps plus one for safety against a bot
  // bug, exactly like the server's own act-then-redecide cycle. NOTE: a
  // re-rolled zero grants its charge back inside the real server path
  // (applyMkReflip); mirrored here so the sim's charge economy can't
  // drift from the transports'. A Revive keeps the SAME flip
  // (applyRevive's contract — no re-roll, no zero-flip grant, `flips`
  // untouched so playOne's reflip accounting stays exact) but the BOARD
  // changed, so it recomputes moves and runs the same tickBulwarkForReflip
  // hook a Re-flip does: same-turn recompute, no expiry tick, yet the
  // fresh move list can reveal a Bulwark block the pre-revive one couldn't.
  // Cleric Bless joined the turn-keeping club (applyBless's contract —
  // same flip, no re-roll; Heal deliberately did NOT, see HEAL_COST's
  // doc), and Rogue Pickpocket joined it too (applyPickpocket's own
  // contract — bank-level, no board change at all), so the loop handles
  // four kinds. Bound: the Re-flip cap plus every mana the bank could fund
  // across the turn-keepers (each Bless/Pickpocket costs >= 1, Revive
  // empties the bank), plus safety.
  let revives = 0;
  let blessCasts = 0;
  let pickpocketCasts = 0;
  for (
    let i = 0;
    (action?.kind === "reflip" || action?.kind === "revive" || action?.kind === "bless" || action?.kind === "pickpocket") &&
    i <= REFLIPS_PER_TURN + CHARGE_CAP * 2 + 1;
    i++
  ) {
    if (action.kind === "reflip") {
      power = applyReflip(power, mover);
      flips++;
      flip = flipCoins();
      if (flip === 0) power = grantZeroFlipCharge(power, mover);
    } else if (action.kind === "revive") {
      const r = applyRevive(state, power, mover);
      state = r.state;
      power = r.power;
      revives++;
    } else if (action.kind === "bless") {
      const r = applyBless(state, power, action.targetTokenId, mover);
      state = r.state;
      power = r.power;
      blessCasts++;
    } else {
      power = applyPickpocket(power, mover);
      pickpocketCasts++;
    }
    moves = getLegalPowerMoves(state, power, flip);
    const sameTurnBulwark = tickBulwarkForReflip(state, power, flip);
    power = sameTurnBulwark.power;
    if (sameTurnBulwark.blockedIds.length > 0) bulwarkBlockedThisTurn = true;
    action = pickBotPowerAction(state, power, moves, flip, rand);
  }

  // Usage the turn already earned regardless of what the FINAL action turns
  // out to be — Bulwark blocks revealed along the way, plus any Revives the
  // loop applied (they really happened even if the turn then dead-ends).
  const turnUsage: Partial<GameResult["usage"]> = {
    ...(bulwarkBlockedThisTurn ? { bulwarkBlock: 1 } : {}),
    ...(revives > 0 ? { revive: revives } : {}),
    ...(blessCasts > 0 ? { bless: blessCasts } : {}),
    ...(pickpocketCasts > 0 ? { pickpocket: pickpocketCasts } : {}),
    ...(thrallExpiredThisTurn ? { thrallExpired: 1 } : {}),
  };

  // A leftover turn-keeping action here would mean the bot ignored its own
  // per-turn guards past the loop's safety bound — shouldn't happen at
  // runtime (pickBotPowerAction checks canReflipAgain / the shared
  // oracles), but the return TYPE can't prove that statically, so it's
  // treated the same as "no action" rather than left unhandled.
  if (
    action === null ||
    action.kind === "reflip" ||
    action.kind === "revive" ||
    action.kind === "bless" ||
    action.kind === "pickpocket"
  ) {
    // No zero-flip grant here — it already happened on the flip commit
    // above (or inside the re-flip loop), matching the server's ordering.
    // The skip DOES break a live shield streak — room-engine's auto-skip
    // calls breakShieldStreak (the designed live behavior per PowerState's
    // doc), and this sim is the tuning oracle for the streak-gated
    // ultimates, so it must charge the same price or every ultimate/g
    // number it prints overstates live fire rates.
    return { state: applyNoMove(state), power: breakShieldStreak(power, mover), flips, sweepSize: 0, usage: turnUsage };
  }

  switch (action.kind) {
    case "move": {
      // Thrall-kill and corpse-denial accounting read the PRE-apply power:
      // was the mover's stone a thrall, and was this entry the foe's corpse?
      const foe: PlayerId = mover === "p1" ? "p2" : "p1";
      const thrallKill =
        possessorOf(power, action.move.tokenId) === mover && action.move.captures.length > 0;
      const corpseDeny =
        power.corpse[foe]?.tokenId === action.move.tokenId && action.move.from === -1;
      const r = applyPowerMove(state, power, action.move, mover, rand);
      const rainHit = r.rainOfArrows?.targetTokenId != null;
      const sweepSize =
        action.move.captures.length + action.move.bonusCaptures.length + (rainHit ? 1 : 0) - r.wounded.length;
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize,
        usage: {
          ...turnUsage,
          ...(action.move.bonusCaptures.length > 0 ? { snipe: 1 } : {}),
          ...(rainHit ? { rainOfArrows: 1 } : {}),
          ...(thrallKill ? { thrallKill: 1 } : {}),
          ...(corpseDeny ? { corpseDeny: 1 } : {}),
          ...(r.wounded.length > 0 ? { wound: r.wounded.length } : {}),
          ...(r.mendedTokenIds.length > 0 ? { mend: r.mendedTokenIds.length } : {}),
        },
      };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover, rand);
      const rainHit = r.rainOfArrows?.targetTokenId != null;
      const sweepSize =
        action.move.captures.length + action.move.bonusCaptures.length + action.move.chargeSweepCaptures.length +
        (rainHit ? 1 : 0) - r.wounded.length;
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize,
        usage: {
          ...turnUsage,
          ...(rainHit ? { charge: 1, rainOfArrows: 1 } : { charge: 1 }),
          ...(r.wounded.length > 0 ? { wound: r.wounded.length } : {}),
          ...(r.mendedTokenIds.length > 0 ? { mend: r.mendedTokenIds.length } : {}),
        },
      };
    }
    case "push": {
      const r = applyPush(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...turnUsage, push: 1, ...(r.woundedTokenId !== null ? { wound: 1 } : {}) },
      };
    }
    case "chargedShot": {
      const r = applyChargedShot(state, power, action.targetTokenId, mover);
      const sentHome = r.state.tokens.find((t) => t.id === action.targetTokenId)?.position === -1;
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: {
          ...turnUsage,
          chargedShot: 1,
          ...(sentHome ? { chargedShotSendsHome: 1 } : {}),
          ...(r.woundedTokenId !== null ? { wound: 1 } : {}),
        },
      };
    }
    case "blinkStrike": {
      const r = applyBlinkStrike(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 1 + r.sweptTokenIds.length,
        usage: { ...turnUsage, blinkStrike: 1 },
      };
    }
    case "warpath": {
      const r = applyWarpath(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 1 + r.sweptTokenIds.length,
        usage: { ...turnUsage, warpath: 1 },
      };
    }
    case "bulwark": {
      const r = applyBulwark(state, power, action.tokenId, mover, action.reinforced ?? false);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...turnUsage, bulwark: 1, ...(action.reinforced ? { bulwarkReinforced: 1 } : {}) },
      };
    }
    case "corpseExplosion": {
      const r = applyCorpseExplosion(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: {
          ...turnUsage,
          corpseExplosion: 1,
          ...(r.sentHomeIds.length > 0 ? { explosionSendsHome: r.sentHomeIds.length } : {}),
          ...(r.woundedTokenIds.length > 0 ? { wound: r.woundedTokenIds.length } : {}),
        },
      };
    }
    case "exhume": {
      // A return, never an attack: no capture, no sweep — sweepSize stays 0.
      const r = applyExhume(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, exhume: 1 } };
    }
    case "heal": {
      const r = applyHeal(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, heal: 1 } };
    }
    case "benediction": {
      const r = applyBenediction(state, power, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, benediction: 1 } };
    }
    case "backstab": {
      const r = applyBackstab(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.woundedTokenId === null ? 1 : 0,
        usage: { ...turnUsage, backstab: 1, ...(r.woundedTokenId !== null ? { wound: 1 } : {}) },
      };
    }
    case "grandHeist": {
      const r = applyGrandHeist(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 1, usage: { ...turnUsage, grandHeist: 1 } };
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
    revive: 0,
    corpseExplosion: 0,
    explosionSendsHome: 0,
    thrallKill: 0,
    corpseDeny: 0,
    thrallExpired: 0,
    exhume: 0,
    bless: 0,
    heal: 0,
    benediction: 0,
    wound: 0,
    mend: 0,
    pickpocket: 0,
    backstab: 0,
    grandHeist: 0,
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
    // Revives arrive as counts, not flags (the non-turn-ending loop shape),
    // so add rather than the boolean ++ style.
    usage.revive += r.usage.revive ?? 0;
    if (r.usage.corpseExplosion) usage.corpseExplosion++;
    usage.explosionSendsHome += r.usage.explosionSendsHome ?? 0;
    if (r.usage.thrallKill) usage.thrallKill++;
    if (r.usage.corpseDeny) usage.corpseDeny++;
    if (r.usage.thrallExpired) usage.thrallExpired++;
    if (r.usage.exhume) usage.exhume++;
    if (r.usage.bless) usage.bless++;
    if (r.usage.heal) usage.heal++;
    if (r.usage.benediction) usage.benediction++;
    // Wounds/mends arrive as counts (several can land in one move).
    usage.wound += r.usage.wound ?? 0;
    usage.mend += r.usage.mend ?? 0;
    // Pickpocket arrives as a count too (the turn-keeping loop can fire it
    // more than once per turn, same shape as revive/bless).
    usage.pickpocket += r.usage.pickpocket ?? 0;
    if (r.usage.backstab) usage.backstab++;
    if (r.usage.grandHeist) usage.grandHeist++;
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
  const avgRevive = mean(results.map((r) => r.usage.revive));
  const avgExplosion = mean(results.map((r) => r.usage.corpseExplosion));
  const avgExplosionHome = mean(results.map((r) => r.usage.explosionSendsHome));
  const avgThrallKill = mean(results.map((r) => r.usage.thrallKill));
  const avgCorpseDeny = mean(results.map((r) => r.usage.corpseDeny));
  const avgThrallExpired = mean(results.map((r) => r.usage.thrallExpired));
  const avgExhume = mean(results.map((r) => r.usage.exhume));
  const avgBless = mean(results.map((r) => r.usage.bless));
  const avgHeal = mean(results.map((r) => r.usage.heal));
  const avgBenediction = mean(results.map((r) => r.usage.benediction));
  const avgWound = mean(results.map((r) => r.usage.wound));
  const avgMend = mean(results.map((r) => r.usage.mend));
  const avgPickpocket = mean(results.map((r) => r.usage.pickpocket));
  const avgBackstab = mean(results.map((r) => r.usage.backstab));
  const avgGrandHeist = mean(results.map((r) => r.usage.grandHeist));

  console.log(`${label.padEnd(20)} ${a}=${pct(aWins, GAMES_PER_MATCHUP).padStart(6)}  ${b}=${pct(bWins, GAMES_PER_MATCHUP).padStart(6)}  stalemate=${pct(stalemates, GAMES_PER_MATCHUP)}`);
  console.log(
    `  turns=${avgTurns.toFixed(1).padStart(6)}  maxTurns=${maxTurns}  flips=${avgFlips.toFixed(1).padStart(6)}  maxSweep=${maxSweep}` +
      `  snipe/g=${avgSnipe.toFixed(2)}  push/g=${avgPush.toFixed(2)}  chargedShot/g=${avgChargedShot.toFixed(3)}` +
      `  chargedShotHome/g=${avgChargedShotSendsHome.toFixed(3)}  reflip/g=${avgReflip.toFixed(2)}  charge/g=${avgCharge.toFixed(2)}` +
      `  rainOfArrows/g=${avgRainOfArrows.toFixed(4)}  blinkStrike/g=${avgBlinkStrike.toFixed(4)}  warpath/g=${avgWarpath.toFixed(4)}` +
      `  bulwark/g=${avgBulwark.toFixed(2)}  bulwarkReinf/g=${avgBulwarkReinforced.toFixed(3)}  bulwarkBlock/g=${avgBulwarkBlock.toFixed(3)}` +
      `  revive/g=${avgRevive.toFixed(2)}  explode/g=${avgExplosion.toFixed(3)}  explodeHome/g=${avgExplosionHome.toFixed(3)}` +
      `  thrallKill/g=${avgThrallKill.toFixed(3)}  corpseDeny/g=${avgCorpseDeny.toFixed(3)}` +
      `  thrallExpire/g=${avgThrallExpired.toFixed(3)}  exhume/g=${avgExhume.toFixed(4)}` +
      `  bless/g=${avgBless.toFixed(2)}  heal/g=${avgHeal.toFixed(2)}  benediction/g=${avgBenediction.toFixed(4)}` +
      `  wound/g=${avgWound.toFixed(2)}  mend/g=${avgMend.toFixed(2)}` +
      `  pickpocket/g=${avgPickpocket.toFixed(2)}  backstab/g=${avgBackstab.toFixed(2)}  grandHeist/g=${avgGrandHeist.toFixed(4)}`,
  );
}
const elapsed = ((Date.now() - start) / 1000).toFixed(2);
console.log("=".repeat(90));
console.log(`Done in ${elapsed}s.`);
