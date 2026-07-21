// ============================================================================
// master-killer-bot.ts — CPU decision-making for Master Killer mode.
//
// Mirrors bot.ts's approach (ranked heuristic, small jitter) but scores
// across ALL available actions this turn — a normal/power-boosted move,
// Archer's Push, Mage's Re-flip, Warrior's Charge or Bulwark, the
// Necromancer's Raise Dead / Dark Resurrection, or (once banked) Mage's
// Blink Strike / Warrior's Warpath / Necromancer's Exhume ultimate — and
// takes whichever scores highest. Separate file from bot.ts so classic mode's bot
// (and anything reading it, including Kasen's audit) stays untouched.
//
// Three difficulty tiers, same shape as bot.ts (see bot-difficulty.ts):
//   easy     — win short-circuit, then mostly uniform-random over EVERY
//              legal action (including legal-but-wasteful ones, e.g. an
//              empty-sweep Charge — the blunders are the point).
//   standard — the original ranked heuristic above, byte-preserved as the
//              default so every existing call site and balance baseline is
//              untouched.
//   hard     — charge-valued static eval (evaluateMK) + one-ply expectimax
//              over FLIP_WEIGHTS, simulating candidates through the pure
//              apply* functions.
// ============================================================================

import { BOARD_LAYOUT, PATH_LENGTH_PER_PLAYER, type GameState, type PlayerId } from "./rulebook.ts";
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
  canReflipAgain,
  CHARGE_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  effectiveOwner,
  getBackstabTargets,
  getBenedictionTargets,
  getBlessTargets,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getCorpseExplosionTargets,
  getExhumeTargets,
  getGrandHeistTargets,
  getHealTargets,
  getLegalPowerMoves,
  getPickpocketTargets,
  getPushTargets,
  getReviveSpawnTile,
  getWarpathTargets,
  isBlessed,
  isBulwarked,
  isWarded,
  NECRO_CHARGE_CAP,
  possessorOf,
  PUSH_DISTANCE,
  PUSH_WARD_DISTANCE,
  THRALL_TURNS,
  type PlayerClass,
  type PowerAction,
  type PowerMove,
  type PowerState,
} from "./master-killer.ts";
import { EASY_HEED_P, FLIP_WEIGHTS, FLIP_WEIGHT_TOTAL, type BotDifficulty } from "./bot-difficulty.ts";

// ============================================================================
// NECROMANCER STANDARD-TIER MOVE WEIGHTS — the second-pass answer to the
// mage-vs-necromancer gap scoreRaiseDead's first-pass trace calls a ceiling.
// Raise POLICY was income-bound at 68.8/31.2; these three reshape how the
// necromancer PLAYS THE BOARD instead (race the racer, and price captures as
// the charge income they are), and together they bought the last reachable
// ~4 points: 66.3 and 65.6 vs mage across two independent 15000-game runs
// (pooled ~66.0), with vs-archer 60.5-60.7 and vs-warrior 58.7-59.0
// necromancer-side — every necromancer matchup inside 35/65 EXCEPT the mage
// one, which lands ~1pt outside (the 35/65 bar needs <=65.0). ~25
// configurations across five sweep dimensions plateau at 65-67 vs mage; the
// residue is the class's structural Ward-blindness, per the scoreRaiseDead
// trace. All three are necromancer-gated in
// pickStandardPowerAction — every other class's scoreMove inputs are
// byte-identical to before, so the six original matchups cannot move.
// Dead ends tried and REMOVED, for the next tuner: threat-penalty scale
// (hard's MK_EVAL_NECRO_THREAT_SCALE=0.15 story does NOT transfer — 0.5/
// 0.25/0.15 flat, 0 lost 4-6pts everywhere), streak-chase escalation
// (+300/live streak: exhume/g doubled but ~1pt reach, see
// EXHUME_RETURN_POSITION's second-pass note), plain-raise holdback (150 and
// full suppression both flat-to-worse), escape/entry flat bonuses (both
// regress the race=10 stack), and a perch-hold penalty for leaving a shield
// tile (catastrophic: parking bodies forfeits the race — vs-archer flipped
// to 61.2/38.8 archer-favored).
//
// THIRD PASS — the cap-unblock pair (MK_STD_NECRO_CAP_UNBLOCK_RAISE /
// MK_STD_NECRO_UNBLOCK_MOVE below) found the last point INSIDE the swept
// scope after all. An instrumented probe showed the "structural
// Ward-blindness" residue was half self-inflicted: vs mage the necromancer
// sat at CHARGE_CAP with a reserve body but the Dark Resurrection slot
// squatted by its own token for 4.6 turns/game, clamping every incoming
// Soul Harvest/capture/zero-flip charge into nothing (6.7 souls/g earned,
// ~3.4 banked) — and Ward, measured, is only up at 50% of the
// necromancer's decision points anyway (~2 leader captures/g already get
// taken when it drops). Unblocking that state converts discarded income
// into bodies (darkRaise/g 4.5 -> 5.9 vs mage, 9.0 -> 12.3 in the mirror)
// and met the bar: vs-mage 64.4/63.9 mage-side across two independent
// 15000-game runs (pooled ~64.2, from ~66.0), vs-archer 64.4/63.9 and
// vs-warrior 60.0/59.4 necromancer-side, mirror 50.3/49.8, turns/g 81-144
// — every necromancer matchup inside 35/65 with the six originals within
// noise of their locked values on both runs.
// ============================================================================

/** Extra on a shield-tile landing for a necromancer (on top of scoreMove's
 *  shared +250). A shield landing is the class's whole non-capture economy
 *  in one move — charge income, a free extra turn, and ULTIMATE_STREAK
 *  progress toward Exhume — and the shared +250 underprices that for the
 *  one class with no other charge outlet. Swept solo at 150/350 (68.3/68.7
 *  vs mage, baseline 69.9 — real but small alone); in the final stack 150
 *  vs 250 read 66.4 vs 64.9-66.3 at 5000, kept 250. */
const MK_STD_NECRO_SHIELD_EXTRA = 250;
/** Scale on scoreMove's per-tile progression term (`m.to`) for a
 *  necromancer. HISTORY: 10 under the old kit ("Soul Harvest refunds
 *  deaths, so sprint") — that subsidy is GONE with the Revive rework
 *  (2026-07-19: deaths pay nothing; kills pay everything), so the sprint
 *  rationale died with it. Reset to neutral for the rework's first
 *  balance pass; re-sweep from here. */
const MK_STD_NECRO_RACE_SCALE = 1;
/** Scale on scoreMove's capture bonus for a necromancer. Under the Revive
 *  rework a kill is the class's ENTIRE economy in one act: the full soul
 *  bounty (SOUL_BOUNTY_CHARGES, the only income that can fill the third
 *  pip) plus the corpse that Revive consumes — where the old kit's 1.6
 *  priced a kill at "+1 charge and some tempo". First-pass setting for
 *  the rework, sized so a real capture out-ranks everything except a
 *  winning move; re-sweep against the matchup bars. */
const MK_STD_NECRO_CAPTURE_SCALE = 2.5;
/** The hunt instinct: bonus per enemy stone within flip reach (1-4 ahead on
 *  the contested row) of the landing tile, necromancer only. Kills are this
 *  class's ENTIRE economy under the rework, so a landing that sets up
 *  next-turn kill chances is worth courting the exposure the shared -80
 *  threat penalty prices — for everyone else those two cancel to caution;
 *  the necromancer stalks. Added chasing the last outside-the-bar matchup
 *  (mage 66.5/33.5 with Soul Claim + 3-turn thralls + ward-piercing
 *  thralls already in). */
const MK_STD_NECRO_HUNT = 65;

/** What a capture that only WOUNDS a blessed stone is worth to the standard
 *  tier, plus a per-tile scale on the victim's progress: below a kill's
 *  400+, but a real objective — the blow strips a blessing the enemy paid
 *  BLESS_COST for, pays the standard charge, staggers the stone back, and
 *  above all makes the stone MORTAL again (breaking the blessing on an
 *  advanced runner is the only way to ever stop it, hence the progress
 *  scale). Only ever non-zero in cleric matchups (vitality is empty
 *  otherwise), so the six pre-cleric matchups' scoring is byte-identical,
 *  same rand() draws and all. */
