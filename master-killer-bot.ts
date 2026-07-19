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
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyExhume,
  applyPowerMove,
  applyPush,
  applyRaiseDead,
  applyReflip,
  applyWarpath,
  canReflipAgain,
  CHARGE_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  DARK_RESURRECTION_POSITION,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getExhumeTargets,
  getLegalPowerMoves,
  getPushTargets,
  getRaiseTargets,
  getWarpathTargets,
  isBulwarked,
  isWarded,
  PUSH_DISTANCE,
  PUSH_WARD_DISTANCE,
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
 *  necromancer — the race-the-racer lever, and the single biggest win of
 *  the second pass. Soul Harvest refunds a necromancer's deaths, so its
 *  tokens should sprint where other classes tiptoe. Swept 3/6/10/15/25/40
 *  vs mage: 69.0/69.1/67.3/68.8/69.4/74.3 — a clear peak at 10 (about a
 *  +140 swing on a far-side move, comparable to the flee bonus), after
 *  which racing starts out-competing captures themselves and everything
 *  regresses. */
const MK_STD_NECRO_RACE_SCALE = 10;
/** Scale on scoreMove's capture bonus for a necromancer. A capture is
 *  worth more to this class than the shared 400-base admits: +1 charge
 *  (half a Dark Resurrection), a tile of denied enemy progress, and — in
 *  the mage matchup specifically — the only interaction the class has
 *  with the opponent at all (the warded leader being untouchable makes
 *  killing the escorts the entire fight). Swept 0.7/1.3/1.6/2.0 on the
 *  race+shield stack: 68.0/66.3/65.9/66.6 vs mage — kept 1.6. */
const MK_STD_NECRO_CAPTURE_SCALE = 1.6;
/** Third-pass lever: flat score for a PLAIN Raise Dead cast while
 *  CAP-BLOCKED — bank at CHARGE_CAP, a reserve body waiting, but the Dark
 *  Resurrection slot squatted by an own token — and no legal move can
 *  vacate the squatter this flip. (When one can, the companion bonus below
 *  is the cheaper fix and this stands down: raising first would squat
 *  RAISE_POSITION too and re-lock the bank a turn later — the ungated
 *  pairing measured ~1pt worse on both the mage and archer matchups.) A
 *  Raise never ends the turn, so firing this costs no tempo; the spent
 *  charge was dead weight anyway — at cap every incoming soul clamps to
 *  nothing, so spending 1 to reopen absorption is income, not expense.
 *  800 outranks every quiet move and most captures, which is correct for
 *  a tempo-free act (the act-then-redecide loop still plays the move
 *  after); swept 500/800/1200 at 20000 games: 64.6/63.7/64.5 vs mage —
 *  kept 800. 0 disables (need-gated scoring as before). */
const MK_STD_NECRO_CAP_UNBLOCK_RAISE = 800;
/** The companion third-pass lever: bonus on a move whose `from` is
 *  DARK_RESURRECTION_POSITION while cap-blocked — the unblock move itself.
 *  Vacating the slot converts the held bank into a body next turn without
 *  spending anything today; the two levers split the cap-blocked state
 *  between them (move the squatter when the flip allows, plain-raise when
 *  it doesn't). Solo it already carried most of the effect (64.4/63.5
 *  mage/archer at 20000 games); swept 120/200/300 on the gated pair:
 *  64.2/63.7/64.4 vs mage with vs-archer 63.8/63.0/64.1 — 200 best on
 *  both axes. 0 disables. */
const MK_STD_NECRO_UNBLOCK_MOVE = 200;

/** Same shape of scoring bot.ts uses for a plain move, extended with the
 *  power-derived capture sets (bonus snipe / charge sweep) so a Master
 *  Killer move that happens to snipe or sweep scores appropriately higher
 *  than an equivalent classic move would. The three trailing weights are
 *  the necromancer levers above; their defaults are exact no-ops, so a
 *  call that doesn't pass them (every non-necromancer call site) scores
 *  byte-identically to the pre-necromancer formula, same rand() draws and
 *  all. */
