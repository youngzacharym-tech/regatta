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
  applyBless,
  applyBenediction,
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyCorpseExplosion,
  applyCurse,
  applyExhume,
  applyFelStorm,
  applyGrandHeist,
  applyBloodbath,
  applyCrescendo,
  applyInspire,
  applySongOfHaste,
  applyPiercingShot,
  applyRecklessSwing,
  applyWhirlwind,
  applyHeal,
  applyPickpocket,
  applyBackstab,
  applyBlink,
  getBlinkTiles,
  blinkStone,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyRevive,
  applySacrifice,
  applySnare,
  applyVanish,
  applyWarpath,
  applyWildHunt,
  canReflipAgain,
  CHARGE_CAP,
  CHARGED_SHOT_COST,
  BULWARK_REINFORCED_COST,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  CURSE_COST,
  CURSE_TURNS,
  effectiveOwner,
  FEL_STORM_RETURN_POSITION,
  getBenedictionTargets,
  getBlessTargets,
  getBlinkStrikeTargets,
  getRainOfArrowsTargets,
  applyRainOfArrows,
  getBulwarkTargets,
  getChargedShotTargets,
  getCorpseExplosionTargets,
  getCurseTargets,
  getExhumeTargets,
  getFelStormTargets,
  getGrandHeistTargets,
  getBloodbathTargets,
  getCrescendoTargets,
  getInspireTargets,
  getSongOfHasteTargets,
  getPiercingShotTargets,
  getRecklessSwingTargets,
  getWhirlwindTargets,
  getHealTargets,
  getLegalPowerMoves,
  getPickpocketTargets,
  getBackstabTargets,
  getPushTargets,
  getReviveSpawnTile,
  getSacrificeTargets,
  getSnareTiles,
  getVanishTargets,
  getWarpathTargets,
  getWildHuntTargets,
  WILD_HUNT_FREEZE_TURNS,
  isBlessed,
  isBulwarked,
  isCursed,
  isHamstrung,
  isWarded,
  NECRO_CHARGE_CAP,
  possessorOf,
  PUSH_DISTANCE,
  PUSH_WARD_DISTANCE,
  rageFor,
  RECKLESS_SELF_KNOCKBACK,
  SACRIFICE_COST,
  THRALL_TURNS,
  VANISH_COST,
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
    // (TRIED 2026-09-16: valuing a kill by the stone a Warlock's Dark
    // Bargain would take instead. It made the archer WORSE vs warlock,
    // 28 -> 25%: a bargained kill still shrinks the army and delays the
    // runner, so declining those shots only lets the warlock race.)
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

/** Score Warrior's Bulwark (and, via the shared call site below, Rogue's
 *  Vanish — the same mechanic under a Rogue cast, see VANISH_COST in
 *  master-killer.ts): defensive insurance on the mover's most-advanced
 *  un-Bulwarked on-board token, scaled by how far along it already is
 *  (mirrors scorePush's own target.position scaling) so the bot naturally
 *  favors protecting whichever token has the most invested.
 *
 *  GATED on a live capture threat (bulwarkFacesThreat) — 2026-07-25. The
 *  negative floor alone (see below) was NOT enough: position scaling plus the
 *  random jitter let any mid-to-well-advanced token clear zero on a quiet turn,
 *  so the bot cast Bulwark/Vanish on un-threatened stones the large majority of
 *  the time (measured: only ~13-30% of casts actually blocked a capture across
 *  every matchup — bulwarkBlock/g vs bulwark/g or vanish/g in
 *  batch-random-master-killer-games.ts). For a Rogue that is especially
 *  costly: Vanish is its ONLY defensive tool, so wasting ~85% of casts made the
 *  class look far weaker than it plays with the ability used defensively. The
 *  gate is the same one scoreReinforcedBulwark/scoreBless/scoreHeal already use
 *  (bulwarkFacesThreat's own doc records that adding it FLIPPED every
 *  second-charge Bulwark design from tanking the Warrior to improving it), and
 *  matches how a human uses a react-to-danger shield: cast it when a stone is
 *  actually reachable, not on spec.
 *
 *  The negative floor (score starts at -40) is kept underneath the gate as a
 *  second line of defense, and is itself the fix for an earlier real bug — a
 *  new instance of the file's established "flat bonus quietly out-competes a
 *  strictly-better plain move" failure mode (see the chargeSweepCaptures.length
 *  check above for the original case). Bulwark is essentially ALWAYS evaluable
 *  for a Warrior with a spare charge (unlike Push, which needs a specific enemy
 *  on a contested tile, or Reflip, which needs a bad flip) — so ANY
 *  comfortably-positive flat score, even a small one, made the bot cast it
 *  almost every eligible turn instead of advancing or Charging. Balance-sim
 *  fallout was severe: archer-vs-warrior swung from the ~43.6/56.4
 *  warrior-favored baseline all the way to ~80/20 ARCHER-favored, because a
 *  Warrior burning its charge income on defense instead of Charge's actual
 *  capture-and-advance loop stops converting board control into wins. With the
 *  threat gate now in front, the floor mostly matters as a tiebreak among
 *  genuinely-threatened tokens (well-advanced ones, position 12+, pull back
 *  toward/above zero) — occasional insurance on a valuable token when nothing
 *  better is on offer, not a default action. */