const MK_STD_WOUND_VALUE = 160;
const MK_STD_WOUND_PER_TILE = 8;

/** Same shape of scoring bot.ts uses for a plain move, extended with the
 *  power-derived capture sets (bonus snipe / charge sweep) so a Master
 *  Killer move that happens to snipe or sweep scores appropriately higher
 *  than an equivalent classic move would. The trailing weights are the
 *  necromancer levers above; their defaults are exact no-ops, so a call
 *  that doesn't pass them (every non-necromancer call site) scores
 *  byte-identically to the pre-necromancer formula, same rand() draws and
 *  all. `power` feeds the wound split (a blessed victim survives its
 *  capture and pays no charge — see MK_STD_WOUND_VALUE); omitted or with
 *  an empty vitality map it is an exact no-op too. */
function scoreMove(
  state: GameState,
  m: PowerMove,
  extraCaptures: number[],
  rand: () => number,
  shieldExtra = 0,
  raceScale = 1,
  captureScale = 1,
  huntPerTarget = 0,
  power?: PowerState,
): number {
  let score = 0;
  const allCaptures = [...m.captures, ...m.bonusCaptures, ...extraCaptures];
  const wounds = power ? allCaptures.filter((id) => isBlessed(power, id)) : [];
  const kills = wounds.length > 0 ? allCaptures.filter((id) => !wounds.includes(id)) : allCaptures;

  if (m.causesWin) score += 1000;
  if (kills.length > 0) {
    const victimProgress = Math.max(
      ...kills.map((id) => state.tokens.find((t) => t.id === id)?.position ?? 0),
    );
    // Each additional capture in the same move (Snipe/Charge stacking) is
    // worth a real but diminishing bonus — multi-capture moves should win
    // ties against single captures without becoming a blowout auto-pick.
    score += (400 + victimProgress * 10 + (kills.length - 1) * 150) * captureScale;
  }
  // captureScale rides the wound value too: for the necromancer (2.5) a
  // break isn't just tempo — it re-arms the class's whole kill economy
  // (the NEXT hit on that stone pays the bounty and marks the corpse), so
  // the hunt must price it like the setup step it is. Exact no-op for
  // every class whose scale is 1.
  for (const id of wounds) {
    const pos = state.tokens.find((t) => t.id === id)?.position ?? 0;
    score += (MK_STD_WOUND_VALUE + MK_STD_WOUND_PER_TILE * pos) * captureScale;
  }
  if (m.landsOnShield) score += 250 + shieldExtra;
  if (m.to === PATH_LENGTH_PER_PLAYER) score += 300;
  if (m.from === -1) score += 60;

  const fromContested = m.from >= 0 && BOARD_LAYOUT[m.from]?.isContested;
  const toSafe = m.to < PATH_LENGTH_PER_PLAYER && !BOARD_LAYOUT[m.to]?.isContested;
  if (fromContested && toSafe) score += 120;

  if (m.to < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[m.to]?.isContested && BOARD_LAYOUT[m.to]?.type !== "shield") {
    const threatened = state.tokens.some(
      (t) =>
        t.owner !== state.currentPlayer &&
        t.position >= 0 &&
        m.to - t.position >= 1 &&
        m.to - t.position <= 4,
    );
    if (threatened) score -= 80;
  }

  // The hunt (necromancer only — see MK_STD_NECRO_HUNT): enemies the
  // LANDING tile puts within next-flip strike range. Real-owner check is
  // the right cheapness here — the one cross-allegiance piece (a thrall)
  // is the mover's own weapon and shouldn't read as prey.
  if (huntPerTarget > 0 && m.to <= 11) {
    let prey = 0;
    for (const t of state.tokens) {
      if (t.owner === state.currentPlayer) continue;
      if (t.position > m.to && t.position <= m.to + 4 && t.position >= 4 && t.position <= 11) prey++;
    }
    score += huntPerTarget * prey;
  }

  score += m.to * raceScale;
  score += rand() * 20;
  return score;
}

/** Score Push against its best available target — favors hitting the
 *  furthest-advanced enemy, same "capture the leader" instinct bot.ts uses
 *  for normal captures, scaled down a bit since it costs a charge and (for
 *  the non-collision case) doesn't remove the token outright.
 *
 *  A warded target costs the same PUSH_WARD_COST as a normal push (both are
 *  1), but travels PUSH_WARD_DISTANCE instead of PUSH_DISTANCE — same price,
 *  bigger effect. Sending it home strips Ward permanently (scored well above
 *  a normal send-home); even the non-collision case is worth a bit more
 *  than an equivalent normal push, since the longer knockback is more likely
 *  to shove the target out of the contested zone entirely or hand Ward off
 *  to a different token. */
function scorePush(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const warded = isWarded(state, power, target);
  const distance = warded ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
  const rawTo = target.position - distance;
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo,
  );
  const sendsHome = collides || rawTo < 0;
  let score: number;
  if (sendsHome) {
    score = 350 + target.position * 8;
    if (warded) score += 250; // sending a Warded token home is still a big win — removes Ward from play entirely
  } else {
    // Soft-push baseline scales with the ACTUAL distance moved — 180 per
    // tile, chosen so this reduces to the exact pre-existing formula for a
    // normal (unwarded) push: PUSH_DISTANCE=1 -> 180*1=180, byte-for-byte
    // unchanged from before this fix. This replaces the old flat "+60 if
    // warded" bonus, which assumed a warded soft-push always repositions
    // the target meaningfully; now that PUSH_WARD_DISTANCE can legitimately
    // be 0 (a mechanical no-op against a Warded target — spends the charge,
    // target doesn't move at all), the bonus must scale down to zero too,
    // or the bot repeats the exact "flat bonus quietly out-competes a
    // strictly-better plain move" bug already fixed once each for
    // scoreBulwark and scoreChargedShot in this file.
    score = 180 * distance + target.position * 8;
  }
  score += rand() * 20;
  return score;
}

/** Score Archer's Charged Shot: spends BOTH banked charges (CHARGE_CAP) in
 *  one shot, so — same bug class already hit twice this session (see
 *  scoreBulwark's own history note, and the chargeSweepCaptures.length guard
 *  above) — it must NOT get a flat "you can afford it" bonus, or the bot
 *  burns the whole bank on marginal targets instead of ever letting a
 *  cheaper Push or a real move fire. Mirrors scorePush's own shape exactly
 *  (sendsHome bonus + target.position scaling, nothing else) rather than
 *  inventing a new one, since that shape has already survived this exact
 *  scrutiny — but a non-send-home shove scores far below Push's own 180
 *  baseline (20 here, vs Push's 180), since spending the WHOLE bank for a
 *  shove that leaves the target on the board is rarely worth it when a
 *  1-charge Push (net 0 on a send-home) is usually sitting right there as a
 *  cheaper alternative. Only a real send-home — the one outcome a normal
 *  Push's shorter PUSH_DISTANCE often can't reach — clears the bar to beat
 *  an ordinary move or a Push. */
function scoreChargedShot(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const warded = isWarded(state, power, target);
  const rawTo = target.position - (warded ? CHARGED_SHOT_WARD_DISTANCE : CHARGED_SHOT_DISTANCE);
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo,
  );
  const sendsHome = collides || rawTo < 0;
  let score = (sendsHome ? 420 : 20) + target.position * 10;
  score += rand() * 20;
  return score;
}

/** Score Mage's Blink Strike / Warrior's Warpath: both are a guaranteed hit
 *  that bypasses shield-tile protection and Ward outright — scored like a
 *  strong capture (same shape as scoreMove's capture bonus), plus a flat
 *  bonus so the bot doesn't sit on a banked ultimateReady flag once a legal
 *  target exists. Doesn't account for Warpath's extra sweep captures along
 *  the way — target choice among a rarely-more-than-one-deep candidate pool
 *  isn't worth the complexity of a speculative applyWarpath() call here. */
