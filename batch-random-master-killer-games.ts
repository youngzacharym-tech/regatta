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
  applyBless,
  applyBenediction,
  applyBlinkStrike,
  applyRainOfArrows,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyCorpseExplosion,
  applyExhume,
  applyGrandHeist,
  applyVigil,
  applyPickpocket,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyRevive,
  applyVanish,
  applyBackstab,
  applyBlink,
  applyShieldWall,
  breakShieldStreak,
  CHARGE_CAP,
  getLegalPowerMoves,
  applyCurse,
  applyFelStorm,
  applyBloodbath,
  applyCrescendo,
  applyInspire,
  applySongOfHaste,
  tickInspireForNewTurn,
  applyPiercingShot,
  applyRecklessSwing,
  applyWhirlwind,
  applySacrifice,
  applySnare,
  applyWildHunt,
  grantZeroFlipCharge,
  initialPowerState,
  tickHamstringForNewTurn,
  tickDarkBargainForNewTurn,
  possessorOf,
  REFLIPS_PER_TURN,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickThrallForNewTurn,
  tickWallUpkeepForNewTurn,
  tickVanishForNewTurn,
  type PlayerClass,
  type PowerState,
} from "./master-killer.ts";
import { pickBotPowerAction } from "./master-killer-bot.ts";

const GAMES_PER_MATCHUP = Number(process.argv[2] ?? 2000);
const MAX_TURNS_PER_GAME = 1000;

const CLASSES: PlayerClass[] = [
  "archer", "mage", "warrior", "necromancer", "cleric", "rogue",
  "warlock", "hunter", "barbarian", "bard",
];

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
    shieldWall: number;
    bulwark: number;
    bulwarkReinforced: number; // RETIRED (BULWARK_REINFORCED_RETIRED) — always 0, kept for shape
    bulwarkBlock: number;
    wallsRaised: number; // new walls raised this game (Bulwark + Bless + Benediction + Shield Wall), the wallLife denominator
    wallTurns: number; // sum, over every own-turn tick, of walls still up AFTER that turn's upkeep — wallLife = wallTurns/wallsRaised
    wallsDropped: number; // walls that fell because their owner couldn't pay wallUpkeepFor
    bleed: number; // total mana actually paid to wallUpkeepFor, summed over the game
    revive: number; // full-soul-bank Revive casts (thralls raised)
    corpseExplosion: number; // 2-soul blasts (the corpse's cheap spend)
    explosionSendsHome: number; // blast victims sent all the way home
    thrallKill: number; // captures made BY a thrall (the chain-necromancy engine)
    corpseDeny: number; // corpse voided by the victim re-entering the marked token
    thrallExpired: number; // thralls that crumbled at full duration (vs being killed)
    exhume: number;
    bless: number; // Cleric Bless casts
    vigil: number; // Cleric Vigil casts (replaces Heal under the wall rework)
    benediction: number; // Benediction ultimates fired
    wound: number; // blessings broken (captures/knockbacks absorbed as wounds)
    mend: number; // stones mended by Sanctified Ground shield landings
    pickpocket: number; // Rogue Pickpocket casts (turn-keeping bank drain)
    vanish: number; // Rogue Vanish casts (Bulwark's mechanic, Rogue-cast)
    backstab: number; // Rogue Backstab casts (guaranteed execute; restored 2026-09-13)
    blink: number; // Mage Blink casts (turn-ending reposition; added 2026-09-13)
    grandHeist: number; // Grand Heist ultimates fired
    curse: number; // Warlock Curse of Chains casts (turn-keeping hex)
    sacrifice: number; // Warlock Sacrifice casts (own stone traded for a pierce-kill)
    felStorm: number; // Fel Storm ultimates fired
    felStormDragged: number; // stones the storm dragged back, summed over casts
    snare: number; // Hunter Snare placements (turn-keeping trap arming)
    trapSprung: number; // traps an enemy actually stepped into
    trapHome: number; // of those, ones that threw the victim all the way home
    wolfBite: number; // Wolf Companion knockbacks (the free passive)
    wolfHome: number; // of those, ones that sent the victim home
    piercingShot: number; // Hunter Piercing Shot casts (full-bank kill at range)
    wildHunt: number; // Wild Hunt ultimates fired
    recklessSwing: number; // Barbarian Reckless Swing casts
    recklessSelfHome: number; // of those, ones whose recoil sent the swinger home
    whirlwind: number; // Barbarian Whirlwind casts (full-bank radial spin)
    whirlwindCaught: number; // stones the spin captured or shoved, summed
    bloodbath: number; // Bloodbath ultimates fired
    bloodbathKills: number; // primary target + swept stones, summed (2026-09-18: Warpath's ported mechanic)
    inspire: number; // Bard Inspire casts (turn-keeping stacking buff)
    songOfHaste: number; // Song of Haste casts
    hasteMarched: number; // stones the song advanced, summed over casts
    crescendo: number; // Crescendo ultimates fired
    darkBargain: number; // Warlock Dark Bargains struck (turns in which the fiend traded a rear stone for a runner)
  };
}