function scoreBulwark(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  if (!bulwarkFacesThreat(state, target)) return -Infinity;
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

/** Score Rogue's Vanish. Vanish IS Bulwark's mechanic under a Rogue cast (see
 *  VANISH_COST), and it is scored with the SAME threat-gated, negative-floor
 *  discipline scoreBulwark uses — a Rogue vanishes a stone that's actually in
 *  capture danger, not on spec (that gate's own history note explains why an
 *  ungated defensive cast tanks the class that spams it).
 *
 *  It does NOT get a special premium for Push threats, even though a Vanished
 *  stone is Push-immune (see isVanished/getPushTargets). That was tried and
 *  REJECTED by simulation: proactively vanishing against an Archer's Push made
 *  archer-vs-rogue WORSE at every tested strength (72.4 baseline -> 74.9 modest
 *  -> 76.9 aggressive, rogue win% falling). Vanish ends the turn, so every
 *  proactive cast forfeits a full turn of race progress — more than a
 *  PUSH_DISTANCE=1 shove costs — and the Archer's real pressure is Snipe (a
 *  free passive capture, ~5/game) that hiding one stone can't offset. So the
 *  bot only vanishes reactively to a live capture threat; the Push-immunity is
 *  a correctness/identity property that helps a human Rogue, not a tempo the
 *  AI should spend turns chasing. Kept as its own function (not folded back
 *  into scoreBulwark) purely to hold this finding at the call site. */
function scoreVanish(state: GameState, targetId: number, rand: () => number): number {
  return scoreBulwark(state, targetId, rand);
}

/** Score Re-flip: only worth it when the CURRENT flip is bad — zero, or a
 *  flip that produces no legal moves at all (about to be skipped anyway). */
/** Score Mage's Blink (added 2026-09-13): a turn-ending reposition of the
 *  rearmost on-board stone, priced on the same axis as scoreMove (a plain
 *  advance is worth about its landing tile). Pays for tiles gained beyond
 *  what a flip would have given, hates landing in front of an enemy's
 *  reach (scoreMove's own -80 rule), likes landing behind one, and is the
 *  turn's rescue when the flip left no move. Negative floor: the cast has
 *  to buy real distance to beat simply moving, and it drops the Ward when
 *  cast from a full bank. STARTING VALUES, not yet sim-tuned. */
function scoreBlink(state: GameState, power: PowerState, moves: PowerMove[], tile: number, rand: () => number): number {
  const mover = state.currentPlayer;
  const stone = blinkStone(state, power, mover);
  if (!stone) return -Infinity;
  const gained = tile - Math.max(0, stone.position);
  let score = MK_BLINK_FLOOR + MK_BLINK_PER_TILE * gained + tile;
  const foes = state.tokens.filter((t) => effectiveOwner(power, t) !== mover && t.position >= 4 && t.position <= 11);
  if (foes.some((t) => tile - t.position >= 1 && tile - t.position <= 4)) score -= 80;
  if (foes.some((t) => t.position - tile >= 1 && t.position - tile <= 4)) score += 45;
  if (moves.length === 0) score += 200;
  if (power.charges[mover] >= CHARGE_CAP) score -= 60; // the Ward falls with the spend
  return score + rand() * 20;
}
const MK_BLINK_FLOOR = -100; // first run at -70/14: 5 blinks/game and an 88.7% Mage — the cast must set something up, not just walk
const MK_BLINK_PER_TILE = 16;

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
    // Lethal blast (2026-09-13): every unprotected victim is a send-home; a
    // blessed one is only wounded, worth roughly a Push's break.
    score += isBlessed(power, t.id) ? 140 : 380 + t.position * 8;
  }
  // Desecration forfeits the corpse Revive would have raised — when the
  // body is still banked. Since the grave split (PowerState.grave) the
  // usual case is a grave Revive already emptied: nothing forfeited, and
  // the send-home price above is the whole story. scoreRevive's 900 base
  // still wins the fresh-corpse choice on purpose: raise now, and the open
  // grave keeps this cast on the menu for later.
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
 *  bank (Charged Shot, Reinforced Bulwark, Bless/Heal both cost it,
 *  Revive/Corpse Explosion at their own cap) — draining a foe sitting
 *  AT their cap denies that outright, so it clears a real, always-positive
 *  bar. A Mage at the cap is the standout case: the drain also drops Ward
 *  THIS INSTANT, scored near scorePush's own Ward-removal tier. Below the
 *  cap, biased NEGATIVE on purpose — this file's own established
 *  discipline (see scoreBulwark's history note) against a small flat
 *  positive reflexively out-competing a genuine capture chance every
 *  single turn. STARTING VALUES, not yet sim-tuned. */
/** Score Rogue's Backstab (restored 2026-09-13): a guaranteed hit, scored
 *  like Blink Strike/Warpath's guaranteed capture — EXCEPT a Cleric-blessed
 *  target only wounds (a charge back and the shelter denied, but the stone
 *  survives), priced closer to a soft push than a kill. Costs half the
 *  4-bank, so it competes with Pickpocket + Vanish for the same mana; the
 *  bar it clears is a real capture's. STARTING VALUES, not yet sim-tuned. */
function scoreBackstab(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const wounds = isBlessed(power, targetId);
  return (wounds ? 260 : 460) + target.position * 10 + rand() * 20;
}

function scorePickpocket(power: PowerState, foe: PlayerId, rand: () => number): number {
  const cap = power.classes[foe] === "necromancer" ? NECRO_CHARGE_CAP : CHARGE_CAP;
  const atCap = power.charges[foe] >= cap;
  const dropsWard = power.classes[foe] === "mage" && atCap;
  let score = dropsWard ? 260 : atCap ? 90 : -40;
  score += rand() * 20;
  return score;
}


// ---------------------------------------------------------------------------
// WARLOCK STANDARD-TIER WEIGHTS (2026-07-26). Both casts needed the negative
// floor this file has now learned three separate times (scoreBulwark's
// history note, scorePickpocket's below-cap bias, and now these): a cheap
// always-available cast with a small flat positive out-competes real board
// progress every turn. The first balance run without them: curse/g 26-87,
// sacrifice/g 14-95, warlock 76-89% off the whole field, mirror stalemating
// 45-49% of games at the 1000-turn cap.
// ---------------------------------------------------------------------------
/** Below this tile a cursed stone hasn't invested enough for the chains to
 *  be worth a mana — the row's gate, so only stones actually running the
 *  gauntlet are worth hexing. */
const MK_CURSE_MIN_TILE = 7;
/** Base value of a curse AT that tile — negative, so a hex on a stone that
 *  isn't a real runner loses to every plain move. */
const MK_CURSE_FLOOR = -90;
/** Per tile past MK_CURSE_MIN_TILE: the closer to escaping, the more a
 *  stolen tile per turn is worth. Crosses zero around tile 10. */
const MK_CURSE_PER_TILE = 30;
/** A Warded target is the standout buy — nothing else in the kit below the
 *  full-bank Sacrifice can touch it at all. */
const MK_CURSE_WARDED_BONUS = 90;
/** Sacrifice's base: a guaranteed pierce-kill is real, but it costs the
 *  full bank AND a body, and the bank no longer refunds itself (see
 *  applySacrifice's Blood Pact exclusion). Negative so the trade has to be
 *  justified by the target, not merely available. */
const MK_SACRIFICE_FLOOR = -120;
/** Per tile of the victim's progress — killing a deep runner is the point. */
const MK_SACRIFICE_PER_TILE = 34;
/** Per tile of progress on the stone GIVEN (always the MOST-advanced, see
 *  applySacrifice's doc for why that selection is load-bearing) — the real
 *  price, and the term that makes the cast self-limiting: it outweighs the
 *  victim's own per-tile value, so trading a deep runner for a shallow one
 *  always loses. Only a genuinely valuable target justifies the ritual. */
const MK_SACRIFICE_COST_PER_TILE = 40;
/** Nothing else in the kit reaches a Warded stone; a Blessed one would only
 *  be wounded by a mortal hit, paying the cleric's engine nothing. */
const MK_SACRIFICE_WARDED_BONUS = 140;
const MK_SACRIFICE_BLESSED_BONUS = 90;
/** Giving up the warlock's LAST on-board stone hands the foe a free board. */
const MK_SACRIFICE_LAST_STONE_PENALTY = 400;

/** Score Warlock's Curse of Chains — a TURN-KEEPING hex (Bless's
 *  contract), so like scoreBless this is "before the move", not "instead
 *  of it", and the discipline is about MANA rather than tempo. Value is
 *  the tempo the chains actually steal, which scales with how close the
 *  victim is to escaping: shackling a stone on tile 11 costs the foe far
 *  more than shackling one that just entered the row. A stone the warlock
 *  could plausibly kill instead is worth less to curse (the kill is
 *  strictly better), so the premium goes to the RUNNER the warlock can't
 *  reach — which is also the flavor. Below a real capture by
 *  construction, and it must stay there: Sacrifice and the plain move
 *  both want the same bank. STARTING VALUES, not yet sim-tuned. */
function scoreCurse(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  // NEGATIVE FLOOR, this file's thrice-learned discipline (see
  // scoreBulwark's history note and scorePickpocket's below-cap bias): a
  // cheap, always-available, turn-KEEPING cast with a small flat positive
  // fires every single turn and crowds out the race. The first balance run
  // proved it again here — curse/g hit 26-87 per game and the warlock took
  // 76-89% off the field, with the mirror stalemating half its games.
  // Only a genuine runner is worth the mana.
  const urgency = target.position - MK_CURSE_MIN_TILE;
  let score = MK_CURSE_FLOOR + MK_CURSE_PER_TILE * urgency;
  // A curse on a Warded stone is the standout buy: Ward makes it otherwise
  // untouchable to the warlock's whole kit EXCEPT Sacrifice's full-bank
  // pierce, so slowing it is the cheap answer the class does have.
  if (isWarded(state, power, target)) score += MK_CURSE_WARDED_BONUS;
  return score + rand() * 20;
}

/** Score Warlock's Sacrifice — the full-bank, turn-ending trade: the
 *  warlock's own LEAD RUNNER for a guaranteed kill through Ward and
 *  Blessing. Priced as a capture MINUS the real cost of the stone given,
 *  and that cost dominates by design (MK_SACRIFICE_COST_PER_TILE exceeds
 *  MK_SACRIFICE_PER_TILE): applySacrifice always spends the MOST-advanced
 *  on-board stone, so trading down is always a loss and the cast only
 *  clears the bar when the target is worth more than the runner given —
 *  which is what stopped it being an infinite attrition engine (see
 *  applySacrifice's doc for the before/after numbers). The premium cases
 *  are exactly the ones no other tool reaches: a Warded target (the whole
 *  reason the pierce exists) and a Blessed one (a normal hit would only
 *  wound it and pay the cleric's engine nothing). */
function scoreSacrifice(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const mover = state.currentPlayer;
  const target = state.tokens.find((t) => t.id === targetId)!;
  const mine = state.tokens.filter(
    (t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return -Infinity; // no blood to pay with (oracle already refuses, belt-and-braces)
  const cost = Math.max(...mine.map((t) => t.position));
  // The kill's worth, scaled by how far along the victim was — scoreMove's
  // own capture shape — minus the progress the ritual throws away.
  let score =
    MK_SACRIFICE_FLOOR + MK_SACRIFICE_PER_TILE * target.position - MK_SACRIFICE_COST_PER_TILE * cost;
  if (isWarded(state, power, target)) score += MK_SACRIFICE_WARDED_BONUS; // nothing else in the kit touches it
  if (isBlessed(power, targetId)) score += MK_SACRIFICE_BLESSED_BONUS; // a mortal hit would merely wound
  // Giving up the warlock's LAST on-board stone hands the foe a free board
  // — never worth a single kill.
  if (mine.length === 1) score -= MK_SACRIFICE_LAST_STONE_PENALTY;
  return score + rand() * 20;
}

/** Score Warlock's Fel Storm: spends only the banked ultimateReady flag
 *  (scoreUltimateStrike's "a banked ultimate that never fires is pure
 *  waste" reasoning), and its value IS its pool — every victim loses every
 *  tile it had earned past the row's gate. Scored as the total distance
 *  the storm actually undoes, so a storm catching one stone on tile 5
 *  correctly reads as near-worthless while one catching three deep runners
 *  outranks anything short of a win. Deliberately NOT flat like
 *  scoreExhume: unlike escaped tokens, contested stones are highly
 *  unequal. STARTING VALUES, not yet sim-tuned. */
function scoreFelStorm(state: GameState, victims: number[], rand: () => number): number {
  let dragged = 0;
  for (const id of victims) {
    const t = state.tokens.find((tok) => tok.id === id)!;
    dragged += Math.max(0, t.position - FEL_STORM_RETURN_POSITION);
  }
  return 120 + 55 * dragged + rand() * 20;
}

// ---------------------------------------------------------------------------
// HUNTER STANDARD-TIER WEIGHTS (2026-07-26). Same negative-floor discipline
// the warlock's two casts needed (and scoreBulwark and scorePickpocket
// before them) — Snare especially, being cheap, turn-keeping and always
// available, is the exact shape that reflexively out-competes real board
// progress every turn.
// ---------------------------------------------------------------------------
/** Snare's base value — negative, so a trap only beats a real move when
 *  the placement is actually good. */
const MK_SNARE_FLOOR = -70;
/** Per enemy stone that could REACH the trapped tile on its next flip
 *  (1-4 tiles behind it). A trap nobody can step on is worthless; a trap
 *  in front of the enemy's whole pack is the play. */
const MK_SNARE_PER_THREATENED = 85;
/** Bonus when the trap sits in front of a DEEP runner (the tile is far
 *  along the row), since throwing that stone back costs the foe most. */
const MK_SNARE_PER_TILE = 6;
/** Piercing Shot's base — the full bank for a guaranteed kill at range.
 *  POSITIVE, unlike every other full-bank floor in this file, and that is
 *  deliberate: the shot is only ever OFFERED when the arrow already has a
 *  clear line to an unprotected enemy (getPiercingShotTargets returns one
 *  id or nothing), so there is no "affordable but bad" case for a negative
 *  floor to suppress — the oracle does that job. Sized below a landing
 *  capture's own scoreMove value so a capture that ALSO advances a stone
 *  still wins; the shot is the answer when nothing can reach. */
const MK_PIERCING_SHOT_FLOOR = 240;
/** Per tile of the victim's progress — killing a deep runner is the point. */
const MK_PIERCING_SHOT_PER_TILE = 22;

/** Score Hunter's Snare — a TURN-KEEPING placement (Curse/Bless's
 *  contract), so this is "before the move", not "instead of it", and the
 *  discipline is about MANA. Value is entirely positional: a trap is worth
 *  what it is likely to CATCH, which means enemy stones within one flip
 *  (1-4 tiles) of the tile. Deliberately blind to the hunter's own stones —
 *  a trap never hurts its setter, so proximity to friendlies is irrelevant. */
function scoreSnare(state: GameState, power: PowerState, tile: number, rand: () => number): number {
  const mover = state.currentPlayer;
  const placement = (at: number): number => {
    let threatened = 0;
    for (const t of state.tokens) {
      if (effectiveOwner(power, t) === mover) continue;
      if (t.position < 0 || t.position >= PATH_LENGTH_PER_PLAYER) continue;
      const gap = at - t.position;
      if (gap >= 1 && gap <= 4) threatened++;
    }
    return MK_SNARE_PER_THREATENED * threatened + MK_SNARE_PER_TILE * at;
  };
  // RE-LAY DISCIPLINE (2026-09-16): with a trap already armed, a new
  // placement is worth only its IMPROVEMENT over the one in the ground —
  // the old absolute valuation re-laid the trap on ~30 turns a game (5
  // springs), one mana each, moving it a tile at a time. Measured against
  // the armed trap the floor does its job again.
  const armed = power.traps?.[mover] ?? null;
  const gain = armed === null ? placement(tile) : placement(tile) - placement(armed);
  return MK_SNARE_FLOOR + gain + rand() * 20;
}

/** Score Hunter's Piercing Shot — the full-bank, turn-ending kill at range.
 *  No target choice to weigh (the arrow's path decides), so this prices the
 *  one victim on offer. Discounted when a plain move could capture the same
 *  stone this turn: that capture advances a stone too, so spending the
 *  whole bank on the arrow instead would be strictly worse. */
function scorePiercingShot(
  state: GameState,
  moves: PowerMove[],
  targetId: number,
  rand: () => number,
): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = MK_PIERCING_SHOT_FLOOR + MK_PIERCING_SHOT_PER_TILE * target.position;
  const capturableNow = moves.some((m) => [...m.captures, ...m.bonusCaptures].includes(targetId));
  if (capturableNow) score -= MK_PIERCING_SHOT_FLOOR; // a move that kills it AND advances is better
  return score + rand() * 20;
}

/** Score Hunter's Wild Hunt: spends only the banked ultimateReady flag
 *  (scoreUltimateStrike's "a banked ultimate that never fires is pure
 *  waste"), and its value is a guaranteed kill PLUS a board-wide freeze.
 *  Scored as the strike's own baseline against the quarry the wolf will
 *  actually take (the least-advanced victim — see applyWildHunt), plus a
 *  per-head bonus for everything else it pins. */
function scoreWildHunt(state: GameState, pool: number[], rand: () => number): number {
  const victims = pool
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .sort((a, b) => a.position - b.position);
  const quarry = victims[0];
  if (!quarry) return -Infinity;
  return scoreUltimateStrike(state, quarry.id, rand) + 45 * (victims.length - 1);
}

// ---------------------------------------------------------------------------
// BARBARIAN STANDARD-TIER WEIGHTS (2026-07-27). Note the shape difference
// from the warlock/hunter blocks above: every barbarian cast is an actual
// CAPTURE, and every one is gated by an oracle that only offers it when a
// real victim is in reach — so none of them is the "cheap, always
// available, quietly worthless" pattern that needed negative floors. They
// are priced positive and compared against a capture instead.
// ---------------------------------------------------------------------------
/** Reckless Swing's base: a kill through Bulwark/Vanish for 1 mana, minus
 *  the recoil. Below a landing capture's own value because that capture
 *  also ADVANCES a stone, where this one throws yours backwards. */
const MK_RECKLESS_FLOOR = 150;
/** Per tile of the victim's progress — killing a deep runner is the point. */
const MK_RECKLESS_PER_TILE = 26;
/** Per tile the swinger is thrown back: the actual cost of the trade, and
 *  the term that stops the bot swinging with a stone it cannot afford to
 *  lose ground with. */
const MK_RECKLESS_RECOIL_PER_TILE = 18;
/** Recoiling all the way home is a whole stone's progress gone — priced as
 *  its own event rather than extrapolating the per-tile term. */
const MK_RECKLESS_SELF_HOME_PENALTY = 260;
/** The premium case: nothing else the barbarian owns can touch a Bulwarked
 *  or Vanished stone, so those are exactly what this is for. */
const MK_RECKLESS_PIERCE_BONUS = 120;
/** Whirlwind's base — the full bank for a capture plus scatter. */
const MK_WHIRLWIND_FLOOR = 120;
/** Per stone the spin actually catches (captured or shoved). */
const MK_WHIRLWIND_PER_VICTIM = 95;

/** Score Barbarian's Reckless Swing — a kill that costs position. The two
 *  halves are priced explicitly against each other so the bot takes the
 *  trade when the target is worth more than the ground, and declines when
 *  it isn't (notably: swinging with a deep runner to kill a shallow stone
 *  is a losing trade, and the recoil term says so). */
function scoreRecklessSwing(
  state: GameState,
  power: PowerState,
  targetId: number,
  rand: () => number,
): number {
  const mover = state.currentPlayer;
  const victim = state.tokens.find((t) => t.id === targetId)!;
  const swinger = state.tokens.find(
    (t) => effectiveOwner(power, t) === mover && t.position === victim.position - 1,
  );
  if (!swinger) return -Infinity; // oracle already refuses; belt-and-braces
  let score = MK_RECKLESS_FLOOR + MK_RECKLESS_PER_TILE * victim.position;
  score -= MK_RECKLESS_RECOIL_PER_TILE * Math.min(swinger.position, RECKLESS_SELF_KNOCKBACK);
  if (swinger.position - RECKLESS_SELF_KNOCKBACK < 0) score -= MK_RECKLESS_SELF_HOME_PENALTY;
  if (isBulwarked(power, victim)) score += MK_RECKLESS_PIERCE_BONUS; // the one tool that reaches it
  return score + rand() * 20;
}

/** Score Barbarian's Whirlwind: the full-bank spin, valued by its whole
 *  catch — the capture plus every stone it shoves off its line. */
function scoreWhirlwind(victims: number[], rand: () => number): number {
  return MK_WHIRLWIND_FLOOR + MK_WHIRLWIND_PER_VICTIM * victims.length + rand() * 20;
}

/** Score Barbarian's Bloodbath: spends only the banked ultimateReady flag
 *  (scoreUltimateStrike's "never sit on it"), and its value is the whole
 *  uncapped path — every stone the charge runs down, weighted by how far
 *  each had come. */
function scoreBloodbath(state: GameState, victims: number[], rand: () => number): number {
  let worth = 0;
  for (const id of victims) worth += 60 + 12 * (state.tokens.find((t) => t.id === id)?.position ?? 0);
  return 200 + worth + rand() * 20;
}

// ---------------------------------------------------------------------------
// BARD STANDARD-TIER WEIGHTS (2026-07-27). Inspire is the file's canonical
// danger shape — cheap, turn-KEEPING, always available — so it gets the
// negative floor the warlock's Curse and the hunter's Snare needed before
// it. The difference is that a lit stone's value is REAL and immediate
// (every future move it makes is longer), so the floor is shallower and the
// per-tile term steeper: the bot should light a runner eagerly and a stone
// sitting at home almost never.
// ---------------------------------------------------------------------------
/** Inspire's base — negative, so lighting a stone that isn't going anywhere
 *  loses to a real move. */
const MK_INSPIRE_FLOOR = -60;
/** Per tile of the stone's progress: the further along it is, the more each
 *  extra tile per move is worth, and the sooner it converts to an escape. */
const MK_INSPIRE_PER_TILE = 26;
/** Song of Haste's base, plus its per-marcher term — the payoff scales with
 *  how wide the board was lit, which is the whole reason to spread. */
const MK_HASTE_FLOOR = -40;
const MK_HASTE_PER_STONE = 130;
/** Crescendo: army-wide light AND march. Valued per stone it touches, the
 *  way scoreBenediction values its own pool. */
const MK_CRESCENDO_PER_STONE = 150;

/** Score Bard's Inspire — a TURN-KEEPING buff (Bless/Curse's contract), so
 *  this is "before the move", not "instead of it", and the discipline is
 *  about MANA. Value tracks the stone's progress, and dips when it is
 *  already lit-adjacent to nothing useful. */
function scoreInspire(state: GameState, targetId: number, rand: () => number): number {
  const t = state.tokens.find((tok) => tok.id === targetId)!;
  return MK_INSPIRE_FLOOR + MK_INSPIRE_PER_TILE * t.position + rand() * 20;
}

/** Score Bard's Song of Haste: the full-bank payoff, worth what it actually
 *  marches. A one-stone song is a poor use of the whole bank; a four-stone
 *  one is the class working as designed. */
function scoreSongOfHaste(pool: number[], rand: () => number): number {
  return MK_HASTE_FLOOR + MK_HASTE_PER_STONE * pool.length + rand() * 20;
}

/** Score Bard's Crescendo: spends only the banked ultimateReady flag
 *  (scoreUltimateStrike's "never sit on it"), valued by the army it lights
 *  and moves at once. */
function scoreCrescendo(pool: number[], rand: () => number): number {
  return MK_CRESCENDO_PER_STONE * pool.length + rand() * 20;
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

  if (cls === "archer" && charges >= CHARGED_SHOT_COST) {
    for (const targetId of getChargedShotTargets(state, power, mover)) {
      const score = scoreChargedShot(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "chargedShot", targetTokenId: targetId };
      }
    }
  }

  if (cls === "mage") {
    for (const tile of getBlinkTiles(state, power, mover)) {
      const score = scoreBlink(state, power, moves, tile, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "blink", tile };
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

  if (cls === "archer" && power.ultimateReady[mover]) {
    // Banked Rain of Arrows (2026-09-16): a guaranteed through-everything
    // kill — scoreUltimateStrike's "never sit on it" temperament, same as
    // Blink Strike's.
    for (const targetId of getRainOfArrowsTargets(state, power, mover)) {
      const score = scoreUltimateStrike(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "rainOfArrows", targetTokenId: targetId };
      }
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
    // Reinforced Bulwark retired 2026-09-13 (BULWARK_REINFORCED_RETIRED).
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
    // Vanish IS Bulwark's mechanic under a Rogue cast (see VANISH_COST's
    // doc in master-killer.ts), so scoreVanish keeps scoreBulwark's exact
    // threat-gated, negative-floor discipline (that function's history note
    // records a real balance bug from an under-penalized "always evaluable"
    // defensive cast — archer-vs-warrior swung to ~80/20 before the floor
    // fixed it; Vanish has the identical always-available shape). It does not
    // get a Push-threat premium despite being Push-immune — see scoreVanish's
    // own doc for the simulation that rejected that idea.
    if (charges >= VANISH_COST) {
      for (const targetId of getVanishTargets(state, power, mover)) {
        const score = scoreVanish(state, targetId, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "vanish", tokenId: targetId };
        }
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

  if (cls === "warlock") {
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const targetId of getCurseTargets(state, power, mover)) {
      const score = scoreCurse(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "curse", targetTokenId: targetId };
      }
    }
    for (const targetId of getSacrificeTargets(state, power, mover)) {
      const score = scoreSacrifice(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "sacrifice", targetTokenId: targetId };
      }
    }
    if (power.ultimateReady[mover]) {
      const victims = getFelStormTargets(state, power, mover);
      if (victims.length > 0) {
        const score = scoreFelStorm(state, victims, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "felStorm" };
        }
      }
    }
  }

  if (cls === "hunter") {
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const tile of getSnareTiles(state, power, mover)) {
      const score = scoreSnare(state, power, tile, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "snare", tile };
      }
    }
    for (const targetId of getPiercingShotTargets(state, power, mover)) {
      const score = scorePiercingShot(state, moves, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "piercingShot" };
      }
    }
    if (power.ultimateReady[mover]) {
      const pool = getWildHuntTargets(state, power, mover);
      if (pool.length > 0) {
        const score = scoreWildHunt(state, pool, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "wildHunt" };
        }
      }
    }
  }

  if (cls === "barbarian") {
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const targetId of getRecklessSwingTargets(state, power, mover)) {
      const score = scoreRecklessSwing(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "recklessSwing", targetTokenId: targetId };
      }
    }
    const spin = getWhirlwindTargets(state, power, mover);
    if (spin.length > 0) {
      const score = scoreWhirlwind(spin, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "whirlwind" };
      }
    }
    if (power.ultimateReady[mover]) {
      const path = getBloodbathTargets(state, power, mover);
      if (path.length > 0) {
        const score = scoreBloodbath(state, path, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "bloodbath" };
        }
      }
    }
  }

  if (cls === "bard") {
    // The oracles are the whole gate (affordability baked in) — mirror
    // validateUsePower exactly, same as every class above.
    for (const targetId of getInspireTargets(state, power, mover)) {
      const score = scoreInspire(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "inspire", targetTokenId: targetId };
      }
    }
    const song = getSongOfHasteTargets(state, power, mover);
    if (song.length > 0) {
      const score = scoreSongOfHaste(song, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "songOfHaste" };
      }
    }
    if (power.ultimateReady[mover]) {
      const army = getCrescendoTargets(state, power, mover);
      if (army.length > 0) {
        const score = scoreCrescendo(army, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "crescendo" };
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
  if (cls === "archer" && charges >= CHARGED_SHOT_COST) {
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
  if (cls === "archer" && power.ultimateReady[mover]) {
    for (const id of getRainOfArrowsTargets(state, power, mover)) {
      out.push({ kind: "rainOfArrows", targetTokenId: id });
    }
  }
  if (cls === "warrior" && power.ultimateReady[mover]) {
    for (const id of getWarpathTargets(state, power, mover)) out.push({ kind: "warpath", targetTokenId: id });
  }
  if (cls === "warrior" && charges >= 1) {
    const bulwarkTargets = getBulwarkTargets(state, power, mover);
    for (const id of bulwarkTargets) out.push({ kind: "bulwark", tokenId: id });
    // Reinforced Bulwark retired 2026-09-13 (BULWARK_REINFORCED_RETIRED).
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
  }
  if (cls === "mage") {
    for (const tile of getBlinkTiles(state, power, mover)) out.push({ kind: "blink", tile });
    if (charges >= VANISH_COST) {
      for (const id of getVanishTargets(state, power, mover)) out.push({ kind: "vanish", tokenId: id });
    }
    if (power.ultimateReady[mover]) {
      for (const id of getGrandHeistTargets(state, power, mover)) out.push({ kind: "grandHeist", targetTokenId: id });
    }
  }
  if (cls === "warlock") {
    for (const id of getCurseTargets(state, power, mover)) out.push({ kind: "curse", targetTokenId: id });
    for (const id of getSacrificeTargets(state, power, mover)) out.push({ kind: "sacrifice", targetTokenId: id });
    // One candidate, no payload — the whole row is the target.
    if (power.ultimateReady[mover] && getFelStormTargets(state, power, mover).length > 0) {
      out.push({ kind: "felStorm" });
    }
  }
  if (cls === "hunter") {
    for (const tile of getSnareTiles(state, power, mover)) out.push({ kind: "snare", tile });
    // One candidate, no payload — the arrow's path picks the victim.
    if (getPiercingShotTargets(state, power, mover).length > 0) out.push({ kind: "piercingShot" });
    if (power.ultimateReady[mover] && getWildHuntTargets(state, power, mover).length > 0) {
      out.push({ kind: "wildHunt" });
    }
  }
  if (cls === "barbarian") {
    for (const id of getRecklessSwingTargets(state, power, mover)) {
      out.push({ kind: "recklessSwing", targetTokenId: id });
    }
    if (getWhirlwindTargets(state, power, mover).length > 0) out.push({ kind: "whirlwind" });
    if (power.ultimateReady[mover] && getBloodbathTargets(state, power, mover).length > 0) {
      out.push({ kind: "bloodbath" });
    }
  }
  if (cls === "bard") {
    for (const id of getInspireTargets(state, power, mover)) out.push({ kind: "inspire", targetTokenId: id });
    if (getSongOfHasteTargets(state, power, mover).length > 0) out.push({ kind: "songOfHaste" });
    if (power.ultimateReady[mover] && getCrescendoTargets(state, power, mover).length > 0) {
      out.push({ kind: "crescendo" });
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
/** An open grave (2026-09-16, outlives the raise — see PowerState.grave):
 *  a 2-mana mine that fires under whoever stops beside it. Cheaper option
 *  value than the corpse — it needs a victim to wander into radius and the
 *  bank to hold 2 — and nothing the foe can disarm except by keeping clear. */
const MK_EVAL_GRAVE = 8;
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
/** Warlock (2026-07-26): a live Curse of Chains on an own on-board stone,
 *  at full duration. CURSE_SLOW tiles stolen from every move that stone
 *  makes for CURSE_TURNS — priced above MK_EVAL_BULWARK's insurance (this
 *  is realized tempo loss, not a contingency) but below a blessing's
 *  outright denied kill. Decays with the remaining turns, so hard sees the
 *  chains loosening. */
const MK_EVAL_CURSED = 16;
/** Hunter (2026-07-26): a live freeze on an own on-board stone, at full
 *  duration. Strictly worse than a curse — no progress at all rather than
 *  reduced progress — and it cost the caster their full bank, so it is
 *  priced well above MK_EVAL_CURSED. Decays with remaining turns. */
const MK_EVAL_HAMSTRUNG = 34;
/** Barbarian (2026-07-27): each tile of Rage the position currently grants.
 *  Priced ABOVE a live blessing: a permanent-while-behind stride bonus on
 *  the stone that most needs it compounds over every remaining turn, where
 *  a blessing is one denied kill. Not so high that the eval starts throwing
 *  stones away to farm it — the per-tile and threat terms it would give up
 *  to do that are far larger. */
const MK_EVAL_RAGE = 26;
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
    // Curse of Chains on one of MY stones is a real, ongoing tax — this is
    // the term that lets hard's one-ply search see the hex at all (its
    // payoff otherwise lands entirely past the horizon; see mkCurseValue).
    // Scaled by turns remaining, the thrall's own decay shape.
    if (isCursed(power, t.id)) {
      const turnsLeft = power.curse.p1?.tokenId === t.id
        ? power.curse.p1.turnsLeft
        : (power.curse.p2?.turnsLeft ?? 0);
      score -= (MK_EVAL_CURSED * turnsLeft) / CURSE_TURNS;
    }
    // A FROZEN stone of mine is strictly worse than a cursed one — it
    // makes no progress at all rather than reduced progress — so the
    // penalty is heavier, on the same decaying scale.
    if (isHamstrung(power, t.id)) {
      score -= (MK_EVAL_HAMSTRUNG * (power.hamstrung?.[t.id] ?? 0)) / WILD_HUNT_FREEZE_TURNS;
    }
  }
  // A valid banked corpse is a Revive waiting on funding.
  const corpse = power.corpse[player];
  if (corpse && state.tokens.find((t) => t.id === corpse.tokenId)?.position === -1) {
    score += MK_EVAL_CORPSE;
  }
  // An open grave is a mine waiting for a passer-by (and for 2 mana).
  if (power.grave[player] !== null) score += MK_EVAL_GRAVE;
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
  // Barbarian's Rage: the tiles-per-move the CURRENT position is granting.
  // Without this term the expectimax tier is blind to the whole class —
  // it prices losing a stone purely as loss, never seeing that a barbarian
  // behind on stones moves faster for it, so it plays the kit like a
  // fragile archer. Caught by the separation gate: the hard tier was
  // LOSING its own mirror to standard (46.0%), an inversion no amount of
  // sampling noise explains.
  score += MK_EVAL_RAGE * rageFor(state, power, player);
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

/** Value of Curse of Chains: a turn-keeping hex (applyCurse's contract —
 *  the SAME flip stays live), mkPickpocketValue's exact shape. Note the
 *  one-ply search can only see the mana spent and this turn's follow-up —
 *  the chains' actual payoff lands on the VICTIM's next turns, which is
 *  beyond the horizon. That undervaluation is deliberate and left alone:
 *  the alternative is a hand-tuned bias constant (MK_EVAL_REVIVE_BIAS's
 *  shape) and this file's history is emphatic that a flat positive on an
 *  always-available cast out-competes real captures every turn. Hard will
 *  therefore curse only when the board is otherwise quiet — a conservative
 *  failure mode, and the standard tier's scoreCurse carries the class. */
function mkCurseValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "curse" }>,
  flip: number,
  me: PlayerId,
): number {
  const nextPower = applyCurse(power, c.targetTokenId, me);
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

/** Value of Snare: a turn-keeping placement (applySnare's contract),
 *  mkCurseValue's exact shape — and it inherits the same horizon problem,
 *  more acutely: a trap's whole payoff lands on a LATER enemy turn, which
 *  one ply cannot see at all. Left deliberately un-biased for the reason
 *  mkCurseValue documents (a flat positive on an always-available cast is
 *  this file's most-repeated bug), so hard sets traps only when the board
 *  is otherwise quiet and the standard tier's scoreSnare carries the
 *  class's trap game. */
function mkSnareValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "snare" }>,
  flip: number,
  me: PlayerId,
): number {
  const nextPower = applySnare(power, c.tile, me);
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

/** Value of Inspire: a turn-keeping buff (applyInspire's contract),
 *  mkCurseValue/mkSnareValue's exact shape — and unlike those two it is NOT
 *  horizon-blind: the lit stone moves INSPIRE_BONUS further on this very
 *  flip, so the same-flip follow-up search sees the buff's value directly.
 *  That is why the bard needs no eval-side bias constant where the warlock
 *  and hunter's turn-keepers were left deliberately undervalued. */
function mkInspireValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "inspire" }>,
  flip: number,
  me: PlayerId,
): number {
  const nextPower = applyInspire(power, c.targetTokenId, me);
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
    case "rainOfArrows":
      return applyRainOfArrows(state, power, c.targetTokenId, mover);
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
    case "vanish":
      return applyVanish(state, power, c.tokenId, mover);
    case "grandHeist":
      return applyGrandHeist(state, power, c.targetTokenId, mover);
    case "pickpocket":
      // Never actually reached in practice (pickHardPowerAction intercepts
      // "pickpocket" early via mkPickpocketValue, same as "bless"'s own
      // early intercept above) — kept for switch exhaustiveness, same
      // defensive completeness "bless" already has here.
      return { state, power: applyPickpocket(power, mover) };
    case "sacrifice":
      return applySacrifice(state, power, c.targetTokenId, mover);
    case "backstab":
      return applyBackstab(state, power, c.targetTokenId, mover);
    case "blink":
      return applyBlink(state, power, c.tile, mover);
    case "felStorm":
      return applyFelStorm(state, power, mover);
    case "curse":
      // Same story as "pickpocket"/"bless": intercepted early by
      // mkCurseValue since it keeps the turn. Kept for exhaustiveness.
      return { state, power: applyCurse(power, c.targetTokenId, mover) };
    case "piercingShot":
      return applyPiercingShot(state, power, mover);
    case "wildHunt":
      return applyWildHunt(state, power, mover);
    case "snare":
      // Turn-keeping — intercepted early by mkSnareValue, same as curse.
      return { state, power: applySnare(power, c.tile, mover) };
    case "recklessSwing":
      return applyRecklessSwing(state, power, c.targetTokenId, mover);
    case "whirlwind":
      return applyWhirlwind(state, power, mover);
    case "bloodbath":
      return applyBloodbath(state, power, mover);
    case "songOfHaste":
      return applySongOfHaste(state, power, mover);
    case "crescendo":
      return applyCrescendo(state, power, mover);
    case "inspire":
      // Turn-keeping — intercepted early by mkInspireValue, same as curse
      // and snare. Kept for switch exhaustiveness.
      return { state, power: applyInspire(power, c.targetTokenId, mover) };
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
    } else if (c.kind === "curse") {
      // Turn-keeping, same-flip follow-up valuation — see mkCurseValue.
      value = mkCurseValue(state, power, c, flip, mover);
    } else if (c.kind === "snare") {
      // Turn-keeping, same-flip follow-up valuation — see mkSnareValue.
      value = mkSnareValue(state, power, c, flip, mover);
    } else if (c.kind === "inspire") {
      // Turn-keeping, same-flip follow-up valuation — see mkInspireValue.
      value = mkInspireValue(state, power, c, flip, mover);
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