function scoreUltimateStrike(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = 500 + target.position * 10;
  score += rand() * 20;
  return score;
}

/** Score Warrior's Bulwark: defensive insurance on the mover's most-advanced
 *  un-Bulwarked on-board token, scaled by how far along it already is
 *  (mirrors scorePush's own target.position scaling) so the bot naturally
 *  favors protecting whichever token has the most invested.
 *
 *  Deliberately biased NEGATIVE at the low end (score starts at -35, not 0)
 *  rather than just "modest but positive" — this is the fix for a real bug
 *  found while tuning this exact function, worth recording since it's a new
 *  instance of the file's established "flat bonus quietly out-competes a
 *  strictly-better plain move" failure mode (see the chargeSweepCaptures.length
 *  check above for the original case). Bulwark is essentially ALWAYS
 *  evaluable for a Warrior with a spare charge (unlike Push, which needs a
 *  specific enemy on a contested tile, or Reflip, which needs a bad flip) —
 *  so ANY comfortably-positive flat score, even a small one, made the bot
 *  cast it almost every eligible turn instead of advancing or Charging.
 *  Balance-sim fallout was severe: archer-vs-warrior swung from the ~43.6/
 *  56.4 warrior-favored baseline all the way to ~80/20 ARCHER-favored,
 *  because a Warrior burning its charge income on defense instead of
 *  Charge's actual capture-and-advance loop stops converting board control
 *  into wins. The negative floor means Bulwark only wins against an
 *  already-bad alternative (a quiet move into contested territory near an
 *  enemy takes scoreMove's -80 "threatened" penalty, for example) or a
 *  well-advanced token (position 12+ pulls the score back toward/above
 *  zero) — occasional insurance on a valuable token when nothing better is
 *  on offer, not a default action. */
function scoreBulwark(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = -40 + target.position * 3;
  score += rand() * 20;
  return score;
}

/** Is this own token actually in capture danger — on a contested, non-shield
 *  tile with an enemy inside the 1-4 flip landing window behind it (the same
 *  window scoreMove's own "threatened" penalty uses)? Bulwark's protection is
 *  worth ~nothing off the contested row (private-lane tokens can't be
 *  captured, Pushed, swept, or ultimate-struck at all), so a full-bank spend
 *  that isn't answering a live threat is pure waste. This gate is
 *  load-bearing, not a nicety: the first-round candidate scoring skipped it
 *  and every second-charge Bulwark design tanked the Warrior (~-1 to -2.5pts
 *  across its matchups at 30000 games) — the bot was burning the bank on
 *  un-threatened and even un-capturable tokens while charge/g (the Charge
 *  capture loop, the class's actual win engine) starved. With the gate, the
 *  same ability design flipped to IMPROVING both Warrior matchups. */
function bulwarkFacesThreat(state: GameState, target: { position: number; owner: PlayerId }): boolean {
  if (target.position < 0 || target.position >= PATH_LENGTH_PER_PLAYER) return false;
  const tile = BOARD_LAYOUT[target.position];
  if (!tile.isContested || tile.type === "shield") return false;
  return state.tokens.some(
    (t) =>
      t.owner !== target.owner &&
      t.position >= 0 &&
      target.position - t.position >= 1 &&
      target.position - t.position <= 4,
  );
}

/** Score Reinforced Bulwark — the 2-charge, full-bank Bulwark that lasts
 *  and saves twice as long (see BULWARK_REINFORCED_TURNS). Requires a live
 *  threat (see bulwarkFacesThreat), then the same negative floor as
 *  scoreBulwark with steeper position scaling (5/tile vs 3) because doubled
 *  durability is worth most on the token with the most invested — and
 *  nothing else, so spending the whole bank still has to EARN its slot over
 *  a plain move/Charge, the same discipline scoreChargedShot applies to
 *  Archer's own full-bank spend. Scaling swept at 4/5/6 per tile, 30000
 *  games each: 5 gave the best combined Warrior matchup distance-from-50
 *  (aw 50.9-51.6/48.4-49.1, mw 54.7-55.0/45.0-45.3, fire rate 0.4-1.1/g);
 *  4 under-used it (0.28-0.79/g, aw 48.1), 6 was flat-to-worse on aw
 *  (48.4) for no mw gain beyond noise. */
function scoreReinforcedBulwark(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  if (!bulwarkFacesThreat(state, target)) return -Infinity;
  let score = -40 + target.position * 5;
  score += rand() * 20;
  return score;
}

/** Score Re-flip: only worth it when the CURRENT flip is bad — zero, or a
 *  flip that produces no legal moves at all (about to be skipped anyway). */
function scoreReflip(currentMoveCount: number, flip: number, rand: () => number): number {
  if (flip === 0 || currentMoveCount === 0) return 500 + rand() * 20;
  return -1; // never worth it over an already-legal move otherwise
}

/** Score Necromancer's Corpse Explosion: the corpse's CHEAP spend, priced
 *  against the thrall it forgoes. The blast is worth casting when it
 *  actually removes bodies (send-homes) or scatters a crowd; a single soft
 *  shove is worth less than holding the corpse toward Revive (the bank
 *  refills to full on the next kill anyway, so the real cost of waiting is
 *  denial risk, which Soul Claim mostly covers while the bank is full).
 *  Send-homes priced near a capture (they deny the same tempo, minus the
 *  bounty the blast deliberately doesn't pay); soft shoves modest. First
 *  rework-pass values — sweep against the bars. */
function scoreCorpseExplosion(state: GameState, power: PowerState, victims: number[], rand: () => number): number {
  const mover = state.currentPlayer;
  let score = 0;
  for (const id of victims) {
    const t = state.tokens.find((tok) => tok.id === id)!;
    const landing = // mirror applyCorpseExplosion's per-victim physics for the estimate
      t.position - 1 < 4 && possessorOf(power, t.id) !== null
        ? -1
        : state.tokens.some(
            (o) => o.id !== t.id && o.position === t.position - 1 && (o.owner === t.owner || (t.position - 1 >= 4 && t.position - 1 <= 11)),
          )
          ? -1
          : t.position - 1;
    score += landing === -1 ? 380 + t.position * 8 : 90;
  }
  return score + rand() * 20;
}

/** Score Necromancer's Revive (the rework's single active — the old Raise
 *  Dead / Dark Resurrection scorer and its three balance-pass traces died
 *  with the old kit; see git history for the full archaeology). */
function scoreRevive(state: GameState, power: PowerState, spawnTile: number, rand: () => number): number {
  const mover = state.currentPlayer;
  // Fire-on-sight temperament, the old dark-on-sight policy's heir, for the
  // same structural reasons (see the doc above): Revive never ends the turn
  // (the thrall may act on this very flip), the full soul bank has NO other
  // outlet, and — new with the rework — every turn the corpse sits banked
  // is a turn the victim can re-enter it and deny the cast entirely. Base
  // above every quiet move, below a causesWin move's 1000+; sharpened by
  // how many enemy stones the risen thrall would immediately menace
  // (within flip reach, 1-4 tiles ahead along the row).
  let threatened = 0;
  for (const t of state.tokens) {
    if (t.owner === mover || possessorOf(power, t.id) !== null) continue;
    if (t.position <= spawnTile || t.position > spawnTile + 4) continue;
    if (t.position >= 4 && t.position <= 11) threatened++;
  }
  return 900 + 30 * threatened + rand() * 20;
}

/** Score Necromancer's Exhume: the ultimate un-wins an escaped enemy token —
 *  the single largest swing any action in the game offers (an escape is
 *  worth more than any capture, and this claws one back to the last
 *  contested tile). Flat, because escaped targets have nothing to scale by
 *  (every escape is equally escaped — see getExhumeTargets), and large for
 *  the same reason scoreUltimateStrike carries its flat bonus: a banked
 *  ultimateReady that never fires is pure waste, and the foe only needs
 *  four escapes to end the game. Sized above any single capture (scoreMove
 *  tops out near 560 for one) and below a causesWin move's 1000 — never
 *  trade the win itself for a takeback. */