function scoreMove(
  state: GameState,
  m: PowerMove,
  extraCaptures: number[],
  rand: () => number,
  shieldExtra = 0,
  raceScale = 1,
  captureScale = 1,
): number {
  let score = 0;
  const allCaptures = [...m.captures, ...m.bonusCaptures, ...extraCaptures];

  if (m.causesWin) score += 1000;
  if (allCaptures.length > 0) {
    const victimProgress = Math.max(
      ...allCaptures.map((id) => state.tokens.find((t) => t.id === id)?.position ?? 0),
    );
    // Each additional capture in the same move (Snipe/Charge stacking) is
    // worth a real but diminishing bonus — multi-capture moves should win
    // ties against single captures without becoming a blowout auto-pick.
    score += (400 + victimProgress * 10 + (allCaptures.length - 1) * 150) * captureScale;
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

/** Score Necromancer's Raise Dead / Dark Resurrection: a body back from the
 *  graveyard. Dark Resurrection fires ON SIGHT (a base far above any
 *  non-winning move score bar a top-end 1.6x-scaled capture — see the
 *  second-pass note below); the plain cast stays need-gated as desperation
 *  recovery. This is DELIBERATELY the opposite of the discipline
 *  scoreChargedShot/scoreReinforcedBulwark apply to their own full-bank
 *  spends, and the first-pass balance sim is why — the "always evaluable
 *  trap" reasoning (see scoreBulwark's history note) does not transfer to
 *  this class, for two structural reasons the other spends don't share:
 *  a Raise never ends the turn, so out-scoring a move never FORGOES that
 *  move (the act-then-redecide loop still plays it on the same flip — the
 *  only real cost is the charge); and a necromancer's banked charge has no
 *  alternative use and no at-cap passive (no Ward analogue), so a held
 *  bank is dead weight that also wastes every Soul Harvest charge arriving
 *  over CHARGE_CAP.
 *  (First balance pass, 5000 games/matchup. Need-gating BOTH variants —
 *  this function's original shape — had the necromancer losing every
 *  non-mirror matchup: 59.4/40.6 vs archer, 76.9/23.1 vs mage, 54.9/45.1
 *  vs warrior. Fire-on-sight for both variants: 46.4/53.6, 69.3/30.7,
 *  45.6/54.4. Preferring PLAIN over dark instead regressed everything —
 *  55.0/45.0, 74.7/25.3, 53.4/46.6 — proving Dark Resurrection's 3 tiles
 *  are worth the second charge. SHIPPED: dark on sight, plain need-gated —
 *  47.5/52.5 vs archer, 68.8/31.2 vs mage, 45.6/54.4 vs warrior, mirror
 *  49.9/50.1. The mage number is this policy's CEILING, not a tuning
 *  miss: raise volume is income-bound (the necromancer already spends
 *  every charge it banks against a mage), and the class has no Ward
 *  interaction of any kind, so the remaining distance to parity there is
 *  a rules-design problem — the same structural hole archer-vs-mage's own
 *  ship-now-reopen-later thread documents — not a bot-weights one.)
 *  (Second balance pass: the dark base moved 700 -> 900, a knock-on of
 *  MK_STD_NECRO_CAPTURE_SCALE. At 1.6x a good capture scores up to ~880,
 *  quietly out-ranking a 700 dark raise — and since a Raise is tempo-free,
 *  "capture out-scores raise" doesn't choose the capture INSTEAD, it just
 *  DEFERS the raise a turn while at-cap Soul Harvest income overflows into
 *  nothing. 900 restores raise-first ordering under the new capture prices
 *  (5000-game probe on the final stack: 65.9 vs mage at 700, 64.7 at 900)
 *  while staying under any causesWin move's 1000-plus. 1100 — above every
 *  non-winning move outright — over-rotated to 67.4 and was reverted:
 *  when a capture genuinely dwarfs the raise, taking the capture first
 *  and raising next turn is sometimes right after all. Plain-cast need
 *  scoring below is unchanged through all of this.)
 *  (Third balance pass: the need scoring below still stands, but a
 *  CAP-BLOCKED plain cast now bypasses it entirely at the call site — see
 *  MK_STD_NECRO_CAP_UNBLOCK_RAISE. The "income-bound" ceiling the first
 *  pass measured was partly self-inflicted cap overflow, and unblocking
 *  it moved the mage matchup from ~66.0 to ~64.2 — inside the bar.)
 *
 *  Plain-cast need scoring: raising when nearly wiped (0-1 own tokens on
 *  board) is a near-capture-sized swing, a healthy board (3 on) prices it
 *  firmly negative, a live enemy board majority nudges it up, and a
 *  deeper graveyard nudges it up too — spending one of three bodies is
 *  cheaper, insurance-wise, than spending the only one. */
function scoreRaiseDead(state: GameState, dark: boolean, rand: () => number): number {
  const mover = state.currentPlayer;
  let onBoard = 0;
  let foeOnBoard = 0;
  let reserve = 0;
  for (const t of state.tokens) {
    if (t.owner === mover && t.position === -1) reserve++;
    if (t.position < 0 || t.position >= PATH_LENGTH_PER_PLAYER) continue;
    if (t.owner === mover) onBoard++;
    else foeOnBoard++;
  }
  let score: number;
  if (dark) {
    score = 900 + 20 * Math.max(0, foeOnBoard - onBoard) + 12 * (reserve - 1);
  } else {
    score = 60 + 90 * (1 - onBoard) + 20 * Math.max(0, foeOnBoard - onBoard) + 12 * (reserve - 1);
  }
  score += rand() * 20;
  return score;
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
  // Cap-blocked (see MK_STD_NECRO_CAP_UNBLOCK_RAISE): the bank is full, a
  // reserve body exists, but the Dark Resurrection slot is squatted by an
  // own token — every incoming soul is overflowing into the cap clamp.
  // Pure getters, no rand() consumed — non-necromancer streams untouched.
  const darkRaiseTargets =
    necro && charges === CHARGE_CAP ? getRaiseTargets(state, power, mover, true) : [];
  const capBlocked =
    necro &&
    charges === CHARGE_CAP &&
    darkRaiseTargets.length === 0 &&
    state.tokens.some((t) => t.owner === mover && t.position === -1);

  for (const m of moves) {
    let score = scoreMove(state, m, [], rand, shieldExtra, raceScale, captureScale);
    if (capBlocked && MK_STD_NECRO_UNBLOCK_MOVE > 0 && m.from === DARK_RESURRECTION_POSITION) {
      score += MK_STD_NECRO_UNBLOCK_MOVE;
    }
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
      const chargeScore = scoreMove(state, m, m.chargeSweepCaptures, rand) + 20; // small "use the cool ability" nudge
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

  if (cls === "necromancer" && charges >= 1) {
    // One score per Raise variant, not per reserve token — all reserve
    // tokens are interchangeable (see getRaiseTargets), so the first id
    // stands for the whole pool. The two variants have different target
    // pools (different destination tiles can be blocked independently), so
    // each checks its own.
    const raiseTargets = getRaiseTargets(state, power, mover);
    if (raiseTargets.length > 0) {
      // Cap-blocked: the plain cast is a tempo-free absorption reopener —
      // see MK_STD_NECRO_CAP_UNBLOCK_RAISE. Only when the squatter can't
      // move THIS flip (otherwise the unblock-move bonus handles it without
      // spending the half-a-dark charge, and without double-squatting tiles
      // 0 and 3). Otherwise need-gated as ever.
      const score =
        capBlocked &&
        MK_STD_NECRO_CAP_UNBLOCK_RAISE > 0 &&
        !moves.some((m) => m.from === DARK_RESURRECTION_POSITION)
          ? MK_STD_NECRO_CAP_UNBLOCK_RAISE + rand() * 20
          : scoreRaiseDead(state, false, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "raiseDead", tokenId: raiseTargets[0] };
      }
    }
    if (darkRaiseTargets.length > 0) {
      const score = scoreRaiseDead(state, true, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "raiseDead", tokenId: darkRaiseTargets[0], dark: true };
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
  if (cls === "necromancer" && charges >= 1) {
    // ONE candidate per Raise variant, not one per reserve token: the pool
    // is interchangeable (see getRaiseTargets), so extra candidates would
    // add nothing for hard and only skew easy's uniform pick toward
    // raising. Each variant checks its own pool — the two destination
    // tiles block independently.
    const raiseTargets = getRaiseTargets(state, power, mover);
    if (raiseTargets.length > 0) out.push({ kind: "raiseDead", tokenId: raiseTargets[0] });
    if (charges === CHARGE_CAP) {
      const darkTargets = getRaiseTargets(state, power, mover, true);
      if (darkTargets.length > 0) out.push({ kind: "raiseDead", tokenId: darkTargets[0], dark: true });
    }
  }
  if (cls === "necromancer" && power.ultimateReady[mover]) {
    // Same one-candidate collapse: every escaped token is equally escaped.
    const exhumeTargets = getExhumeTargets(state, power, mover);
    if (exhumeTargets.length > 0) out.push({ kind: "exhume", targetTokenId: exhumeTargets[0] });
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
/** A necromancer's reserve token is half-alive — one banked charge from
 *  re-entering play via Raise Dead — so it keeps a slice of value instead
 *  of the flat zero every other class's reserve is worth. Half a tile's
 *  worth (was 16 — "two tiles" — before the necromancer-mirror separation
 *  tuning): the bigger credit made the hard tier read a Dark Resurrection
 *  as swapping 16 points of graveyard for 24 of board — near-neutral, so
 *  the search raised on a jitter coin-flip while standard raised on
 *  sight. Cutting it is one piece of a single coherent story (see
 *  MK_EVAL_NECRO_CHARGE's sweep): for this class, bodies BANKED are worth
 *  almost nothing next to bodies RACING. Still nonzero so the eval keeps
 *  correctly cheapening enemy captures AGAINST a necromancer. */
const MK_EVAL_NECRO_RESERVE = 4;
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
/** Holdback on a PLAIN Raise Dead candidate in the hard tier's root — the
 *  option value of banking that charge toward a Dark Resurrection instead,
 *  which the one-ply search structurally cannot see (the dark cast only
 *  exists once the bank hits CHARGE_CAP, a future turn away). Without it,
 *  hard fired a plain raise the moment the bank hit 1 (probe: 4.44 plain /
 *  1.13 dark per game) while standard's need-gated plain banked toward
 *  dark (1.39 / 3.52) — the exact plain-heavy mix a standard-vs-standard
 *  sweep already measured as 3-6 points worse (see scoreRaiseDead's
 *  first-pass trace), and hard lost the necromancer mirror 33.8/66.2 to
 *  standard because of it. Applied only when `dark` is false, at the root
 *  in pickHardPowerAction; a desperate board still plain-raises — the
 *  follow-up mobility of the recovered body overcomes the holdback. */
const MK_EVAL_PLAIN_RAISE_HOLDBACK = 40;
/** The companion bias, positive, on a DARK Raise candidate at the hard
 *  tier's root: a necromancer at CHARGE_CAP wastes every further Soul
 *  Harvest / capture / zero-flip charge to addCharge's at-cap no-op, so
 *  spending the full bank REOPENS income absorption — a real, recurring
 *  gain the static eval can't express (it prices the bank it can see, not
 *  the income the cap is about to discard). Ablated at
 *  MK_EVAL_NECRO_THREAT_SCALE=0.15 in the 600-game mirror probe: 47.0%
 *  hard-vs-standard without it, 51.3% with (dark casts 3.88/g vs 4.41/g)
 *  — kept at 30. */
const MK_EVAL_DARK_RAISE_BIAS = 30;
/** Scale on the capture-threat penalty for NECROMANCER-owned tokens: a
 *  necro death is heavily refunded (a Soul Harvest charge to the victim,
 *  plus the body stays raisable — see MK_EVAL_NECRO_RESERVE), so full-price
 *  threat aversion makes the hard tier cowardly with exactly the class
 *  whose identity is "deaths feed me": it hugged the private lane, died
 *  less, starved its own soul income, and lost the self-funding
 *  raise-die-harvest loop standard's bolder play rides (probe: hard spent
 *  5.4 charges/game to standard's 8.7 in the mirror). Swept in the
 *  600-game mirror probe with everything else fixed: 0.5 -> 42.8%
 *  hard-vs-standard, 0.25 -> 45.2%, 0.15 -> 51.3%, 0 -> 49.0%. Kept at
 *  0.15, not 0 — the sliver of remaining caution is principled, not just
 *  the probe's argmax: the POSITION a token dies with is a real loss even
 *  when the soul is refunded, so exposure should never be literally free. */
const MK_EVAL_NECRO_THREAT_SCALE = 0.15;
/** Per-tile progression value for a NECROMANCER'S tokens in the hard eval —
 *  the hard-tier mirror of MK_STD_NECRO_RACE_SCALE (see that constant's
 *  block for why this class races where others tiptoe: Soul Harvest
 *  refunds its deaths). Added in the second balance pass when the standard
 *  tier learned to race and hard's necromancer mirror slid from the first
 *  pass's 46.3-49.3% to 42.5-45.2% against it — the shared
 *  MK_EVAL_PER_TILE=8 was pricing progression for a class whose whole
 *  second-pass identity became progression. Swept against the separation
 *  gate: 12 -> mirror 46.7/53.7/48.5 across three runs with the mk
 *  hard-vs-standard aggregate at 57.2/58.7/59.8% (passing with more
 *  margin than the first pass's 57.5/58.9); 16 -> catastrophic 31.2
 *  mirror and a FAILING 53.2% aggregate — past 12 the one-ply search
 *  starts walking tokens into refuted captures for raw distance, the
 *  exact recklessness MK_EVAL_NECRO_THREAT_SCALE's "never literally free"
 *  note warns about. Kept at 12, the modest +50% over shared. */
const MK_EVAL_NECRO_PER_TILE = 12;
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
 *  probability-weighted capture threat (skipped while Ward/Bulwark/transient
 *  safety protects the token), plus the charge economy terms. */
function mkEvalSide(state: GameState, power: PowerState, player: PlayerId): number {
  let score = 0;
  for (const t of state.tokens) {
    if (t.owner !== player) continue;
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += MK_EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) {
      // Reserve is worth exactly nothing — except a necromancer's, which
      // Raise Dead can return to the board on demand (see MK_EVAL_NECRO_RESERVE).
      if (power.classes[player] === "necromancer") score += MK_EVAL_NECRO_RESERVE;
      continue;
    }
    score += (power.classes[player] === "necromancer" ? MK_EVAL_NECRO_PER_TILE : MK_EVAL_PER_TILE) * t.position;
    const tile = BOARD_LAYOUT[t.position];
    if (tile.type === "shield") score += MK_EVAL_SHIELD_TILE;
    if (
      tile.isContested &&
      tile.type !== "shield" &&
      !isWarded(state, power, t) &&
      !isBulwarked(power, t) &&
      !power.safeTokens.has(t.id)
    ) {
      // A necromancer's exposure is cheap by design — see MK_EVAL_NECRO_THREAT_SCALE.
      const threatScale = power.classes[player] === "necromancer" ? MK_EVAL_NECRO_THREAT_SCALE : 1;
      for (const e of state.tokens) {
        if (e.owner === player || e.position < 0 || e.position >= PATH_LENGTH_PER_PLAYER) continue;
        const gap = t.position - e.position;
        if (gap >= 1 && gap <= 4) {
          score -=
            (threatScale * (MK_EVAL_THREAT_BASE + MK_EVAL_THREAT_PER_TILE * t.position) * FLIP_WEIGHTS[gap]) /
            FLIP_WEIGHT_TOTAL;
        }
      }
    }
    if (isBulwarked(power, t)) score += MK_EVAL_BULWARK;
  }
  // Necromancer charges are raise fuel and nothing else — see
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
    case "raiseDead":
      return applyRaiseDead(state, power, c.tokenId, mover, c.dark ?? false);
    case "exhume":
      return applyExhume(state, power, c.targetTokenId, mover);
  }
}

/** Value of Raise Dead / Dark Resurrection: the raise keeps the turn AND the
 *  flip (applyRaiseDead's contract — no re-roll), so its value is the best
 *  same-flip follow-up on the post-raise board, ending in the same
 *  mkValueAfterAction expectation every other candidate ends in. NOT
 *  mkValueAfterAction directly on the post-raise state — its own-turn arm
 *  would wrongly average over a fresh flip the mover never gets, hiding the
 *  raise's actual point (e.g. a flipped 2 the raised token itself can use).
 *  Same one-power-action-per-turn depth limit as mkReflipValue: a raise
 *  followed by, say, a Dark Resurrection isn't modeled. The charge spend is
 *  priced by MK_EVAL_CHARGE, and the half-alive reserve discount
 *  (MK_EVAL_NECRO_RESERVE) means the eval sees raising as converting 16
 *  points of graveyard into real board presence — so hard raises when the
 *  board (not a heuristic) says the body is needed. */
function mkRaiseValue(
  state: GameState,
  power: PowerState,
  c: Extract<PowerAction, { kind: "raiseDead" }>,
  flip: number,
  me: PlayerId,
): number {
  const r = applyRaiseDead(state, power, c.tokenId, me, c.dark ?? false);
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
    } else if (c.kind === "raiseDead") {
      value = mkRaiseValue(state, power, c, flip, mover);
      // A plain raise burns half a Dark Resurrection — option value the
      // one-ply search can't price. See MK_EVAL_PLAIN_RAISE_HOLDBACK.
      if (!c.dark) value -= MK_EVAL_PLAIN_RAISE_HOLDBACK;
      else value += MK_EVAL_DARK_RAISE_BIAS;
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