/** The enemy Hunter's reactive layer fires inside resolveTurn, so its stats
 *  ride the MOVER's result rather than any action the hunter chose — both
 *  the landing-move and the Charge paths report them identically. */
function trapWolfUsage(r: {
  trapSprung: { sentHome: boolean } | null;
  wolfBite: { sentHome: boolean } | null;
}): Partial<GameResult["usage"]> {
  return {
    ...(r.trapSprung ? { trapSprung: 1, ...(r.trapSprung.sentHome ? { trapHome: 1 } : {}) } : {}),
    ...(r.wolfBite ? { wolfBite: 1, ...(r.wolfBite.sentHome ? { wolfHome: 1 } : {}) } : {}),
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
  // Hunter freeze expiry, same slot as room-engine's commitTurnFlip: BEFORE
  // move gen, so a thawing stone moves on the turn its freeze runs out.
  // (Curse expiry has no analogue here — the curse only bends a stride, and
  // the sim's own turn loop never needed the announcement.)
  power = tickHamstringForNewTurn(state, power).power;
  // Inspiration expiry, same slot: a faded stone moves at its true speed.
  power = tickInspireForNewTurn(state, power).power;
  power = tickDarkBargainForNewTurn(power);
  // Wall upkeep + Vanish countdown, same slot as room-engine's
  // commitTurnFlip: after the other ticks, before move generation, so a
  // wall dropped for non-payment unprotects that stone THIS turn's move
  // list. wallsDropped/bleed feed the sweep's wallLife/wallDrop-g/bleed-g
  // reads (Spec D).
  const upkeepResult = tickWallUpkeepForNewTurn(state, power);
  power = upkeepResult.power;
  const wallTick: Partial<GameResult["usage"]> = {
    ...(upkeepResult.paid > 0 ? { bleed: upkeepResult.paid } : {}),
    ...(upkeepResult.droppedTokenIds.length > 0 ? { wallsDropped: upkeepResult.droppedTokenIds.length } : {}),
  };
  const ownWallsAfterUpkeep = Object.keys(power.walls).filter(
    (id) => state.tokens.find((t) => t.id === Number(id))?.owner === mover,
  ).length;
  if (ownWallsAfterUpkeep > 0) wallTick.wallTurns = ownWallsAfterUpkeep;
  power = tickVanishForNewTurn(state, power).power;
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
  // across the turn-keepers (Pickpocket costs >= 1, Revive empties the
  // bank; Bless is BLESS_COST=0 since 2026-09-18 — its own BLESSING_CAP
  // bounds it instead, well inside this loop's REFLIPS_PER_TURN-driven
  // margin), plus safety.
  let revives = 0;
  let blessCasts = 0;
  let pickpocketCasts = 0;
  let curseCasts = 0;
  let snareCasts = 0;
  let inspireCasts = 0;
  for (
    let i = 0;
    (action?.kind === "reflip" ||
      action?.kind === "revive" ||
      action?.kind === "bless" ||
      action?.kind === "pickpocket" ||
      action?.kind === "curse" ||
      action?.kind === "snare" ||
      action?.kind === "inspire") &&
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
    } else if (action.kind === "pickpocket") {
      power = applyPickpocket(power, mover);
      pickpocketCasts++;
    } else if (action.kind === "curse") {
      // Warlock's Curse of Chains — applyCurse's contract: same flip, no
      // board change (the hex only bends the VICTIM's stride), so the
      // recompute below is a formality that keeps every turn-keeper's
      // shape identical.
      power = applyCurse(power, action.targetTokenId, mover);
      curseCasts++;
    } else if (action.kind === "snare") {
      // Hunter's Snare — applySnare's contract, Curse's shape exactly.
      power = applySnare(power, action.tile, mover);
      snareCasts++;
    } else {
      // Bard's Inspire — same contract again, and the one turn-keeper that
      // genuinely changes the mover's OWN move list (a lit stone strides
      // further), which the recompute below picks up.
      power = applyInspire(power, action.targetTokenId, mover);
      inspireCasts++;
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
    ...wallTick,
    ...(bulwarkBlockedThisTurn ? { bulwarkBlock: 1 } : {}),
    ...(revives > 0 ? { revive: revives } : {}),
    ...(blessCasts > 0 ? { bless: blessCasts, wallsRaised: blessCasts } : {}),
    ...(pickpocketCasts > 0 ? { pickpocket: pickpocketCasts } : {}),
    ...(curseCasts > 0 ? { curse: curseCasts } : {}),
    ...(snareCasts > 0 ? { snare: snareCasts } : {}),
    ...(inspireCasts > 0 ? { inspire: inspireCasts } : {}),
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
    action.kind === "pickpocket" ||
    action.kind === "curse" ||
    action.kind === "snare" ||
    action.kind === "inspire"
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
          ...trapWolfUsage(r),
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
          ...trapWolfUsage(r),
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
    case "rainOfArrows": {
      const r = applyRainOfArrows(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 1, usage: { ...turnUsage, rainOfArrows: 1 } };
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
    case "shieldWall": {
      const r = applyShieldWall(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: {
          ...turnUsage,
          shieldWall: 1,
          ...(r.walledTokenIds.length > 0 ? { wallsRaised: (turnUsage.wallsRaised ?? 0) + r.walledTokenIds.length } : {}),
        },
      };
    }
    case "bulwark": {
      const r = applyBulwark(state, power, action.tokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...turnUsage, bulwark: 1, wallsRaised: 1 },
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
    case "vigil": {
      const r = applyVigil(state, power, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, vigil: 1 } };
    }
    case "benediction": {
      const r = applyBenediction(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: {
          ...turnUsage,
          benediction: 1,
          // Summed, not overwritten: a Cleric can Bless (turn-keeping) some
          // number of times before finally Benedicting the same turn, and
          // turnUsage.wallsRaised already carries that earlier count.
          ...(r.blessedTokenIds.length > 0 ? { wallsRaised: (turnUsage.wallsRaised ?? 0) + r.blessedTokenIds.length } : {}),
        },
      };
    }
    case "vanish": {
      const r = applyVanish(state, power, action.tokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, vanish: 1 } };
    }
    case "blink": {
      const r = applyBlink(state, power, action.tile, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 0, usage: { ...turnUsage, blink: 1 } };
    }
    case "backstab": {
      // A guaranteed hit: a kill counts as a capture, a wound does not.
      const r = applyBackstab(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: r.woundedTokenId === null ? 1 : 0, usage: { ...turnUsage, backstab: 1 } };
    }
    case "grandHeist": {
      const r = applyGrandHeist(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 1, usage: { ...turnUsage, grandHeist: 1 } };
    }
    case "sacrifice": {
      // One enemy killed; the mover's own stone is the price, not a
      // capture — sweepSize counts the kill only, matching applyMkSacrifice's
      // scoreboard rule.
      const r = applySacrifice(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power, flips, sweepSize: 1, usage: { ...turnUsage, sacrifice: 1 } };
    }
    case "felStorm": {
      // Displacement, not capture (its rare crumble deaths are the
      // possession rule collecting, not a kill the warlock scored) —
      // sweepSize stays 0, Exhume's own precedent.
      const r = applyFelStorm(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: 0,
        usage: { ...turnUsage, felStorm: 1, felStormDragged: r.struckTokenIds.length },
      };
    }
    case "piercingShot": {
      const r = applyPiercingShot(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.killedTokenId !== null ? 1 : 0,
        usage: {
          ...turnUsage,
          piercingShot: 1,
          ...(r.woundedTokenId !== null ? { wound: 1 } : {}),
        },
      };
    }
    case "wildHunt": {
      const r = applyWildHunt(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.killedTokenId !== null ? 1 : 0,
        usage: { ...turnUsage, wildHunt: 1 },
      };
    }
    case "recklessSwing": {
      const r = applyRecklessSwing(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.killedTokenId !== null ? 1 : 0,
        usage: {
          ...turnUsage,
          recklessSwing: 1,
          ...(r.swingerSentHome ? { recklessSelfHome: 1 } : {}),
          ...(r.woundedTokenId !== null ? { wound: 1 } : {}),
        },
      };
    }
    case "whirlwind": {
      const r = applyWhirlwind(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.capturedTokenIds.length,
        usage: {
          ...turnUsage,
          whirlwind: 1,
          whirlwindCaught: r.capturedTokenIds.length + r.knockedTokenIds.length,
          ...(r.woundedTokenIds.length > 0 ? { wound: r.woundedTokenIds.length } : {}),
        },
      };
    }
    case "bloodbath": {
      const r = applyBloodbath(state, power, action.targetTokenId, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.killedTokenIds.length,
        usage: { ...turnUsage, bloodbath: 1, bloodbathKills: r.killedTokenIds.length },
      };
    }
    case "songOfHaste": {
      const r = applySongOfHaste(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.capturedIds.length,
        usage: {
          ...turnUsage,
          songOfHaste: 1,
          hasteMarched: r.movedIds.length,
          ...(r.woundedIds.length > 0 ? { wound: r.woundedIds.length } : {}),
        },
      };
    }
    case "crescendo": {
      const r = applyCrescendo(state, power, mover);
      return {
        state: r.state,
        power: r.power,
        flips,
        sweepSize: r.capturedIds.length,
        usage: {
          ...turnUsage,
          crescendo: 1,
          hasteMarched: r.movedIds.length,
          ...(r.woundedIds.length > 0 ? { wound: r.woundedIds.length } : {}),
        },
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
    shieldWall: 0,
    bulwark: 0,
    bulwarkReinforced: 0,
    bulwarkBlock: 0,
    wallsRaised: 0,
    wallTurns: 0,
    wallsDropped: 0,
    bleed: 0,
    revive: 0,
    corpseExplosion: 0,
    explosionSendsHome: 0,
    thrallKill: 0,
    corpseDeny: 0,
    thrallExpired: 0,
    exhume: 0,
    bless: 0,
    vigil: 0,
    benediction: 0,
    wound: 0,
    mend: 0,
    pickpocket: 0,
    vanish: 0,
    backstab: 0,
    blink: 0,
    grandHeist: 0,
    curse: 0,
    sacrifice: 0,
    felStorm: 0,
    felStormDragged: 0,
    snare: 0,
    trapSprung: 0,
    trapHome: 0,
    wolfBite: 0,
    wolfHome: 0,
    piercingShot: 0,
    wildHunt: 0,
    recklessSwing: 0,
    recklessSelfHome: 0,
    whirlwind: 0,
    whirlwindCaught: 0,
    bloodbath: 0,
    bloodbathKills: 0,
    inspire: 0,
    songOfHaste: 0,
    hasteMarched: 0,
    crescendo: 0,
    darkBargain: 0,
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
    if (r.usage.shieldWall) usage.shieldWall++;
    if (r.usage.bulwark) usage.bulwark++;
    if (r.usage.bulwarkReinforced) usage.bulwarkReinforced++;
    if (r.usage.bulwarkBlock) usage.bulwarkBlock++;
    // Wall counters arrive as counts (several walls can be raised/dropped,
    // or several turns' upkeep paid, within one takeTurn call).
    usage.wallsRaised += r.usage.wallsRaised ?? 0;
    usage.wallTurns += r.usage.wallTurns ?? 0;
    usage.wallsDropped += r.usage.wallsDropped ?? 0;
    usage.bleed += r.usage.bleed ?? 0;
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
    if (r.usage.vigil) usage.vigil++;
    if (r.usage.benediction) usage.benediction++;
    // Wounds/mends arrive as counts (several can land in one move).
    usage.wound += r.usage.wound ?? 0;
    usage.mend += r.usage.mend ?? 0;
    // Pickpocket arrives as a count too (the turn-keeping loop can fire it
    // more than once per turn, same shape as revive/bless).
    usage.pickpocket += r.usage.pickpocket ?? 0;
    if (r.usage.vanish) usage.vanish++;
    if (r.usage.backstab) usage.backstab++;
    if (r.usage.blink) usage.blink++;
    if (r.usage.grandHeist) usage.grandHeist++;
    // Curses arrive as counts (the turn-keeping loop's shape, like revives).
    usage.curse += r.usage.curse ?? 0;
    if (r.usage.sacrifice) usage.sacrifice++;
    if (r.usage.felStorm) usage.felStorm++;
    usage.felStormDragged += r.usage.felStormDragged ?? 0;
    usage.snare += r.usage.snare ?? 0;
    if (r.usage.trapSprung) usage.trapSprung++;
    if (r.usage.trapHome) usage.trapHome++;
    if (r.usage.wolfBite) usage.wolfBite++;
    if (r.usage.wolfHome) usage.wolfHome++;
    if (r.usage.piercingShot) usage.piercingShot++;
    if (r.usage.wildHunt) usage.wildHunt++;
    if (r.usage.recklessSwing) usage.recklessSwing++;
    if (r.usage.recklessSelfHome) usage.recklessSelfHome++;
    if (r.usage.whirlwind) usage.whirlwind++;
    usage.whirlwindCaught += r.usage.whirlwindCaught ?? 0;
    if (r.usage.bloodbath) usage.bloodbath++;
    usage.bloodbathKills += r.usage.bloodbathKills ?? 0;
    usage.inspire += r.usage.inspire ?? 0;
    if (r.usage.songOfHaste) usage.songOfHaste++;
    usage.hasteMarched += r.usage.hasteMarched ?? 0;
    if (r.usage.crescendo) usage.crescendo++;
    // The bargain is a passive struck inside the OTHER side's action; the
    // announcement field survives until the next fresh flip clears it.
    if (r.power.darkBargain.p1 !== null || r.power.darkBargain.p2 !== null) usage.darkBargain++;
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
  const avgShieldWall = mean(results.map((r) => r.usage.shieldWall));
  const avgBulwark = mean(results.map((r) => r.usage.bulwark));
  const avgBulwarkReinforced = mean(results.map((r) => r.usage.bulwarkReinforced));
  const avgBulwarkBlock = mean(results.map((r) => r.usage.bulwarkBlock));
  const totalWallsRaised = results.reduce((a, r) => a + r.usage.wallsRaised, 0);
  const totalWallTurns = results.reduce((a, r) => a + r.usage.wallTurns, 0);
  const wallLife = totalWallsRaised > 0 ? totalWallTurns / totalWallsRaised : 0;
  const avgWallsDropped = mean(results.map((r) => r.usage.wallsDropped));
  const avgBleed = mean(results.map((r) => r.usage.bleed));
  const avgRevive = mean(results.map((r) => r.usage.revive));
  const avgExplosion = mean(results.map((r) => r.usage.corpseExplosion));
  const avgExplosionHome = mean(results.map((r) => r.usage.explosionSendsHome));
  const avgThrallKill = mean(results.map((r) => r.usage.thrallKill));
  const avgCorpseDeny = mean(results.map((r) => r.usage.corpseDeny));
  const avgThrallExpired = mean(results.map((r) => r.usage.thrallExpired));
  const avgExhume = mean(results.map((r) => r.usage.exhume));
  const avgBless = mean(results.map((r) => r.usage.bless));
  const avgVigil = mean(results.map((r) => r.usage.vigil));
  const avgBenediction = mean(results.map((r) => r.usage.benediction));
  const avgWound = mean(results.map((r) => r.usage.wound));
  const avgMend = mean(results.map((r) => r.usage.mend));
  const avgPickpocket = mean(results.map((r) => r.usage.pickpocket));
  const avgVanish = mean(results.map((r) => r.usage.vanish));
  const avgBackstab = mean(results.map((r) => r.usage.backstab));
  const avgBlink = mean(results.map((r) => r.usage.blink));
  const avgGrandHeist = mean(results.map((r) => r.usage.grandHeist));
  const avgCurse = mean(results.map((r) => r.usage.curse));
  const avgSacrifice = mean(results.map((r) => r.usage.sacrifice));
  const avgFelStorm = mean(results.map((r) => r.usage.felStorm));
  const avgFelStormDragged = mean(results.map((r) => r.usage.felStormDragged));
  const avgSnare = mean(results.map((r) => r.usage.snare));
  const avgTrapSprung = mean(results.map((r) => r.usage.trapSprung));
  const avgTrapHome = mean(results.map((r) => r.usage.trapHome));
  const avgWolfBite = mean(results.map((r) => r.usage.wolfBite));
  const avgWolfHome = mean(results.map((r) => r.usage.wolfHome));
  const avgPiercingShot = mean(results.map((r) => r.usage.piercingShot));
  const avgWildHunt = mean(results.map((r) => r.usage.wildHunt));
  const avgReckless = mean(results.map((r) => r.usage.recklessSwing));
  const avgRecklessHome = mean(results.map((r) => r.usage.recklessSelfHome));
  const avgWhirlwind = mean(results.map((r) => r.usage.whirlwind));
  const avgWhirlwindCaught = mean(results.map((r) => r.usage.whirlwindCaught));
  const avgBloodbath = mean(results.map((r) => r.usage.bloodbath));
  const avgBloodbathKills = mean(results.map((r) => r.usage.bloodbathKills));
  const avgInspire = mean(results.map((r) => r.usage.inspire));
  const avgHaste = mean(results.map((r) => r.usage.songOfHaste));
  const avgHasteMarched = mean(results.map((r) => r.usage.hasteMarched));
  const avgCrescendo = mean(results.map((r) => r.usage.crescendo));
  const avgDarkBargain = mean(results.map((r) => r.usage.darkBargain));

  console.log(`${label.padEnd(20)} ${a}=${pct(aWins, GAMES_PER_MATCHUP).padStart(6)}  ${b}=${pct(bWins, GAMES_PER_MATCHUP).padStart(6)}  stalemate=${pct(stalemates, GAMES_PER_MATCHUP)}`);
  console.log(
    `  turns=${avgTurns.toFixed(1).padStart(6)}  maxTurns=${maxTurns}  flips=${avgFlips.toFixed(1).padStart(6)}  maxSweep=${maxSweep}` +
      `  snipe/g=${avgSnipe.toFixed(2)}  push/g=${avgPush.toFixed(2)}  chargedShot/g=${avgChargedShot.toFixed(3)}` +
      `  chargedShotHome/g=${avgChargedShotSendsHome.toFixed(3)}  reflip/g=${avgReflip.toFixed(2)}  blink/g=${avgBlink.toFixed(2)}  charge/g=${avgCharge.toFixed(2)}` +
      `  rainOfArrows/g=${avgRainOfArrows.toFixed(4)}  blinkStrike/g=${avgBlinkStrike.toFixed(4)}  shieldWall/g=${avgShieldWall.toFixed(4)}` +
      `  bulwark/g=${avgBulwark.toFixed(2)}  bulwarkReinf/g=${avgBulwarkReinforced.toFixed(3)}  bulwarkBlock/g=${avgBulwarkBlock.toFixed(3)}` +
      `  wallLife=${wallLife.toFixed(2)}  wallDrop/g=${avgWallsDropped.toFixed(2)}  bleed/g=${avgBleed.toFixed(2)}` +
      `  revive/g=${avgRevive.toFixed(2)}  explode/g=${avgExplosion.toFixed(3)}  explodeHome/g=${avgExplosionHome.toFixed(3)}` +
      `  thrallKill/g=${avgThrallKill.toFixed(3)}  corpseDeny/g=${avgCorpseDeny.toFixed(3)}` +
      `  thrallExpire/g=${avgThrallExpired.toFixed(3)}  exhume/g=${avgExhume.toFixed(4)}` +
      `  bless/g=${avgBless.toFixed(2)}  vigil/g=${avgVigil.toFixed(2)}  benediction/g=${avgBenediction.toFixed(4)}` +
      `  wound/g=${avgWound.toFixed(2)}  mend/g=${avgMend.toFixed(2)}` +
      `  pickpocket/g=${avgPickpocket.toFixed(2)}  vanish/g=${avgVanish.toFixed(2)}  backstab/g=${avgBackstab.toFixed(2)}  grandHeist/g=${avgGrandHeist.toFixed(4)}` +
      `  curse/g=${avgCurse.toFixed(2)}  sacrifice/g=${avgSacrifice.toFixed(3)}` +
      `  felStorm/g=${avgFelStorm.toFixed(4)}  felStormDrag/g=${avgFelStormDragged.toFixed(3)}` +
      `  snare/g=${avgSnare.toFixed(2)}  trapSprung/g=${avgTrapSprung.toFixed(3)}  trapHome/g=${avgTrapHome.toFixed(3)}` +
      `  wolfBite/g=${avgWolfBite.toFixed(3)}  wolfHome/g=${avgWolfHome.toFixed(3)}` +
      `  piercingShot/g=${avgPiercingShot.toFixed(3)}  wildHunt/g=${avgWildHunt.toFixed(4)}` +
      `  reckless/g=${avgReckless.toFixed(3)}  recklessHome/g=${avgRecklessHome.toFixed(3)}` +
      `  whirlwind/g=${avgWhirlwind.toFixed(3)}  wwCaught/g=${avgWhirlwindCaught.toFixed(3)}` +
      `  bloodbath/g=${avgBloodbath.toFixed(4)}  bbKills/g=${avgBloodbathKills.toFixed(3)}` +
      `  inspire/g=${avgInspire.toFixed(2)}  haste/g=${avgHaste.toFixed(3)}` +
      `  hasteMarch/g=${avgHasteMarched.toFixed(3)}  crescendo/g=${avgCrescendo.toFixed(4)}  bargain/g=${avgDarkBargain.toFixed(2)}`,
  );
}
const elapsed = ((Date.now() - start) / 1000).toFixed(2);
console.log("=".repeat(90));
console.log(`Done in ${elapsed}s.`);