function scoreExhume(rand: () => number): number {
  return 600 + rand() * 20;
}

/** Score Cleric's Bless — a TURN-KEEPING cast (applyBless's contract), so
 *  this is not "instead of the move" but "before it": any winning score
 *  just fires the cast first and the loop re-decides with the same flip.
 *  The discipline the file's thrice-fixed defensive-overspend bug demands
 *  is therefore about MANA, not tempo: a threatened stone (the same
 *  bulwarkFacesThreat window) is the premium buy — the very next enemy
 *  landing pays them nothing — while a quiet bless on an advanced stone
 *  is a modest race-insurance purchase that only fires when the mana has
 *  no better use pending. */
function scoreBless(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = bulwarkFacesThreat(state, target) ? 220 + target.position * 5 : 40 + target.position * 4;
  score += rand() * 20;
  return score;
}

/** Score Cleric's Heal — a TURN-ENDING cast (unlike Bless; see
 *  HEAL_COST's doc), so it pays the full tempo price and gets the full
 *  tempo discipline: under live threat the mend is worth a move (the
 *  incoming kill becomes a wound again — priced near a capture, below a
 *  win); quiet mends fall to the file's standard negative-floor rule so
 *  they only fire on a well-advanced stone when nothing better is on
 *  offer. */
function scoreHeal(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = bulwarkFacesThreat(state, target) ? 300 + target.position * 5 : -30 + target.position * 3;
  score += rand() * 20;
  return score;
}

/** Score Cleric's Benediction: spends only the banked ultimateReady flag
 *  (scoreUltimateStrike's "don't sit on it" reasoning), and its value IS
 *  its pool — every stone it would bless is a future kill denied. Scaled
 *  per target so a one-stone benediction stays below a real capture while
 *  a full-army one outranks anything short of a win. */
function scoreBenediction(poolSize: number, rand: () => number): number {
  return 250 + 120 * poolSize + rand() * 20;
}

/** Score Rogue's Pickpocket — a TURN-KEEPING drain (Bless's contract) with
 *  zero board effect, so its value lives entirely in what the foe's bank
 *  was about to buy them. Every class's strongest tool needs the FULL
 *  bank (Charged Shot, Reinforced Bulwark, Backstab, Bless/Heal both cost
 *  it, Revive/Corpse Explosion at their own cap) — draining a foe sitting
 *  AT their cap denies that outright, so it clears a real, always-positive
 *  bar. A Mage at the cap is the standout case: the drain also drops Ward
 *  THIS INSTANT, scored near scorePush's own Ward-removal tier. Below the
 *  cap, biased NEGATIVE on purpose — this file's own established
 *  discipline (see scoreBulwark's history note) against a small flat
 *  positive reflexively out-competing a genuine capture chance every
 *  single turn. STARTING VALUES, not yet sim-tuned. */
function scorePickpocket(power: PowerState, foe: PlayerId, rand: () => number): number {
  const cap = power.classes[foe] === "necromancer" ? NECRO_CHARGE_CAP : CHARGE_CAP;
  const atCap = power.charges[foe] >= cap;
  const dropsWard = power.classes[foe] === "mage" && atCap;
  let score = dropsWard ? 260 : atCap ? 90 : -40;
  score += rand() * 20;
  return score;
}

/** Score Rogue's Backstab: a guaranteed hit, scored like Blink Strike/
 *  Warpath's guaranteed capture — EXCEPT when the target is Cleric-blessed,
 *  where it only wounds (real value: a charge refund and the shelter
 *  denied, but the stone survives) rather than truly killing, so it's
 *  priced closer to a soft push than a real capture. Spends the full bank
 *  (BACKSTAB_COST), same "has to clear a real bar" discipline as Charged
 *  Shot/Reinforced Bulwark's own full-bank scoring. STARTING VALUES, not
 *  yet sim-tuned. */
function scoreBackstab(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const wounds = isBlessed(power, targetId);
  let score = (wounds ? 260 : 460) + target.position * 10;
  score += rand() * 20;
  return score;
}

/** Score Rogue's Grand Heist: scoreUltimateStrike's guaranteed-capture
 *  baseline, plus a bonus scaled by the bank it would ALSO drain on the
 *  kill — the fuller the foe's bank, the more this ultimate is "a capture
 *  AND a robbery" rather than just a capture, tying the score back to the
 *  ability's own signature effect instead of treating it as a bare
 *  Blink Strike reskin. STARTING VALUE, not yet sim-tuned. */
function scoreGrandHeist(
  state: GameState,
  power: PowerState,
  targetId: number,
  foe: PlayerId,
  rand: () => number,
): number {
  return scoreUltimateStrike(state, targetId, rand) + power.charges[foe] * 30;
}

/**
 * Pick the best action for the current player this turn: a plain/powered
 * move, Push, Re-flip, or Charge (on an eligible move) — whichever scores
 * highest. `flip` is needed to score Re-flip; pass the CURRENT flip's move
 * list and value even if a reflip ends up chosen (the caller re-rolls and
 * re-picks afterward — this function only decides WHETHER to reflip, not
 * what to do with the new flip).
 *
 * `difficulty` selects the tier (default "standard" = the pre-difficulty
 * behavior, byte-preserved — see pickStandardPowerAction).
 *
 * Returns null when there is truly no legal action (no moves, and no
 * charge-funded rescue available) — the caller should treat that exactly
 * like the classic game's empty-legalMoves case and skip the turn.
 */
export function pickBotPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number = Math.random,
  difficulty: BotDifficulty = "standard",
): PowerAction | null {
  if (difficulty === "easy") return pickEasyPowerAction(state, power, moves, flip, rand);
  if (difficulty === "hard") return pickHardPowerAction(state, power, moves, flip, rand);
  return pickStandardPowerAction(state, power, moves, flip, rand);
}

// ============================================================================
// STANDARD — the original heuristic, extracted verbatim (same rand() call
// order) so the default tier's behavior is byte-identical to the
// pre-difficulty bot. Do not "improve" this one; that's what hard is for.
// ============================================================================

function pickStandardPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number,
): PowerAction | null {
  const mover = state.currentPlayer;
  const cls: PlayerClass = power.classes[mover];
  const charges = power.charges[mover];

  let best: PowerAction | null = null;
  let bestScore = -Infinity;
  // The necromancer move weights (see their block above) — exact no-op
  // values for every other class, so only the necromancer's move scoring
  // (and no one's rand() stream) shifts.
  const necro = cls === "necromancer";
  const shieldExtra = necro ? MK_STD_NECRO_SHIELD_EXTRA : 0;
  const raceScale = necro ? MK_STD_NECRO_RACE_SCALE : 1;
  const captureScale = necro ? MK_STD_NECRO_CAPTURE_SCALE : 1;
  const huntPerTarget = necro ? MK_STD_NECRO_HUNT : 0;

  for (const m of moves) {
    const score = scoreMove(state, m, [], rand, shieldExtra, raceScale, captureScale, huntPerTarget, power);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "move", move: m };
    }
    // chargeSweepCaptures.length > 0 is required, not just chargeAvailable:
    // chargeAvailable only means "the lane is clear of the Warrior's OWN
    // tokens" — it says nothing about whether there's an enemy to actually
    // sweep. Without this check the bot would spend a real charge on a
    // Charge that captures nothing extra beyond the plain move it's
    // wrapping, which is strictly worse (identical board outcome, minus a
    // charge). Found via a suspiciously high charge/g stat in the balance
    // sim (~40% of all turns in a warrior mirror game) that traced back to
    // the +20 nudge below always winning over an empty-sweep plain move.
    if (cls === "warrior" && m.chargeAvailable && m.chargeSweepCaptures.length > 0 && charges >= 1) {
      const chargeScore = scoreMove(state, m, m.chargeSweepCaptures, rand, 0, 1, 1, 0, power) + 20; // small "use the cool ability" nudge
      if (chargeScore > bestScore) {
        bestScore = chargeScore;
        best = { kind: "charge", move: m };
      }
    }
  }

  if (cls === "archer" && charges >= 1) {
    for (const targetId of getPushTargets(state, power, mover)) {
      const score = scorePush(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "push", targetTokenId: targetId };
      }
    }
  }

  if (cls === "archer" && charges === CHARGE_CAP) {
    for (const targetId of getChargedShotTargets(state, power, mover)) {
      const score = scoreChargedShot(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "chargedShot", targetTokenId: targetId };
      }
    }
  }

  if (cls === "mage" && canReflipAgain(power, mover)) {
    const score = scoreReflip(moves.length, flip, rand);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "reflip" };
    }
  }

  if (cls === "mage" && power.ultimateReady[mover]) {
    for (const targetId of getBlinkStrikeTargets(state, power, mover)) {
      const score = scoreUltimateStrike(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "blinkStrike", targetTokenId: targetId };
      }
    }
  }

  if (cls === "warrior" && power.ultimateReady[mover]) {
    for (const targetId of getWarpathTargets(state, power, mover)) {
      const score = scoreUltimateStrike(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "warpath", targetTokenId: targetId };
      }
    }
  }

  if (cls === "warrior" && charges >= 1) {
    const bulwarkTargets = getBulwarkTargets(state, power, mover);
    for (const targetId of bulwarkTargets) {
      const score = scoreBulwark(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "bulwark", tokenId: targetId };
      }
    }
    // Reinforced Bulwark: the full-bank cast, offered alongside the plain
    // one — same target pool, its own threat-gated scoring.
    if (charges === CHARGE_CAP) {
      for (const targetId of bulwarkTargets) {
        const score = scoreReinforcedBulwark(state, targetId, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "bulwark", tokenId: targetId, reinforced: true };
        }
      }
    }
  }

  if (cls === "necromancer") {
    // getReviveSpawnTile is the whole gate (corpse banked + raisable, no
    // thrall up, full soul bank) — one candidate, no target choice.
    const spawnTile = getReviveSpawnTile(state, power, mover);
    if (spawnTile !== null) {
      const score = scoreRevive(state, power, spawnTile, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "revive" };
      }
    }
    // Corpse Explosion competes with Revive for the same corpse — its
    // oracle is its own gate (cost, corpse validity, at least one victim).
    const blastVictims = getCorpseExplosionTargets(state, power, mover);
    if (blastVictims.length > 0) {
      const score = scoreCorpseExplosion(state, power, blastVictims, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "corpseExplosion" };
      }
    }
  }

  if (cls === "necromancer" && power.ultimateReady[mover]) {
    // Escaped tokens are as interchangeable as reserve ones (they all sit on
    // the same "escaped" non-position) — one candidate, flat score.
    const exhumeTargets = getExhumeTargets(state, power, mover);
    if (exhumeTargets.length > 0) {
      const score = scoreExhume(rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "exhume", targetTokenId: exhumeTargets[0] };
      }
    }
  }

  if (cls === "cleric") {
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const targetId of getBlessTargets(state, power, mover)) {
      const score = scoreBless(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "bless", targetTokenId: targetId };
      }
    }
    for (const targetId of getHealTargets(state, power, mover)) {
      const score = scoreHeal(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "heal", targetTokenId: targetId };
      }
    }
    if (power.ultimateReady[mover]) {
      const pool = getBenedictionTargets(state, power, mover);
      if (pool.length > 0) {
        const score = scoreBenediction(pool.length, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "benediction" };
        }
      }
    }
  }

  if (cls === "rogue") {
    const rogueFoe: PlayerId = mover === "p1" ? "p2" : "p1";
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const targetId of getPickpocketTargets(state, power, mover)) {
      const score = scorePickpocket(power, rogueFoe, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "pickpocket", targetTokenId: targetId };
      }
    }
    for (const targetId of getBackstabTargets(state, power, mover)) {
      const score = scoreBackstab(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "backstab", targetTokenId: targetId };
      }
    }
    if (power.ultimateReady[mover]) {
      for (const targetId of getGrandHeistTargets(state, power, mover)) {
        const score = scoreGrandHeist(state, power, targetId, rogueFoe, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "grandHeist", targetTokenId: targetId };
        }
      }
    }
  }

  return best;
}

// ============================================================================
// CANDIDATE ENUMERATION — shared by easy and hard. Mirrors validateUsePower's
// gates in room-engine.ts EXACTLY (class, charge affordability, target
// getters), so every candidate either tier emits is guaranteed to survive
// the server's re-validation. Kept as one enumerator on purpose: three
// per-tier copies of these gates would drift.
// ============================================================================

function enumerateCandidates(state: GameState, power: PowerState, moves: PowerMove[]): PowerAction[] {
  const mover = state.currentPlayer;
  const cls: PlayerClass = power.classes[mover];
  const charges = power.charges[mover];
  const out: PowerAction[] = [];

  for (const m of moves) {
    out.push({ kind: "move", move: m });
    // Deliberately validateUsePower's gate (chargeAvailable + charges >= 1),
    // NOT standard's extra chargeSweepCaptures.length > 0 discipline — an
    // empty-sweep Charge is legal-but-wasteful, which is exactly the blunder
    // pool easy picks from; hard's charge-valued eval prices the wasted
    // charge and declines it on its own.
    if (cls === "warrior" && m.chargeAvailable && charges >= 1) {
      out.push({ kind: "charge", move: m });
    }
  }
  if (cls === "archer" && charges >= 1) {
    for (const id of getPushTargets(state, power, mover)) out.push({ kind: "push", targetTokenId: id });
  }
  if (cls === "archer" && charges === CHARGE_CAP) {
    for (const id of getChargedShotTargets(state, power, mover)) {
      out.push({ kind: "chargedShot", targetTokenId: id });
    }
  }
  if (cls === "mage" && canReflipAgain(power, mover)) out.push({ kind: "reflip" });
  if (cls === "mage" && power.ultimateReady[mover]) {
    for (const id of getBlinkStrikeTargets(state, power, mover)) {
      out.push({ kind: "blinkStrike", targetTokenId: id });
    }
  }
  if (cls === "warrior" && power.ultimateReady[mover]) {
    for (const id of getWarpathTargets(state, power, mover)) out.push({ kind: "warpath", targetTokenId: id });
  }
  if (cls === "warrior" && charges >= 1) {
    const bulwarkTargets = getBulwarkTargets(state, power, mover);
    for (const id of bulwarkTargets) out.push({ kind: "bulwark", tokenId: id });
    if (charges === CHARGE_CAP) {
      for (const id of bulwarkTargets) out.push({ kind: "bulwark", tokenId: id, reinforced: true });
    }
  }
  if (cls === "necromancer" && getReviveSpawnTile(state, power, mover) !== null) {
    // One candidate, no payload — the corpse determines everything.
    out.push({ kind: "revive" });
  }
  if (cls === "necromancer" && getCorpseExplosionTargets(state, power, mover).length > 0) {
    out.push({ kind: "corpseExplosion" });
  }
  if (cls === "necromancer" && power.ultimateReady[mover]) {
    // Same one-candidate collapse: every escaped token is equally escaped.
    const exhumeTargets = getExhumeTargets(state, power, mover);
    if (exhumeTargets.length > 0) out.push({ kind: "exhume", targetTokenId: exhumeTargets[0] });
  }
  if (cls === "cleric") {
    for (const id of getBlessTargets(state, power, mover)) out.push({ kind: "bless", targetTokenId: id });
    for (const id of getHealTargets(state, power, mover)) out.push({ kind: "heal", targetTokenId: id });
    if (power.ultimateReady[mover] && getBenedictionTargets(state, power, mover).length > 0) {
      out.push({ kind: "benediction" });
    }
  }
  if (cls === "rogue") {
    for (const id of getPickpocketTargets(state, power, mover)) out.push({ kind: "pickpocket", targetTokenId: id });
    for (const id of getBackstabTargets(state, power, mover)) out.push({ kind: "backstab", targetTokenId: id });
    if (power.ultimateReady[mover]) {
      for (const id of getGrandHeistTargets(state, power, mover)) out.push({ kind: "grandHeist", targetTokenId: id });
    }
  }
  return out;
}

// ============================================================================
// EASY — mostly random over every legal action, never suicidal about a win.
// ============================================================================

function pickEasyPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number,
): PowerAction | null {
  // Win short-circuit: an easy bot that declines to end the game produces
  // unbounded, infuriating matches — take it every time.
  const winMove = moves.find((m) => m.causesWin);
  if (winMove) return { kind: "move", move: winMove };
  if (rand() < EASY_HEED_P) return pickStandardPowerAction(state, power, moves, flip, rand);
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null; // same auto-skip path as standard's null
  return candidates[Math.floor(rand() * candidates.length)];
}

// ============================================================================
// HARD — charge-valued static eval + one-ply expectimax over FLIP_WEIGHTS.
//
// Every candidate is SIMULATED through the same pure apply* functions the
// server executes with, then valued by averaging the next actor's best
// response over the five flip outcomes. The eval's explicit charge value is
// what stops the bot burning the bank on marginal spends — the failure mode
// this file has fixed three times by hand (see scoreBulwark's history note);
// pricing the resource in the eval solves it structurally instead of
// per-ability.
// ============================================================================

/** Hard tier eval terms — board terms match bot.ts's evaluateClassic values
 *  (duplicated, not imported: this file deliberately never imports bot.ts),
 *  plus the Master Killer economy. */
const MK_EVAL_ESCAPED = 200;
const MK_EVAL_PER_TILE = 8;
const MK_EVAL_SHIELD_TILE = 25;
const MK_EVAL_THREAT_BASE = 40;
const MK_EVAL_THREAT_PER_TILE = 6;
/** A banked charge is roughly "one Push, or one Re-flip, on demand" — worth
 *  a few tiles of progress (3 tiles at MK_EVAL_PER_TILE) but well under a
 *  capture's swing, so the bot spends when a spend beats holding, not
 *  reflexively either way. */
const MK_EVAL_CHARGE = 24;
/** A banked ultimate is a guaranteed future capture of a token of the bot's
 *  choosing (Blink Strike / Warpath both bypass shields and Ward) — priced
 *  near a mid-board capture's positional swing so it isn't spent on scraps. */
const MK_EVAL_ULTIMATE = 70;
/** A NECROMANCER'S banked charge, specifically — priced well under the
 *  shared MK_EVAL_CHARGE because the class has no other outlet for it: no
 *  Push, no Re-flip, no Bulwark, no at-cap passive. Raise fuel is all a
 *  held charge can ever become, so holding it is mostly carrying cost
 *  (income past CHARGE_CAP overflows into nothing), and pricing it at the
 *  shared 24 made the hard tier hoard the bank while standard's
 *  dark-on-sight policy (see scoreRaiseDead) converted it into bodies —
 *  hard lost the necromancer mirror 29.0/71.0 against standard, dragging
 *  the mk hard-vs-standard separation gate to a failing 54.0% aggregate
 *  (need >= 55). Swept 24 (the shared price) / 8 / 4 against that gate:
 *  29.0 -> 31.3 -> 34.2 in the mirror. Price alone couldn't close the
 *  rest — the remainder was policy, not valuation; see
 *  MK_EVAL_PLAIN_RAISE_HOLDBACK, MK_EVAL_DARK_RAISE_BIAS, and
 *  MK_EVAL_NECRO_THREAT_SCALE for the other three-quarters of the fix. */
const MK_EVAL_NECRO_CHARGE = 4;
/** REWORK NOTE (2026-07-19): the constants that priced the OLD kit's
 *  graveyard economy — reserve-token credit, self-exposure discount, the
 *  plain/dark raise holdback-and-bias pair — died with that kit. Their
 *  replacements below price the Revive kit instead: a banked corpse, an
 *  active thrall, and the new danger of BEING the necromancer's prey.
 *  (Old sweep archaeology lives in git history.)
 *
 *  A valid banked corpse is a Revive waiting on funding: option value,
 *  real but modest — the victim can deny it any turn by re-entering. */
const MK_EVAL_CORPSE = 15;
/** An active thrall: a temporary extra attacker on the row. Scaled by
 *  turnsLeft/THRALL_TURNS (a last-turn thrall is worth half a fresh one)
 *  plus a per-menaced-enemy bonus in mkEvalSide — the thrall's value IS
 *  its targets; parked on an empty row it's mostly a re-entry denial. */
const MK_EVAL_THRALL = 40;
const MK_EVAL_THRALL_MENACE = 15;
/** Threat scale on tokens exposed to a NECROMANCER enemy: a death against
 *  the rework's necromancer pays the full soul bounty AND banks a corpse —
 *  strictly worse than dying to anyone else — so exposure to one is
 *  priced up, the eval-shaped version of "don't feed the graveyard". */
const MK_EVAL_NECRO_PREY_SCALE = 1.25;
/** Threat scale on tokens exposed to a ROGUE enemy: a death against one
 *  also drains ROGUE_STEAL_ON_CAPTURE mana from the victim's own bank
 *  (Larceny) on top of the token itself — strictly worse than dying to a
 *  class that only takes the stone, so exposure is priced up, the same
 *  "don't feed it" idea MK_EVAL_NECRO_PREY_SCALE already prices for the
 *  necromancer. Lower than the necromancer's own scale (1.25) since a
 *  flat 1-mana drain is a smaller bonus than a full soul bounty + corpse.
 *  STARTING VALUE, not yet sim-tuned. */
const MK_EVAL_ROGUE_PREY_SCALE = 1.1;
/** A necromancer holding ultimateReady while a live Exhume target exists (a
 *  foe token has escaped): the held flag is priced LOW, not at
 *  MK_EVAL_ULTIMATE. For this class the ultimate is Exhume, not a
 *  guaranteed capture, and once a target exists holding is carrying cost
 *  rather than option value — the foe needs only four escapes to end the
 *  game, so an unfired Exhume risks expiring worthless. Pricing the held
 *  flag low is what makes the post-spend state (escape revoked, flag gone)
 *  evaluate ABOVE the post-hold state — the eval-shaped version of
 *  scoreUltimateStrike's "don't sit on a banked flag" flat bonus, and the
 *  structural reading of "opponent escapes are worth attacking". With no
 *  target yet, the flag keeps full MK_EVAL_ULTIMATE option value. */
const MK_EVAL_EXHUME_HELD = 20;
/** Root bias on a Revive candidate: the one-ply search prices the board it
 *  can see, not the denial it can't — every turn the corpse sits banked is
 *  a turn the victim may re-enter it and void the cast entirely, so a
 *  castable Revive carries urgency beyond its static eval. Small; the
 *  simulated thrall (same-flip follow-up + MK_EVAL_THRALL) carries the
 *  real value. */
const MK_EVAL_REVIVE_BIAS = 20;
/** Cleric (2026-07-21): a live blessing on an own on-board stone. Priced
 *  above MK_EVAL_BULWARK's 12 — it never expires and denies the attacker
 *  the kill's whole economy — but well under a capture's swing, so hard
 *  spends the bank on one only when the position justifies it (the
 *  threat-discount below carries the real defensive value). */
const MK_EVAL_BLESSED = 20;
/** A wounded stone: mostly a Heal option — small, so hard actually mends
 *  when threatened rather than hoarding the mana. */
const MK_EVAL_WOUNDED = 4;
/** How much of the normal capture-threat penalty a BLESSED token still
 *  pays: it survives the first hit, so its exposure is real but heavily
 *  discounted (the attacker must spend two turns, and the first pays them
 *  nothing). Not zero — a blessed stone deep in enemy reach still ties
 *  down the Heal budget. */
const MK_EVAL_BLESSED_THREAT_SCALE = 0.4;
/** Live shield-streak progress toward that ultimate, per landing banked. */
const MK_EVAL_STREAK = 12;
/** An active Bulwark on an own token — insurance, real but modest (it
 *  expires on its own; see BULWARK_TURNS). */
const MK_EVAL_BULWARK = 12;
/** A certain win outranks any expectation sum (max weighted contribution of
 *  a probabilistic win is < 1 · MK_WIN_VALUE). */
const MK_WIN_VALUE = 1_000_000;

/** Fixed rand for inside-the-search simulation: only Rain of Arrows' target
 *  pick consumes it, and search nodes must be deterministic so candidate
 *  values are comparable. The REAL rand still governs the authoritative
 *  apply in room-engine once an action is chosen. */
const SIM_RAND = () => 0.5;

/** One player's side of the eval: escaped >> progress + shield perch, minus
 *  probability-weighted capture threat (skipped while Ward/Bulwark
 *  protects the token), plus the charge economy terms. Possession-aware
 *  (Revive rework): a token of yours serving the enemy is worth nothing to
 *  you until it comes home; a thrall you command is an attack asset priced
 *  by its remaining turns and the enemies it menaces; a valid banked
 *  corpse is Revive option value. */
function mkEvalSide(state: GameState, power: PowerState, player: PlayerId): number {
  const foe: PlayerId = player === "p1" ? "p2" : "p1";
  let score = 0;
  for (const t of state.tokens) {
    const possessor = possessorOf(power, t.id);
    if (t.owner === player && possessor !== null && possessor !== player) continue; // enslaved: worth 0 to its owner
    if (t.owner !== player) {
      if (possessor !== player) continue;
      // My thrall: temporary attacker, no progression value (it can never
      // escape) — its worth is duration times menace.
      const turnsLeft = power.thrall[player]?.turnsLeft ?? 0;
      let menaced = 0;
      for (const e of state.tokens) {
        if (e.owner === player || possessorOf(power, e.id) !== null) continue;
        if (e.position > t.position && e.position <= t.position + 4 && e.position <= 11 && e.position >= 4) menaced++;
      }
      score += ((MK_EVAL_THRALL + MK_EVAL_THRALL_MENACE * menaced) * turnsLeft) / THRALL_TURNS;
      continue;
    }
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += MK_EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) continue; // reserve is worth exactly nothing
    score += MK_EVAL_PER_TILE * t.position;
    const tile = BOARD_LAYOUT[t.position];
    if (tile.type === "shield") score += MK_EVAL_SHIELD_TILE;
    if (
      tile.isContested &&
      tile.type !== "shield" &&
      !isWarded(state, power, t) &&
      !isBulwarked(power, t)
    ) {
      // Dying to a necromancer pays their full soul bounty and banks a
      // corpse — exposure to one is priced up (MK_EVAL_NECRO_PREY_SCALE).
      // Dying to a rogue drains a mana too (Larceny) — a smaller version
      // of the same idea (MK_EVAL_ROGUE_PREY_SCALE). A BLESSED token's
      // exposure is discounted instead: it survives the first hit
      // (MK_EVAL_BLESSED_THREAT_SCALE).
      const preyScale =
        power.classes[foe] === "necromancer"
          ? MK_EVAL_NECRO_PREY_SCALE
          : power.classes[foe] === "rogue"
            ? MK_EVAL_ROGUE_PREY_SCALE
            : 1;
      const threatScale = preyScale * (isBlessed(power, t.id) ? MK_EVAL_BLESSED_THREAT_SCALE : 1);
      for (const e of state.tokens) {
        if (effectiveOwner(power, e) === player || e.position < 0 || e.position >= PATH_LENGTH_PER_PLAYER)
          continue;
        const gap = t.position - e.position;
        if (gap >= 1 && gap <= 4) {
          score -=
            (threatScale * (MK_EVAL_THREAT_BASE + MK_EVAL_THREAT_PER_TILE * t.position) * FLIP_WEIGHTS[gap]) /
            FLIP_WEIGHT_TOTAL;
        }
      }
    }
    if (isBulwarked(power, t)) score += MK_EVAL_BULWARK;
    if (power.vitality[t.id] === "blessed") score += MK_EVAL_BLESSED;
    if (power.vitality[t.id] === "wounded") score += MK_EVAL_WOUNDED;
  }
  // A valid banked corpse is a Revive waiting on funding.
  const corpse = power.corpse[player];
  if (corpse && state.tokens.find((t) => t.id === corpse.tokenId)?.position === -1) {
    score += MK_EVAL_CORPSE;
  }
  // Necromancer charges are revive fuel and nothing else — see
  // MK_EVAL_NECRO_CHARGE's doc for the separation-gate failure the shared
  // price caused.
  score +=
    (power.classes[player] === "necromancer" ? MK_EVAL_NECRO_CHARGE : MK_EVAL_CHARGE) *
    power.charges[player];
  if (power.ultimateReady[player]) {
    const necroWithExhumeTarget =
      power.classes[player] === "necromancer" &&
      state.tokens.some((t) => t.owner !== player && t.position >= PATH_LENGTH_PER_PLAYER);
    score += necroWithExhumeTarget ? MK_EVAL_EXHUME_HELD : MK_EVAL_ULTIMATE;
  }
  score += MK_EVAL_STREAK * power.shieldStreak[player];
  return score;
}

/** Antisymmetric eval from `me`'s perspective (me minus foe). */
function evaluateMK(state: GameState, power: PowerState, me: PlayerId): number {
  const foe: PlayerId = me === "p1" ? "p2" : "p1";
  return mkEvalSide(state, power, me) - mkEvalSide(state, power, foe);
}

/** Best own follow-up after keeping the turn (shield landing), one flip.
 *  Dead flips (0 / no moves) skip — the board stands as evaluated. Replies
 *  here are plain power moves only; deeper power actions aren't modeled —
 *  one ply of plain replies keeps the search cheap, and the separation sim
 *  is the judge of whether that's strong enough. */
function mkBestOwnFollowup(state: GameState, power: PowerState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateMK(state, power, me);
  const moves = getLegalPowerMoves(state, power, flip);
  if (moves.length === 0) return evaluateMK(state, power, me);
  let best = -Infinity;
  for (const m of moves) {
    if (m.causesWin) return MK_WIN_VALUE;
    const r = applyPowerMove(state, power, m, me, SIM_RAND);
    const v = evaluateMK(r.state, r.power, me);
    if (v > best) best = v;
  }
  return best;
}

/** Opponent's best (our worst) plain-move reply for one flip — the min node. */
function mkWorstOppReply(state: GameState, power: PowerState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateMK(state, power, me);
  const opp = state.currentPlayer;
  const moves = getLegalPowerMoves(state, power, flip);
  if (moves.length === 0) return evaluateMK(state, power, me);
  let worst = Infinity;
  for (const m of moves) {
    if (m.causesWin) return -MK_WIN_VALUE;
    const r = applyPowerMove(state, power, m, opp, SIM_RAND);
    const v = evaluateMK(r.state, r.power, me);
    if (v < worst) worst = v;
  }
  return worst;
}

/** The shared post-action expectation: whoever `state.currentPlayer` is
 *  after the candidate resolved (the mover again on a shield extra turn, the
 *  opponent otherwise) gets a max/min node averaged over the five flips. */
function mkValueAfterAction(state: GameState, power: PowerState, me: PlayerId): number {
  if (state.winner === me) return MK_WIN_VALUE;
  if (state.winner !== null) return -MK_WIN_VALUE;
  const ownTurn = state.currentPlayer === me;
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
    value += p * (ownTurn ? mkBestOwnFollowup(state, power, f, me) : mkWorstOppReply(state, power, f, me));
  }
  return value;
}

/** Value of Re-flip: average over the replacement flip of the best immediate
 *  move's full post-apply expectation (so it's on the same scale as every
 *  other candidate). applyReflip's charge spend is priced by the eval's
 *  MK_EVAL_CHARGE term, so the hard Mage re-flips a capture-less 1 when
 *  holding spare charges — strictly smarter than standard's "only on 0/no
 *  moves" rule — and this also upgrades the zero-move rescue path (the
 *  engine calls the bot with moves=[] before auto-skipping). */
function mkReflipValue(state: GameState, power: PowerState, me: PlayerId): number {
  const powerR = applyReflip(power, me);
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
    if (f === 0) {
      value += p * evaluateMK(state, powerR, me);
      continue;
    }
    const moves = getLegalPowerMoves(state, powerR, f);
    if (moves.length === 0) {
      value += p * evaluateMK(state, powerR, me);
      continue;
    }
    let best = -Infinity;
    for (const m of moves) {
      const v = m.causesWin
        ? MK_WIN_VALUE
        : (() => {
            const r = applyPowerMove(state, powerR, m, me, SIM_RAND);
            return mkValueAfterAction(r.state, r.power, me);
          })();
      if (v > best) best = v;
    }
    value += p * best;
  }
  return value;
}

/** Value of Bless: a turn-keeping cast (applyBless's contract — the SAME
 *  flip stays live, no re-roll), so its value is the best same-flip
 *  follow-up on the post-cast board — mkReviveValue's exact shape, and the
 *  same trap it exists to avoid: mkValueAfterAction's own-turn arm would
 *  average over a fresh flip the mover never gets. (Heal ends the turn and
 *  values through the normal mkSimulate path.) The spent mana is priced by
 *  MK_EVAL_CHARGE, the blessing by MK_EVAL_BLESSED and the threat discount
 *  — so hard blesses when the exchange plus the follow-up beats holding. */
function mkBlessingValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "bless" }>,
  flip: number,
  me: PlayerId,
): number {
  const r = applyBless(state, power, c.targetTokenId, me);
  if (flip === 0) return evaluateMK(r.state, r.power, me);
  const moves = getLegalPowerMoves(r.state, r.power, flip);
  if (moves.length === 0) return evaluateMK(r.state, r.power, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin
      ? MK_WIN_VALUE
      : (() => {
          const q = applyPowerMove(r.state, r.power, m, me, SIM_RAND);
          return mkValueAfterAction(q.state, q.power, me);
        })();
    if (v > best) best = v;
  }
  return best;
}

/** Value of Pickpocket: a turn-keeping cast (applyPickpocket's contract —
 *  the SAME flip stays live), same shape as mkBlessingValue — the best
 *  same-flip follow-up on the post-drain board. Meaningful beyond the
 *  eval's own MK_EVAL_CHARGE bookkeeping: draining a Mage below CHARGE_CAP
 *  can drop their Ward THIS SAME FLIP, which the follow-up move search
 *  will actually see and price (a capture unavailable a moment ago may
 *  now be on the table). */
function mkPickpocketValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "pickpocket" }>,
  flip: number,
  me: PlayerId,
): number {
  void c; // uniform signature with mkBlessingValue's; the target id doesn't affect the drain
  const nextPower = applyPickpocket(power, me);
  if (flip === 0) return evaluateMK(state, nextPower, me);
  const moves = getLegalPowerMoves(state, nextPower, flip);
  if (moves.length === 0) return evaluateMK(state, nextPower, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin
      ? MK_WIN_VALUE
      : (() => {
          const q = applyPowerMove(state, nextPower, m, me, SIM_RAND);
          return mkValueAfterAction(q.state, q.power, me);
        })();
    if (v > best) best = v;
  }
  return best;
}

/** Simulate one non-reflip candidate through the same pure apply* functions
 *  the server executes with. */
function mkSimulate(
  state: GameState,
  power: PowerState,
  c: Exclude<PowerAction, { kind: "reflip" }>,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  switch (c.kind) {
    case "move":
      return applyPowerMove(state, power, c.move, mover, SIM_RAND);
    case "charge":
      return applyCharge(state, power, c.move, mover, SIM_RAND);
    case "push":
      return applyPush(state, power, c.targetTokenId, mover);
    case "chargedShot":
      return applyChargedShot(state, power, c.targetTokenId, mover);
    case "blinkStrike":
      return applyBlinkStrike(state, power, c.targetTokenId, mover);
    case "warpath":
      return applyWarpath(state, power, c.targetTokenId, mover);
    case "bulwark":
      return applyBulwark(state, power, c.tokenId, mover, c.reinforced ?? false);
    case "revive":
      return applyRevive(state, power, mover);
    case "corpseExplosion":
      return applyCorpseExplosion(state, power, mover);
    case "exhume":
      return applyExhume(state, power, c.targetTokenId, mover);
    case "bless":
      return applyBless(state, power, c.targetTokenId, mover);
    case "heal":
      return applyHeal(state, power, c.targetTokenId, mover);
    case "benediction":
      return applyBenediction(state, power, mover);
    case "backstab":
      return applyBackstab(state, power, c.targetTokenId, mover);
    case "grandHeist":
      return applyGrandHeist(state, power, c.targetTokenId, mover);
    case "pickpocket":
      // Never actually reached in practice (pickHardPowerAction intercepts
      // "pickpocket" early via mkPickpocketValue, same as "bless"'s own
      // early intercept above) — kept for switch exhaustiveness, same
      // defensive completeness "bless" already has here.
      return { state, power: applyPickpocket(power, mover) };
  }
}

/** Value of Revive: the cast keeps the turn AND the flip (applyRevive's
 *  contract — no re-roll), so its value is the best same-flip follow-up on
 *  the post-revive board (the thrall itself may be the mover), ending in
 *  the same mkValueAfterAction expectation every other candidate ends in.
 *  NOT mkValueAfterAction directly on the post-revive state — its own-turn
 *  arm would wrongly average over a fresh flip the mover never gets,
 *  hiding the cast's actual point (e.g. a flipped 2 the thrall itself can
 *  use to kill). Same one-power-action-per-turn depth limit as
 *  mkReflipValue. The spent bank is priced by MK_EVAL_NECRO_CHARGE, the
 *  consumed corpse by MK_EVAL_CORPSE, and the risen thrall by
 *  MK_EVAL_THRALL(+menace) — so hard revives when the exchange plus the
 *  follow-up beats holding. */
function mkReviveValue(
  state: GameState,
  power: PowerState,
  flip: number,
  me: PlayerId,
): number {
  const r = applyRevive(state, power, me);
  if (flip === 0) return evaluateMK(r.state, r.power, me);
  const moves = getLegalPowerMoves(r.state, r.power, flip);
  if (moves.length === 0) return evaluateMK(r.state, r.power, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin
      ? MK_WIN_VALUE
      : (() => {
          const q = applyPowerMove(r.state, r.power, m, me, SIM_RAND);
          return mkValueAfterAction(q.state, q.power, me);
        })();
    if (v > best) best = v;
  }
  return best;
}

/** Expectimax root: value every candidate, tiny rand tie-break only (hard is
 *  deterministic-feeling on purpose — no 20-point jitter). Budget: ~25
 *  candidates x 5 flips x ~10 replies, plus Re-flip's 5x10x(5x10) and the
 *  (at most two) Raise variants' 10x(5x10) each — under 10k O(8-token)
 *  evals, low single-digit ms, safe inside a server tick even across
 *  withDoc's 4 CAS retries. `flip` feeds only the Raise candidates (the one
 *  action that keeps the current flip alive — see mkRaiseValue). */
function pickHardPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number,
): PowerAction | null {
  const mover = state.currentPlayer;
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null;

  let best: PowerAction | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    let value: number;
    if ((c.kind === "move" || c.kind === "charge") && c.move.causesWin) {
      value = MK_WIN_VALUE;
    } else if (c.kind === "reflip") {
      value = mkReflipValue(state, power, mover);
    } else if (c.kind === "revive") {
      // Denial urgency the one-ply search can't see — see MK_EVAL_REVIVE_BIAS.
      value = mkReviveValue(state, power, flip, mover) + MK_EVAL_REVIVE_BIAS;
    } else if (c.kind === "bless") {
      // Turn-keeping, same-flip follow-up valuation — see mkBlessingValue.
      value = mkBlessingValue(state, power, c, flip, mover);
    } else if (c.kind === "pickpocket") {
      // Turn-keeping, same-flip follow-up valuation — see mkPickpocketValue.
      value = mkPickpocketValue(state, power, c, flip, mover);
    } else {
      const r = mkSimulate(state, power, c, mover);
      value = mkValueAfterAction(r.state, r.power, mover);
    }
    value += rand() * 1e-3;
    if (value > bestScore) {
      bestScore = value;
      best = c;
    }
  }
  return best;
}
