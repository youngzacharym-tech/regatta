// ============================================================================
// master-killer.ts — rulebook for "Master Killer" mode, a class-powers
// variant of Regatta.
//
// SEPARATE from rulebook.ts on purpose. rulebook.ts stays the untouched
// classic game; this file layers class abilities on top by reimplementing
// its own move generator (see the note above getLegalPowerMoves for why a
// wrapper isn't possible) and importing only rulebook's plain data types.
//
// Same design principles as rulebook.ts:
//   - Pure functions. No I/O, no randomness (flipCoins is passed in/reused).
//   - GameState/PowerState are immutable — every function returns new ones.
//   - Tunable numbers are named constants at the top, not buried in logic.
// ============================================================================

import {
  BOARD_LAYOUT,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type TokenState,
  type PlayerId,
} from "./rulebook.ts";

// rulebook.ts's otherPlayer() is a private helper, not exported — kept that
// way on purpose (Phase 1 promise: zero changes to existing files), so this
// file carries its own trivial copy instead of touching rulebook.ts.
function otherPlayerId(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

// ============================================================================
// TUNABLES — adjust these, re-run batch-random-master-killer-games.ts, done.
// ============================================================================

/** Charges bank up to this many; further income while at the cap is a no-op.
 *
 *  RAISED 2 -> 4 on 2026-09-13 (user's call, after a probe): the old 2-cap
 *  made every "full bank" cast the same decision — spend everything or
 *  wait — and left the four 2-cost actives across the roster as the only
 *  spend most classes ever made. At 4 a class can hold its cheap cast AND
 *  its expensive one. The re-pricing that came with it: every former
 *  "full bank" cast is now a FIXED cost (CHARGED_SHOT_COST,
 *  BULWARK_REINFORCED_COST; Revive was already REVIVE_COST) and every gate
 *  that tested `=== CHARGE_CAP` tests `>= cost` — the probe showed a
 *  strict-equality gate on a deeper bank simply switches the ability off
 *  (Revive fell from 7/game to 0.3 before that fix). Ward is the one
 *  deliberate exception: it still asks for a FULL bank, see isWarded. */
export const CHARGE_CAP = 4;

/** THE WALL SYSTEM'S PRICE (2026-09-17): mana a wall-holder pays every one
 *  of their OWN turns, per wall, to keep it up (tickWallUpkeepForNewTurn).
 *  This is the entire balancing mechanism for an otherwise-absolute
 *  defense — the wall is safe, but you pay to keep it, so raising one is a
 *  real decision (armor up in a pinch; too expensive to leave on forever)
 *  instead of a free win button. GUARDRAIL, hard-won: a wall must NEVER be
 *  free to hold — free defense is the recorded Blessing 66-81% blowout
 *  (see BLESSING_CAP's doc), where breaking a blessing paid the attacker
 *  nothing and every blessed runner became a guaranteed escape. WALL_BLEED
 *  must stay > 0; WALL_BLEED_MIN is the floor even Hold the Line's
 *  discount can't cross.
 *
 *  SWEEP 1 (2026-09-17, 1000 games/matchup, HOLD_THE_LINE_DISCOUNT=0
 *  throughout): {1, 2, 3} tested. wallLife (turns a warrior-mirror wall
 *  survives its own upkeep) fell sharply, not linearly — 3.88 / 1.14 /
 *  0.67 — meaning bleed=2 already leaves a wall barely surviving its own
 *  first bill; 3 just kills it faster without changing the dynamic. Both
 *  the Warrior's and the Cleric's average win% across their 9 non-mirror
 *  matchups landed CLOSEST to 50 at bleed=1 (Warrior 50.7/49.0/48.1,
 *  Cleric 38.7/36.2/35.3 for 1/2/3 — Cleric never gets close to 50 at any
 *  bleed, the wound-economy loss dominates, exactly the risk this
 *  constant's guardrail note above expects — but 1 is the least-bad
 *  floor). Bar violations (excluding the pre-existing archer-vs-warlock
 *  outlier) were fewest at bleed=1 too: only archer-vs-cleric (33.2%);
 *  bleed=2 added cleric-vs-rogue/warlock; bleed=3 added cleric-vs-hunter
 *  and pushed archer-vs-cleric to 28%. avgTurns held flat across all
 *  three (~100-103, warrior mirror) — no turtling risk from the lower
 *  price. Shipped 1. Known consequence: WALL_BLEED_MIN also = 1, so
 *  Hold the Line's discount is now INERT (floored before it can ever
 *  apply) — Sweep 2 reinterprets the passive as a waived first upkeep
 *  instead of a per-payment discount, the fallback this note's earlier
 *  draft already flagged. */
export const WALL_BLEED = 1;
/** The floor no discount (Hold the Line) can push WALL_BLEED below — see
 *  WALL_BLEED's guardrail. */
export const WALL_BLEED_MIN = 1;
/** RETIRED 2026-09-17, same day it was written: Sweep 1 shipped
 *  WALL_BLEED === WALL_BLEED_MIN (both 1), which floors any per-payment
 *  discount before it can ever apply — a Warrior's Hold the Line paying
 *  "WALL_BLEED minus a discount" would always be a silent no-op. Kept at
 *  0 for the historical record; wallUpkeepFor no longer reads it. See
 *  HOLD_THE_LINE_FREE_TURNS for the passive's real shape now. */
export const HOLD_THE_LINE_DISCOUNT = 0;
/** Warrior's Hold the Line (passive, replaces Ward Breaker 2026-09-17;
 *  RE-SHAPED same day per HOLD_THE_LINE_DISCOUNT's retirement note): a
 *  fresh Bulwark cast banks this many turns of wallGrace for its caster —
 *  the front holds its first turn for free, same "spent front-first"
 *  grace pool Vigil/Sanctified Ground/Benediction already use (applyBulwark
 *  is the sole caller, and only a Warrior ever reaches it, so no class
 *  check is needed here — see wallUpkeepFor's own note on that). SWEEP 2
 *  (2026-09-17, 1000 games/matchup, WALL_BLEED=1): {0, 1} tested. Warrior's
 *  9-matchup average was 51.4% at 0 and 52.1% at 1 — a small, positive
 *  move, inside this sim size's own ~1.6pt noise floor, and no matchup
 *  left the 35/65 bar at either value (worst case both ways: warrior-vs-
 *  warlock 42.9%/45.3%). Shipped 1 anyway: 0 makes the passive a true
 *  no-op (nothing to point at when the client explains it), 1 costs
 *  nothing and never regresses a matchup, so there's no reason to ship
 *  the dead version. Re-visit with a larger sample if a future sweep
 *  needs the extra precision. */
export const HOLD_THE_LINE_FREE_TURNS = 1;

/** What it costs `owner` to hold one wall through their next turn-start —
 *  flat WALL_BLEED, floored at WALL_BLEED_MIN (the guardrail every wall
 *  shares; the floor and the bleed happen to be equal since Sweep 1, but
 *  the floor stays as its own named constant for the day either one
 *  re-tunes independently). The Warrior's own discount retired with
 *  HOLD_THE_LINE_DISCOUNT — see HOLD_THE_LINE_FREE_TURNS for how Hold the
 *  Line prices in now. */
export function wallUpkeepFor(power: PowerState, owner: PlayerId): number {
  void power;
  return Math.max(WALL_BLEED_MIN, WALL_BLEED);
}
/** ESCAPE PAYS (2026-09-16, user rule: "when a token crosses the finish to
 *  make a point you get a mana"): every escape banks the mover this many
 *  charges, through addCharge (so it clamps at the cap like all generic
 *  income). Until now the charge economy paid only for captures, zero
 *  flips and shield landings — every income was a fight or a fluke, and a
 *  side that was simply WINNING THE RACE was the side starved of mana.
 *  This is the race's own income. Paid on the classic exact-landing
 *  escape in resolveTurn and on a Bard march that escapes a stone
 *  (advanceStones); NOT on the game-winning fourth escape in any way that
 *  matters (the game is over). */
export const ESCAPE_CHARGES = 1;

/** Archer's Charged Shot: a fixed price, no longer "the whole bank". */
export const CHARGED_SHOT_COST = 2;

/** Warrior's Reinforced Bulwark: a fixed price, no longer "the whole bank". */
export const BULWARK_REINFORCED_COST = 2;
/** The reinforced TIER is retired (2026-09-13, user's call): every class
 *  now has exactly two actives, and the Warrior's are Charge and Bulwark.
 *  applyBulwark's `reinforced` path is unreachable from the wire, the bot
 *  and the client; the saves machinery it drove stays inert. If the
 *  mage-vs-warrior number it was added to hold (see BULWARK_REINFORCED_TURNS)
 *  slips, BULWARK_TURNS is the dial now. */
export const BULWARK_REINFORCED_RETIRED = true;

/** Mage's Re-flip: how many times per turn it can fire (each one still costs
 *  1 charge, still doesn't end the turn). Was hard-capped at 1 via a boolean
 *  (reflipUsedThisTurn); 2 gives the second banked charge a real Mage use —
 *  a Mage holding both charges can re-flip twice in the same turn, at the
 *  built-in price that spending below CHARGE_CAP drops Ward (isWarded gates
 *  on the full bank), so double-re-flipping trades the class's whole passive
 *  for one turn of dice control. That tension is deliberate — do not
 *  compensate for it elsewhere. An explicit numeric cap (not just "while you
 *  have charges") is REQUIRED, not stylistic: a re-flip that rolls a 0
 *  grants the zero-flip charge right back (see applyMkReflip in
 *  room-engine.ts), so an uncapped rule would let lucky zeros fund unbounded
 *  re-flips inside a single turn. Kept aligned with CHARGE_CAP on purpose —
 *  one re-flip per bankable charge.
 *  (Balance-sim at 30000 games/matchup, this cap at 1 vs 2 with everything
 *  else identical: a REAL Mage buff, not noise — mage-vs-warrior 52.0/48.0
 *  -> 56.2/43.8 (+4.2pts, the big one: Ward Breaker pierces Ward anyway,
 *  so against a Warrior the spend-below-cap tradeoff costs the Mage
 *  nothing) and archer-vs-mage 38.8/61.2 -> 36.4/63.6 (+2.4pts, where
 *  dropping Ward DOES bite, hence the smaller gain). Mirrors symmetric, no
 *  archer/warrior-only matchup moved. Kept at 2 anyway — Kasen's requested
 *  design, and the tension is the interesting part — with the compensation
 *  handled on the WARRIOR side of the same change set: Reinforced Bulwark
 *  (see BULWARK_REINFORCED_TURNS) pulled mage-vs-warrior back to
 *  54.5-54.7/45.3-45.5 at 30000-60000 games. Archer-vs-mage remains the
 *  known open thread it already was pre-change (see
 *  CHARGED_SHOT_WARD_DISTANCE's ship-now-reopen-later note).) */
export const REFLIPS_PER_TURN = CHARGE_CAP;
/* RETIRED as a gameplay cap 2026-09-17 (Zach's add, shipped after C2 so the
 * read wasn't confounded with Ward's new wall-rework immunity): canReflipAgain
 * gates purely on charges >= REFLIP_COST now — every history note above this
 * one describes a real per-turn rule that no longer exists. The constant
 * survives only as the SIM LOOPS' own safety bound (takeTurn's re-flip/
 * revive loop in batch-random-master-killer-games.ts, mirrored in
 * batch-bot-difficulty.ts) — set to CHARGE_CAP so the bound can never be
 * tighter than what REFLIP_COST could ever actually buy from a full bank
 * (at cost 2 that's at most 2 re-flips from CHARGE_CAP=4, 3 if a zero
 * mid-turn refunds one; the loop's own formula already adds slack on top
 * of this constant for exactly that case). room-engine.ts needs no such
 * bound at all — each Re-flip is one client-initiated action, re-validated
 * live by canReflipAgain every time, so there's no loop to run away.
 * C5 SIM CHECK (2026-09-17, 1000 games/matchup): Mage's 9-matchup average
 * landed at 55.56% (archer 57.1 / warrior 50.6 / necromancer 56.2 /
 * cleric 60.2 / rogue 49.1 / warlock 51.4 / hunter 56.9 / barbarian 59.4 /
 * bard 59.1) — up from the pre-change ~53.3 but still under the 58
 * watch-list trigger, every matchup inside the 35/65 bar (archer-vs-mage,
 * the roster's known open thread, sits at 42.9/57.1). reflip/g climbed to
 * 4.2-9.5 across Mage's matchups (was capped at ~1/turn), confirming the
 * mechanic is actually exercised, not just theoretically uncapped. Shipped
 * as-is; re-open if a later change pushes Mage past 58. */
/** Mana per Re-flip (2026-09-16, was a hardcoded 1). The bot only ever
 *  re-flips as a RESCUE — a zero flip or a blocked turn — and a zero flip
 *  pays a charge on commit before the decision, so at 1 the rescue was net
 *  free and the mage simply never had a dead turn (9.5 rescues per game;
 *  the roster's standing 62-64% class). The price is the dial. */
export const REFLIP_COST = 2;

/* 2 -> 1 on 2026-09-13, as the other half of giving the Mage a second
 * active (BLINK_COST below). The Mage was 65% against the field with ONE
 * repeatable active, and the 4-bank probe showed why: re-flips scale with
 * the bank (11.9 -> 15.7 casts/game at cap 4), so a deeper purse made the
 * strongest class stronger. One re-flip a turn plus a positional cast is
 * the same mana spent on decisions instead of dice. */

/** Mage's Blink (added 2026-09-13): teleport the mage's LEAST-advanced
 *  on-board stone to any EMPTY, non-shield tile in shared water ahead of
 *  it — no capture, ends the turn. The non-lethal sibling of Blink Strike,
 *  which is the same jump with a kill at the end and is gated behind the
 *  ultimate for exactly that reason.
 *
 *  The guardrails are this file's own recorded blowouts: SHARED WATER
 *  ONLY, never the home stretch (any placement past the gauntlet was a
 *  guaranteed-escape engine — the old Dark Resurrection's 97.8/2.2);
 *  NEVER A SHIELD TILE (a teleport onto a shield would farm the extra
 *  turn, the mana and the ultimate streak); ENDS THE TURN (extra ACTIONS
 *  are what compounded catastrophically — Push-grants-extra-turn at 95/5;
 *  bought movement that ends the turn is Song of Haste's proven shape).
 *  Never onto the enemy's trap tile or the tile their wolf guards, since
 *  those reactive layers resolve on a MOVE's landing and a blink is not
 *  one — the shadows don't fall where a trap waits. A frozen stone cannot
 *  blink (frozen means it does not move at all). Which stone: the
 *  rearmost on the board (findLeastAdvancedToken, auto-selected same as
 *  Blink Strike's own source stone) so the cast is a development tool
 *  rather than a way to rush the Warded leader home. */
export const BLINK_COST = 1;
/** How far ahead a Blink may reach, in tiles. The first matrix run had it
 *  unbounded and the Mage went to 88.7% (5 blinks/game; mage-vs-warlock
 *  96.9/3.1) — bought movement without a ceiling is the Rage lesson again.
 *  4 = the most a flip can give, chosen instead of rolled. */
export const BLINK_RANGE = 4;

/** Archer's Push: how many tiles back along the TARGET's own path.
 *  (Was 2 — simulation showed Archer mirrors grinding to ~270 turns via a
 *  push-enables-snipe-grants-charge-fuels-more-push loop; 1 breaks the loop
 *  without making Push useless.) */
export const PUSH_DISTANCE = 1;

/** Warrior's Charge sweep: how many EXTRA enemies it can capture beyond the
 *  primary landing tile, in a single move. Matches Snipe's own bonus-capture
 *  ceiling (1) on principle — no class's single move should out-capture the
 *  others by more than one extra. (Was uncapped — a bot-quality bug meant
 *  Warriors almost never spent Charge on a real multi-capture sweep, so the
 *  ceiling never mattered in practice; once that bug was fixed, an uncapped
 *  sweep made Charge worth far more per use than anything in Archer's kit,
 *  flipping archer-vs-warrior from 51.6/48.4 to 43.5/56.5 warrior-favored.) */
export const CHARGE_SWEEP_CAP = 1;

/** Mage's Ward: "all" = every one of the mage's tokens is warded while at
 *  CHARGE_CAP. "most-advanced" = only their furthest-along token is warded.
 *  (Was "all" — simulation showed Archer vs Mage at 29.5/70.5, since only
 *  Warriors can pierce a ward at all; "most-advanced" narrows the shield to
 *  one token so non-Warriors have more to work with.)
 *  (Revisited post-CHARGED_SHOT_DISTANCE=4 while chasing the same
 *  archer-vs-mage regression PUSH_WARD_DISTANCE's doc covers (archer-vs-mage
 *  flipped from mage-favored 48.7/51.3 to archer-favored ~53.6-54.2/45.8-
 *  46.4 once Charged Shot could hit any of Mage's 3 non-Warded tokens at
 *  full strength). Root-cause read at the time: Charged Shot was built to
 *  bypass isWarded entirely in getChargedShotTargets — Mage had NO defense
 *  against it at all, unlike Warrior's Bulwark. Two candidates tested, in
 *  order, 2500 games/matchup against the CHARGED_SHOT_DISTANCE=4 baseline:
 *  TRIED "all" (this constant, alone, Charged Shot still bypassing Ward):
 *  overshot HARD past parity into mage-favor — 44.7/55.3 (5.3pt margin from
 *  even, wrong direction) — worse than doing nothing. archer-vs-warrior held
 *  fine (49.8/50.2, the locked fix intact) and archer/warrior mirrors stayed
 *  flat, but mage-vs-warrior drifted too (49.6/50.4 baseline -> 47.1/52.9),
 *  confirming broader Ward scope leaks into Ward Breaker's matchup as
 *  expected. Rejected alone: "all" only helps Mage against Push/Snipe, and
 *  Charged Shot — the actual thing that broke this matchup — still ignores
 *  Ward completely regardless of scope, so widening scope alone can't touch
 *  the root cause and just overcorrects on the tools it DOES affect.
 *  TRIED instead: giving Charged Shot its own isWarded exclusion (see
 *  getChargedShotTargets — a Warded target is now fully immune to Charged
 *  Shot, no PUSH_WARD_COST-style affordability escape hatch, same as a
 *  shield tile) while leaving WARD_SCOPE at "most-advanced". This is the
 *  actual root-cause fix, not a compensating lever: 50.8/49.2 at 2500 games,
 *  confirmed 52.3-52.6/47.4-47.9 across two independent 6000-game runs
 *  (archer-favored by a 4.6-5.2pt margin) — a large, stable improvement over
 *  the 7.2-8.4pt baseline margin, though not quite all the way to parity or
 *  Mage-favored. archer-vs-warrior held at 49.5-50.8/49.2-50.4 across both
 *  runs (the locked CHARGED_SHOT_DISTANCE=4 fix intact), and every other
 *  matchup stayed within run-to-run noise of baseline. KEPT: WARD_SCOPE
 *  stays "most-advanced" (unchanged); the fix lives entirely in
 *  getChargedShotTargets's isWarded filter instead. Also tried the two
 *  changes COMBINED ("all" + Charged-Shot-respects-Ward): overshot even
 *  further than "all" alone — 43.9/56.1 (6.1pt margin, wrong direction) —
 *  confirming the two candidates aren't complementary the way
 *  PUSH_WARD_DISTANCE/CHARGED_SHOT_DISTANCE turned out to be; stacking two
 *  independent buffs to the same defensive tool (Ward) just double-counts.
 *  Widening WARD_SCOPE further is NOT recommended without also reopening
 *  Charged Shot's own economy (cost/distance) to compensate — out of scope
 *  for this pass.)
 *  (SUPERSEDED 2026-07-16: the "Charged Shot's own isWarded exclusion"
 *  mechanism this entry describes as the kept fix no longer exists — Kasen's
 *  requested strength ordering required Ward to become a legal-but-weaker
 *  Charged Shot target instead of an illegal one. See
 *  CHARGED_SHOT_WARD_DISTANCE's doc for the replacement mechanism and its
 *  own, worse-than-this-baseline archer-vs-mage numbers. This whole entry is
 *  kept as-is for the historical trace — WARD_SCOPE itself is untouched.) */
export type WardScope = "all" | "most-advanced";
export const WARD_SCOPE: WardScope = "most-advanced";

/** Archer's Push can target a warded token (previously impossible — Push
 *  used to treat Ward as full immunity, same as everyone else). This is the
 *  charge cost for pushing a WARDED target specifically; a normal push still
 *  costs 1.
 *  (Was 2 — the "base reposition (1) + piercing Ward (1 more)" framing, on
 *  the theory that draining the whole CHARGE_CAP bank in one shot suits
 *  bypassing the game's strongest defensive ability. Simulation showed 2
 *  brought Archer vs Mage from 30.6/69.3 to 37.6/62.4 — a real improvement,
 *  but still the widest margin of the three matchups (24.8 pts, vs ~17-21
 *  for the other two edges). Dropping to 1 instead brought it to 40.2/59.8
 *  (19.6 pts) — landing right in line with archer-vs-warrior (19.8) and
 *  mage-vs-warrior (15.0), the most even the whole RPS triangle has been.
 *  Kept at 1: same cost as a normal push, still gated on `charges >=
 *  PUSH_WARD_COST` so it scales cleanly if ever retuned back up.) */
/** RETIRED 2026-09-17 — walls are absolute now (see WALL_BLEED): a Warded
 *  target is excluded from getPushTargets entirely, the same as any other
 *  protected stone, so there is no separate Ward-tier cost left to pay.
 *  Constant and the historical trace below kept for the record. */
export const PUSH_WARD_COST = 1;

/** How far a Push knocks back a WARDED target specifically — a normal push
 *  still uses PUSH_DISTANCE.
 *
 *  RESTRUCTURED 2026-07-16 at Kasen's request: he pointed out the 4
 *  push/charged-shot x warded/unwarded combinations were landing in a
 *  genre-inconsistent strength order — a plain (non-charged) Push against a
 *  WARDED target was hitting harder (3 tiles) than the same Push against an
 *  unwarded one (1 tile), i.e. "putting a shield up" was making the shot
 *  STRONGER, backwards from every other game's convention (charged = harder,
 *  shielded = softer). He asked for a strict order instead: push-vs-ward
 *  (weakest) < push-vs-normal < charged-vs-ward < charged-vs-normal
 *  (strongest) — see CHARGED_SHOT_WARD_DISTANCE for the new counterpart this
 *  introduces.
 *
 *  This is NOT balance-neutral the way it was first pitched, despite "same
 *  abilities, just reordered" framing — this exact value used to be Mage's
 *  main defense against Push (tuned 2/3/4, landed on 3 specifically because
 *  1-2 left Mage too exposed, see the old history this replaces in git
 *  blame). Dropping it below PUSH_DISTANCE reopens that exposure. Deliberately
 *  set to 0 rather than shading PUSH_DISTANCE upward to compensate: raising
 *  PUSH_DISTANCE risks reopening the archer-mirror ~270-turn grind PUSH_DISTANCE=1
 *  was originally chosen to prevent (see that constant's own doc), a totally
 *  different failure mode than anything Ward-related. 0 keeps PUSH_DISTANCE
 *  and CHARGED_SHOT_DISTANCE (both load-bearing for the archer-vs-warrior
 *  fix, and PUSH_DISTANCE for archer-mirror's game length) completely
 *  untouched, and confines the re-tune to the two new Ward-specific values —
 *  both of which only ever apply against a Mage, so archer-vs-warrior and
 *  archer-mirror are structurally unaffected no matter what these two land
 *  on. A push that does 0 tiles is a real, if minimal, action: it still
 *  spends the charge, still breaks the
 *  mover's shield streak — same non-distance side effects Push always had —
 *  it just can never itself send a Warded target home. See
 *  batch-random-master-killer-games.ts output for the actual re-tuned
 *  archer-vs-mage numbers under this restructuring. */
/** RETIRED 2026-09-17 — see PUSH_WARD_COST's note just above: a Warded
 *  target never reaches Push's collision math at all any more. */
export const PUSH_WARD_DISTANCE = 0;

/** Archer's Charged Shot: spends BOTH banked charges at once (requires
 *  charges === CHARGE_CAP) for a flat, fixed knockback distance against an
 *  UNWARDED target. A deliberately SEPARATE mechanic from Ward-piercing:
 *  Ward-piercing solves "how do I touch a Warded target at all," Charged
 *  Shot solves "how do I hit harder in general" — and is the tool meant to
 *  help archer-vs-warrior specifically, since Warriors are never Warded.
 *  Refunds 1 charge on send-home, same mechanism as normal Push — net cost
 *  is -1 charges even on a hit (spend 2, refund 1), vs Push's spend-1/
 *  refund-1 = net 0.
 *
 *  Tuned to 4 specifically to fix archer-vs-warrior (5 failed attempts
 *  across prior sessions before this value landed it at ~49.9/50.1 — see
 *  git blame on this file for the full tuning trace). Since Warrior tokens
 *  are never Warded, this value ALWAYS governs the archer-vs-warrior
 *  matchup regardless of anything Ward-related — kept fixed at 4 through
 *  the 2026-07-16 Ward-order restructuring for exactly that reason. Do not
 *  retune this to fix an archer-vs-mage problem; use
 *  CHARGED_SHOT_WARD_DISTANCE instead, which is scoped to Mage by
 *  construction. */
export const CHARGED_SHOT_DISTANCE = 4;

/** How far a Charged Shot knocks back a WARDED target specifically — a
 *  Charged Shot against an unwarded target still uses CHARGED_SHOT_DISTANCE.
 *  New 2026-07-16, alongside PUSH_WARD_DISTANCE's restructuring (see that
 *  constant's doc for the full context): Charged Shot used to treat a
 *  Warded target as fully immune (excluded from getChargedShotTargets
 *  entirely, no affordability escape hatch) — that exclusion was ITSELF
 *  the prior session's fix for archer-vs-mage overshooting archer-favored.
 *  Kasen's requested order needs Ward to be a legal-but-weaker target
 *  instead of an illegal one, which structurally reopens that exact lever.
 *  Scoped by construction to matchups against a Mage (isWarded is never
 *  true otherwise), so archer-vs-warrior/archer-mirror can't drift from
 *  this — see the isWarded branch in computeChargedShotLanding.
 *
 *  Must land strictly between PUSH_DISTANCE(1) and CHARGED_SHOT_DISTANCE(4)
 *  to satisfy the requested order — since neither endpoint can move (both
 *  load-bearing elsewhere, see their own docs), that leaves exactly two
 *  candidate integers, both tried at 5000 games/matchup against the
 *  PUSH_WARD_DISTANCE=0 baseline (after fixing a real scorePush bot bug
 *  found along the way — see that function's own comment; the flat
 *  "+60 if warded" bonus was tricking the bot into spending charges on a
 *  push that PUSH_WARD_DISTANCE=0 makes a total no-op):
 *  Tried 2: archer-vs-mage 20.5/79.5 — badly mage-favored.
 *  Tried 3 (the ceiling): archer-vs-mage 38.0/62.0 — still badly
 *  mage-favored, but the best available within the ordering constraint.
 *  Neither comes close to the pre-restructuring baseline (53.6/46.4
 *  archer-favored) — this is a structural cost of the reordering itself,
 *  not a tuning miss: PUSH_WARD_DISTANCE used to be Archer's cheap,
 *  frequent, spammable tool against Mage's warded token; forcing it to 0 to
 *  satisfy "weakest" removes that entirely, and Charged Shot — gated behind
 *  banking both charges — fires far less often (chargedShot/g ~1-2 per
 *  player per game vs push/g ~10+ under the old design) so it can't fully
 *  substitute. KEPT AT 3 (the best of the two options) as a deliberate
 *  "ship now, re-open later" call — see project session notes for the plan
 *  to revisit archer-vs-mage as its own thread. archer-vs-warrior (50.3/
 *  49.7), archer mirror (50.3/49.7), mage mirror (50.5/49.5), and
 *  mage-vs-warrior (50.6/49.4) all held completely flat through this whole
 *  change, exactly as the scoping argument predicted. */
/** RETIRED 2026-09-17 — same story as PUSH_WARD_COST/DISTANCE: a Warded
 *  target is excluded from getChargedShotTargets outright now, so
 *  computeChargedShotLanding never reaches this tier. */
export const CHARGED_SHOT_WARD_DISTANCE = 3;

/** Ultimates: how many CONSECUTIVE shield-tile landings, within one unbroken
 *  turn-chain, it takes to earn a class's ultimate. Shared by all three
 *  classes — Archer's Rain of Arrows fires immediately on the 3rd landing;
 *  Mage's and Warrior's ultimates (not yet built) instead bank an
 *  ultimateReady flag to spend later. Only 3 shield tiles exist on the whole
 *  board, so this is rare by construction even at 3.
 *  (Balance-sim confirmed at 3, 5000 games/matchup against a freshly
 *  captured pre-change baseline: rainOfArrows/g stayed at 0.007-0.016 —
 *  fires in roughly 1-in-100 games, confirming the rarity — while every
 *  matchup's win split moved less than ~1.5 points from baseline, well
 *  inside normal run-to-run sampling noise (warrior mirror, which should be
 *  mathematically untouched since Rain of Arrows never applies there,
 *  settled to an exact 50.0/50.0). Matchups not involving an Archer showed
 *  rainOfArrows/g=0.0000 exactly, confirming Mage/Warrior's banked
 *  ultimateReady flag has zero gameplay leakage since nothing consumes it
 *  yet. No retuning needed at 3.) */
export const ULTIMATE_STREAK = 3;

/** Warrior's Bulwark: how many of the BULWARKED PLAYER's own turns pass
 *  before an unconsumed Bulwark expires automatically — a countdown, not
 *  permanent insurance (see PowerState.bulwarked for why). Ticked once per
 *  the bulwarked player's own fresh flip (tickBulwarkExpiry), independent of
 *  early consumption (see getBulwarkBlockedIds/consumeBulwarkBlocks), which
 *  clears it the instant it actually saves a token — whichever happens
 *  first.
 *  (Balance-sim tried 2/3/4, 2500 games/matchup, holding the bot's
 *  scoreBulwark heuristic fixed across all three (see master-killer-bot.ts
 *  for why that heuristic itself needed a negative floor — an earlier,
 *  more generous version caused wild over-tuning noise that would have
 *  swamped this comparison). Every value kept the three matchups WITHOUT a
 *  Warrior within ~2 points of the pre-Bulwark baseline, as expected
 *  (Bulwark is fully gated behind classes[x]==="warrior"). But archer-vs-
 *  warrior (baseline ~43.3/56.7 warrior-favored) moved FURTHER from parity
 *  at every value tried — 42.8/57.2 at N=2, 40.2/59.8 at N=3, 38.5/61.5 at
 *  N=4 — the opposite of this ability's hoped-for effect on that matchup;
 *  a defensive tool that never misfires just makes the already-favored
 *  class win more, and longer-lived Bulwark (higher N) only compounds
 *  that (bulwarkBlock/g climbed 1.54 -> 2.43 -> 2.93 across the same
 *  sweep). mage-vs-warrior told the same story (baseline 50.8/49.2 mage-
 *  favored, swinging to 48.2/51.8, 47.2/52.8, 48.0/52.0 warrior-favored at
 *  N=2/3/4 respectively). Landed on 2: it moves archer-vs-warrior the
 *  LEAST (-0.5pt vs -3.1 and -4.8 at N=3/N=4) while still giving Bulwark
 *  real presence (bulwark/g ~9.4, bulwarkBlock/g ~1.5) — the most
 *  conservative value is the healthiest one here, not the default 3.
 *
 *  RETIRED as a Bulwark countdown 2026-09-17 (the wall rework: a wall no
 *  longer expires, it bleeds — see WALL_BLEED). Kept alive only because
 *  VANISH_TURNS is still defined relative to it; the history above stays
 *  for the record. */
export const BULWARK_TURNS = 2;

/** Reinforced Bulwark — the Warrior's use for the SECOND banked charge:
 *  spends the full bank (CHARGE_CAP) on one Bulwark with everything doubled
 *  against the plain cast — 2x cost, 2x lifetime (this constant, vs
 *  BULWARK_TURNS), 2x saves (BULWARK_REINFORCED_SAVES, vs a plain Bulwark's
 *  implicit 1). This constant is the caster's-own-turns countdown before an
 *  unconsumed Reinforced Bulwark expires.
 *
 *  2026-07-17 (Kasen's fix list): a reinforced Bulwark also shrugs off a
 *  plain Push entirely (see isBulwarkReinforced/getPushTargets) — Charged
 *  Shot is the Archer tool that still moves it, soft knockback only.
 *
 *  CHOSEN BY SIMULATION over the other candidate, "twin Bulwark" (one
 *  action Bulwarks two own tokens at once, 1 charge each), 30000
 *  games/matchup per configuration against a same-day reference (Mage
 *  double-Re-flip included, no Warrior second-charge use):
 *  reference archer-vs-warrior 52.2/47.8, mage-vs-warrior 56.2/43.8.
 *  - Twin, permissive bot scoring (fired 2.6-4.9/g): tanked the Warrior —
 *    54.7/45.3 and 57.8/42.2 (-2.5/-1.6pts) — the bot file's known "charges
 *    spent on defense starve Charge's capture loop" failure mode
 *    (charge/g fell 3.35->2.95 and 2.84->2.48).
 *  - Twin, threat-gated honest scoring: fired 0.01-0.07/g — two
 *    simultaneously-threatened Bulwark-worthy tokens almost never exist, so
 *    the ability is dead weight; matchups sat exactly at reference. Twin is
 *    also design-redundant (two Bulwarks across two turns is ALREADY legal —
 *    getBulwarkTargets never limited the map to one entry; same-turn casting
 *    was its only value-add) and needs a novel two-tap targeting UI. Deleted.
 *  - Reinforced, threat-gated scoring (shipped; fires a healthy 0.4-1.1/g):
 *    improved BOTH Warrior matchups toward parity, confirmed at 60000
 *    games/matchup: archer-vs-warrior 51.6/48.4 (+0.6), mage-vs-warrior
 *    54.7/45.3 (+1.5, the biggest recovery available against the Mage
 *    double-Re-flip buff), warrior mirror 49.7/50.3, and zero movement in
 *    any non-Warrior matchup (Bulwark is fully warrior-gated).
 *  Lifetime tried at 3 first (aw 51.9/48.1, mw 55.6/44.4 at 30000); 4
 *  tested equal-or-better (aw 51.5/48.5, mw 55.6/44.4) and lands the clean
 *  2xBULWARK_TURNS doubling story, so 4 it is. */
export const BULWARK_REINFORCED_TURNS = 4;

/** Reinforced Bulwark: how many capture-blocks it absorbs before fading —
 *  a plain Bulwark is consumed by its first save; a reinforced one
 *  survives it and fades on the second (see PowerState.bulwarkSaves /
 *  consumeBulwarkBlocks). See BULWARK_REINFORCED_TURNS for the full
 *  simulation trace that picked this design. */
export const BULWARK_REINFORCED_SAVES = 2;

/** Necromancer's Soul Harvest (passive, REWORKED 2026-07-19): how many
 *  charges the necromancer banks per QUALIFYING KILL — a send-home of a
 *  token whose REAL owner is the opponent (killing an enemy THRALL of your
 *  own body in a mirror is a reclaim, not a soul — standard 1-charge
 *  economy). Replaces both the old death-side Soul Harvest (charge per own
 *  token lost — the attrition identity Kasen's playtest called "boring, all
 *  defense") and the generic 1-charge capture grant for necromancer movers.
 *  3 on a 3-cap bank means one kill fully funds a Revive — including a
 *  kill BY the thrall, which is the chain-necromancy loop Kasen picked
 *  deliberately ("yes, let it chain"). FIRST NERF LEVER if sims blow out:
 *  drop to 2, making every thrall cost two kills. */
export const SOUL_BOUNTY_CHARGES = 3;

/** The necromancer's charge cap — one higher than everyone else's
 *  CHARGE_CAP, but the third pip is the SOUL GEM: generic income (zero
 *  flips, shield landings, non-qualifying captures) still runs through
 *  addCharge, which caps at CHARGE_CAP for every class INCLUDING the
 *  necromancer — only grantKillBounty reaches this cap. There is no
 *  passive road to a full soul bank: the necromancer must draw blood.
 *  (This is Kasen's "spend 2 to unlock the third charge" idea expressed as
 *  a gate instead of a transaction — same tension, no extra bookkeeping.)
 *  Every CHARGE_CAP reference in the archer/mage/warrior kits (Charged
 *  Shot's full-bank gate, Reinforced Bulwark's cost, Ward's threshold) is
 *  deliberately untouched: no other class can ever hold a third charge. */
export const NECRO_CHARGE_CAP = CHARGE_CAP;
/* Was CHARGE_CAP + 1 (the "soul gem", a pip only kills could reach). Set
 * equal on 2026-09-13, user's call: every class shows and holds the same
 * four. The Necromancer's identity is that a kill pays SOUL_BOUNTY_CHARGES
 * at once, not that its purse is deeper. */

/** Necromancer's Revive: the full-soul-bank (NECRO_CHARGE_CAP) cast that
 *  consumes the corpse (see PowerState.corpse) and raises the killed ENEMY
 *  token on the tile it died on, fighting for the necromancer as a THRALL
 *  for this many of the necromancer's own turns (the raise turn counts —
 *  Revive doesn't end the turn, so the thrall can move immediately).
 *  Ticked on every fresh flip dealt to the necromancer, the
 *  tickBulwarkExpiry convention — extra turns from shield landings DO
 *  burn a thrall turn, but they also grant the immediate extra move, so
 *  the trade is self-balancing. At 0 the thrall crumbles back to its real
 *  owner's reserve. SECOND NERF LEVER: drop to 1.
 *
 *  HISTORY THAT SHAPED THIS DESIGN — both prior blowouts are respected:
 *  the old Dark Resurrection's tile-12 experiments (97.8/2.2 vs archer;
 *  still 93.6/6.4 even paired with a turn-ending nerf) proved that any
 *  placement PAST the contested gauntlet is a guaranteed-escape engine —
 *  so the thrall spawns ON the row and is chained to it (never past tile
 *  11, never escapes, never scores; a knockback that would drop it below
 *  tile 4 crumbles it instead — the victim's private lane stays sacred).
 *  And Push-grants-extra-turn (95/5, see applyPush) proved extra ACTIONS
 *  compound catastrophically — the thrall is an extra OPTION on the
 *  normal flip, never an extra action. THIRD NERF LEVER, per that same
 *  tradition: "Revive ends the turn." Fairness invariant, doc'd at
 *  applyRevive: possession never leaves the victim worse off than the
 *  kill that enabled it (expiry and thrall-death both end at the reserve
 *  the token was already headed to). */
export const THRALL_TURNS = 3;

/** What a Revive costs: the entire soul bank. Kept equal to
 *  NECRO_CHARGE_CAP on purpose (Charged Shot / Reinforced Bulwark's
 *  full-bank-spend pattern at the necromancer's own cap) — a separate
 *  named constant so a future partial-cost experiment is one edit. */
export const REVIVE_COST = 3;

/** Corpse Explosion (added 2026-07-20, Kasen's second playtest round: the
 *  class needs a spend BELOW the full bank — with Revive as the only cast,
 *  charges 1-2 were pure waiting): detonate the marked corpse instead of
 *  raising it. Every UNPROTECTED enemy stone within
 *  CORPSE_EXPLOSION_RADIUS of the grave on the contested row is knocked
 *  back 1 tile along its own path (standard collision math — a blocked
 *  landing is a send-home). The blast DESECRATES: its send-homes pay no
 *  soul bounty and mark no corpses (chain explosions were the obvious
 *  blowout; the thrall keeps chain necromancy as its exclusive), and the
 *  corpse is consumed either way. Ends the turn and breaks the shield
 *  streak (Push's precedent — an attack, not a placement; Revive keeps
 *  the kit's one turn-keeping act). The same corpse now has TWO spends —
 *  burn it for tempo at 2, or hold the full bank for the thrall at
 *  REVIVE_COST — which is the decision the kit was missing. */
export const CORPSE_EXPLOSION_COST = 2;
export const CORPSE_EXPLOSION_RADIUS = 0;
/* LETHAL since 2026-09-13. The knockback version measured 0.09 casts per
 * game across the whole matrix, and the reason was arithmetic, not the
 * bot: a kill pays SOUL_BOUNTY_CHARGES (3), the corpse only exists after a
 * kill, so whenever a corpse existed Revive (a 3-turn thrall that keeps
 * the turn and chains) was on the menu — and a 1-tile shove never beats
 * that. There was no board state where the explosion was the best play.
 * The fix is the VALUE, not the price: every unprotected enemy within the
 * radius is now SENT HOME (a blessed one is wounded in place, Push's
 * rule). Desecration is unchanged and is the whole cost — the kills pay
 * no bounty and mark no corpse — so the rite is now a real fork: burn the
 * grave for up to two bodies now, or hold three mana to raise one thrall
 * that can chain. Radius and a kill cap are the dials if it overshoots.
 *
 * THE GRAVE OUTLIVES THE RAISE (2026-09-16). Lethal still measured
 * 0.03-0.2 casts per game, and this time the reason was the fork itself:
 * a kill pays SOUL_BOUNTY_CHARGES (3), so Revive is affordable the moment
 * a corpse exists, and the necromancer has no 1-mana spend for the blast's
 * saving to buy. A 10,000-game probe found a victim beside a fresh grave
 * on 36% of post-kill turns — the button lit often enough — but Revive was
 * lit on 90% of those same turns and keeps the turn, so the blast only ever
 * fired once the bank had been drained below 3 (Rogue Larceny: 0.9/game)
 * or a thrall already held the slot. Radius could not fix that: only 49%
 * of banked turns had ANY unprotected enemy on the row, so radius 2 moved
 * the choice-point figure from 36% to 40%. The fix is to stop the rites
 * competing: the kill now marks a GRAVE (PowerState.grave) as well as the
 * corpse; Revive takes the body and leaves the grave; the blast reads the
 * grave (not the raisable body — a re-entered victim no longer disarms the
 * mine) and consumes both. So the flow becomes raise now, and the open
 * grave stays on the row as a threat until a fresh kill moves it or the
 * necromancer pays 2 to detonate it under whoever stands on it.
 *
 * RADIUS 0 came with the split (sweep at 1000/matchup, necromancer vs the
 * field, old design 46.5% / 0.22 casts): cost 2 radius 1 = 57.0% / 3.7;
 * cost 3 radius 1 = 56.0% / 2.7; cost 4 radius 1 = 52.3% / 1.7; cost 2
 * radius 0 = 52.6% / 2.3 (2000/matchup confirms 52.6 / 2.3); cost 3
 * radius 0 = 52.0% / 1.5. Price barely moves it — kills pay 3, so the
 * bank is never the constraint — while radius is the whole dial, and 0
 * reads best at the table: the ONE stone standing on the grave dies.
 * Cost stays 2 so the kit keeps its below-full-bank spend. The opposing
 * bots do not yet route around an armed grave; a human will, so live
 * play should sit a little under these numbers. */

/** Necromancer's Exhume ultimate: the board position an ESCAPED enemy token
 *  is dragged back to — the only mechanic in the game that touches the win
 *  condition itself, which is exactly the drama the shield-streak gate's
 *  rarity (Rain of Arrows fires ~1-in-100 games at the same streak) is
 *  meant to pay for. 11 = the last contested tile: the victim re-runs only
 *  the home stretch, the gentlest meaningful setting. Lower is crueler and
 *  sim-adjustable. If the occupancy walk (see applyExhume) has to step
 *  back, it can never in practice leave the contested row: at most 7
 *  blockers (opponent's 3 other tokens + the caster's 4) over 8 contested
 *  tiles guarantees a free one, so the private-lane arm of the collision
 *  check only matters if this constant is ever retuned below 4.
 *  (First balance pass, 5000 games/matchup: TRIED 4 — the cruelest
 *  contested-row setting, the victim re-runs the entire shared row —
 *  against 11, with the shipped scoreRaiseDead policy on both sides:
 *  indistinguishable at this sample size (mage-vs-necromancer 69.0/31.0
 *  at 4 vs 69.3/30.7 at 11; every other necromancer matchup moved ~1pt,
 *  inside noise). The lever's reach is capped by Exhume's FIRE RATE, not
 *  its cruelty — exhume/g sits at 0.07-0.16 (ULTIMATE_STREAK gates it),
 *  so even the maximum setting touches too few games to register. KEPT
 *  at 11, the gentlest meaningful setting: an unmeasurable win isn't
 *  worth spending the drama budget of the game's one win-condition-
 *  touching mechanic. Revisit only if a future pass raises the fire
 *  rate.)
 *  (Second balance pass: the fire rate DID rise — the necromancer's
 *  standard-tier shield-landing bonus (see master-killer-bot.ts's
 *  MK_STD_NECRO_SHIELD_EXTRA) lifted exhume/g from 0.04 to 0.06-0.11
 *  across the necromancer matchups, and a streak-chasing escalation
 *  probe reached 0.21 in the mirror — but even doubled-to-quintupled,
 *  the rate is still an order of magnitude short of one-per-game, and
 *  the 35/65-bar arithmetic (<=1pt of win-rate reach at these rates)
 *  is unchanged. Same verdict: keep 11.) */
export const EXHUME_RETURN_POSITION = 11;

/** Cleric's Bless (added 2026-07-21, Kasen's spec: "increase maximum hp to
 *  2 and heal them"): spends this much to grant one of the cleric's own
 *  stones the BLESSING — a second life. The first capture that would kill a
 *  blessed stone breaks the blessing instead: the stone is WOUNDED, stays
 *  on the board (staggering back to the nearest open tile only when the
 *  killer physically needs its tile — see resolveTurn's wound resolution),
 *  and the attacker gets nothing: no capture charge, no soul bounty, no
 *  corpse (a blessed stone can NEVER become a necromancer's corpse — only
 *  a full kill marks one). FIRST PRICED at the full bank (CHARGE_CAP, the
 *  Charged Shot / Reinforced Bulwark full-spend pattern) — the first
 *  balance run confirmed the predicted undershoot HARD (defense doesn't
 *  win races here, the old necromancer attrition kit's exact fate):
 *  72.7/27.3 archer, 79.5/20.5 mage, 59.1/40.9 warrior, 60.3/39.7 necro
 *  at 1500/matchup, with bless/g a starved 0.6-1.2 outside the mirror
 *  (full bank + threat-gated bot = the cast barely ever fires).
 *  TUNING TRACE (1200/matchup each step) — this constant and the
 *  turn-keeping contract were found TOGETHER, neither works alone:
 *  - cost 1, turn-ending: 72.9/75.7 AGAINST (price wasn't the bottleneck,
 *    tempo was — a whole turn per cast vs classes that spend none).
 *  - cost 1, Bless+Heal both turn-keeping: 81-90 FOR (blessings became
 *    free to maintain — heal/g 4+, permanent immortality).
 *  - cost 1, Bless keeps / Heal ends: still 78-85 FOR — 1 slow-income
 *    mana per permanent second life is simply underpriced.
 *  - cost 2 (the full bank), Bless keeps / Heal ends: the shipped combo —
 *    every blessing empties the bank the class fills only slowly, so
 *    uptime is income-bound and the attacker's break sticks. */
export const BLESS_COST = 2;

/** How many of the cleric's stones may carry a live blessing AT ONCE —
 *  Bless's AND Heal's pools both empty while the count is met (only
 *  "blessed" entries count; wounded ones don't), and only Benediction,
 *  the ultimate, may exceed it. Added after HEAL_COST=2 still left the
 *  two burst-less classes outside the bar (archer 71.6, necro 74.3
 *  cleric-favored at 1500/matchup): with no cap the whole army armors up
 *  over time and single-target removal faces four two-hit stones — a
 *  grind the cleric's endless zero-flip income always wins. Swept 2 vs 3
 *  at 1500/matchup: 2 landed archer/warrior/necro inside with huge margin
 *  (58.3/54.7/53.6 against the cleric) but left the mage — whose Ward
 *  blanks the cleric's offense — at 71.5/28.5 even after the blessed
 *  blade's pierce; 3 spends that spare margin exactly where it was
 *  needed: archer 44.1/55.9, mage 63.5/36.5, warrior 45.5/54.5, necro
 *  41.7/58.3, mirror 50.6 — every cleric matchup inside 35/65 at last.
 *  One stone always stands outside the light. Teachable in one line:
 *  "the light shelters three at a time." */
export const BLESSING_CAP = 3;

/** Cleric's Vigil (2026-09-17, RENAMED from HEAL_COST when Heal became
 *  Vigil under the wall rework — see applyVigil). HISTORICAL, from the old
 *  Heal-mends-a-wound kit: mending a WOUNDED stone back to blessed ENDED
 *  the turn (laying on hands takes the whole turn; the quick prayer
 *  doesn't) — that asymmetry was load-bearing, found by overshooting in
 *  both directions at 1200/matchup: both casts turn-ending = 72.9-79.5
 *  AGAINST the cleric (tempo-starved, see BLESS_COST's trace); both casts
 *  turn-keeping = 86.1-89.6 FOR the cleric vs warrior/necro/archer — the
 *  wound-then-mend cycle cost the cleric nothing while every enemy
 *  landing paid nothing, so blessings were effectively permanent
 *  (heal/g 3.9-4.3, wound/g 6.7-9.0). Making the MEND pay real tempo was
 *  the dial that made a broken blessing a real setback the attacker
 *  earned. PRICE raised 1 -> 2 in the same sweep: at 1 the break-mend
 *  war stayed cleric-favored against the two classes with no burst
 *  removal (archer 73.2, necro 75.9 — wound/g 5.6-8.0). Vigil inherits
 *  both the price and the turn-ending shape for the same reason: a
 *  turn-keeping upkeep-waiver would let the class farm walls for free,
 *  the exact failure this history warns against. */
export const VIGIL_COST = 2;

/** Rogue's Larceny (passive, free, added 2026-07-21): every REAL kill the
 *  Rogue lands drains this much mana from the victim's owner, on top of the
 *  Rogue's own normal capture income — the one ability in the game that
 *  touches the OPPONENT's bank directly rather than the mover's own. Wired
 *  directly into resolveTurn, the shared landing-capture path every class's
 *  moves funnel through; Grand Heist does NOT also apply this — its own
 *  "drain the entire bank" is the bigger, ultimate-tier version of the same
 *  idea, not a stack on top of it. Like Cleric's wound split, a WOUND (a
 *  blessed victim surviving the hit) is not a real kill and does not
 *  trigger this — same "wounds pay the standard capture charge but none of
 *  the bespoke per-class income" rule Necromancer's soul bounty already
 *  follows. RAISED 1 -> 2 2026-07-21 as the class's compensation for
 *  Backstab's short-lived shield-breaker rework (narrow, situational,
 *  crashed the class's win rate to 23-42% against everything) — that
 *  rework was itself then REPLACED the same day by Vanish (see
 *  VANISH_COST's doc) once the sim showed doubling this alone wasn't
 *  enough. Kept at 2 through the Vanish + doubled-Pickpocket pass too
 *  (2000/matchup): archer-vs-rogue 72.7/27.4, mage-vs-rogue 73.8/26.3,
 *  warrior-vs-rogue 61.2/38.9, necromancer-vs-rogue 54.9/45.1,
 *  cleric-vs-rogue 64.4/35.6 — still lost everywhere except a near-healthy
 *  necromancer matchup. Best-supported read, same shape as the ORIGINAL
 *  Backstab investigation reached: Mage is independently the roster's
 *  strongest class overall (it beats warrior 60.7/39.4, necromancer
 *  66.9/33.1, and cleric 62.4/37.6 too, not just rogue), and Archer's
 *  edge here looks like its own preexisting quirk against Rogue's board
 *  profile specifically (it doesn't dominate warrior/necromancer/cleric
 *  the same way) — neither is a Rogue-income problem, so raising THIS
 *  constant further is very unlikely to move either number. A real fix
 *  needs a dedicated Mage/Archer-side pass, deliberately not guessed at
 *  further here (see PICKPOCKET_STEAL's doc for the matching finding on
 *  that lever). */
export const ROGUE_STEAL_ON_CAPTURE = 2;

/** Rogue's Pickpocket: 1 mana, steals PICKPOCKET_STEAL mana from a
 *  targeted enemy in shared water WITHOUT capturing it — no capture means
 *  no protection applies (Ward/Bulwark/Blessing/a shield tile are all
 *  irrelevant to a theft that never touches the stone itself), so its
 *  target pool is gated only by the enemy having something worth stealing.
 *  Keeps the turn, same convention as Re-flip/Revive. Deliberately NOT a
 *  net-zero transfer (spend 1, foe loses 1, mover does not get the stolen
 *  mana back) — a real cost paid for a real cost inflicted, not a free
 *  relocation of resources. */
export const PICKPOCKET_COST = 1;
/** See getPickpocketTargets. */
export const PICKPOCKET_RETIRED = true;
/** How much of the target's bank Pickpocket drains — RAISED 1 -> 2
 *  alongside Vanish (2026-07-22): the "keep steal and invisibility as two
 *  separate, independently-tunable levers" half of the same request that
 *  added Vanish (see VANISH_COST's doc). The post-Vanish sim still showed
 *  archer-vs-rogue and mage-vs-rogue badly lost (70.4/29.6, 75.8/24.1 at
 *  2000/matchup) — Push and Charged Shot's knockback isn't something
 *  Vanish (a plain-Bulwark clone) fully answers by design (a plain Bulwark
 *  only stops a Push from sending the stone all the way home, same
 *  carve-out this ability has always respected — see getPushTargets), so
 *  the theory was the compensation had to come from the class's income,
 *  not its defense — doubling Pickpocket's own drain on top of Larceny's
 *  own 1->2 raise. RE-MEASURED (2000/matchup) and it barely moved either
 *  number: archer-vs-rogue 70.4/29.6 -> 72.7/27.4, mage-vs-rogue
 *  75.8/24.1 -> 73.8/26.3 — both within noise. Same dead-end shape as the
 *  original Backstab investigation's own Larceny experiment (see
 *  ROGUE_STEAL_ON_CAPTURE's doc): a flat income buff doesn't touch
 *  whatever's actually driving these two matchups (read there is that
 *  Mage is just the roster's strongest class outright, and Archer has its
 *  own preexisting edge against Rogue specifically). Kept at 2 anyway — it
 *  did no harm and pickpocket/g stayed healthy — but don't expect raising
 *  it again to move archer/mage-vs-rogue; that needs its own dedicated
 *  pass on the OTHER side of those matchups. */
export const PICKPOCKET_STEAL = 2;

/** Rogue's Vanish (added 2026-07-22, replacing Backstab's slot entirely —
 *  see PowerState.walls' history for the discarded shield-breaker rework
 *  this supersedes). The user's diagnosis after that rework crashed the
 *  class to a 23-42% win rate everywhere: every OTHER class has some
 *  defensive lever (Mage's Ward, Warrior's Bulwark, Cleric's Blessing) —
 *  Rogue had none, so once Backstab stopped being an offensive equalizer
 *  the class had no way to protect its own advancing stones at all. Vanish
 *  is that missing lever: spend VANISH_COST to make one of the mover's own
 *  on-board stones fully untargetable for VANISH_TURNS of the mover's own
 *  turns — excluded from every enemy targeted ability's pool AND immune to
 *  plain-move capture, same as a walled stone.
 *
 *  HISTORICAL (until 2026-09-17): originally a second caster of Warrior's
 *  EXACT Bulwark mechanic, sharing its bulwarked/bulwarkSaves maps and
 *  every tick/diff/consume function, on the reasoning that a Warrior XOR
 *  Rogue seat meant zero cross-talk risk and reinventing the machinery
 *  would be pure duplication. The wall rework split them apart
 *  (PowerState.vanished is now Vanish's own map): Bulwark became a paid,
 *  bleeding, non-expiring WALL, while Vanish stayed the fixed-duration,
 *  no-cost dodge it always was in spirit — sharing one mechanic would have
 *  made Vanish bleed mana it was never supposed to. "Vanished" and
 *  "Walled" read the same to isProtected, but are tracked and priced
 *  separately now. */
export const VANISH_COST = 1;

/** How many of the mover's own turns a Vanish lasts before expiring
 *  (ticked by tickVanishForNewTurn, its own map since 2026-09-17 — see
 *  VANISH_COST's doc) — started equal to BULWARK_TURNS (2), Bulwark's own
 *  already-validated plain-cast lifetime before the wall rework retired
 *  that constant, rather than guessing a fresh number; no "reinforced"/
 *  saves tier for Vanish (unlike old Bulwark) since the user didn't ask
 *  for that extra complexity and Warrior's own reinforced tier was itself an
 *  optimization added after simulation, not a day-one requirement.
 *  STARTING VALUE, not yet sim-tuned for the reworked kit. */
export const VANISH_TURNS = BULWARK_TURNS;

/** Rogue's Backstab (RESTORED 2026-09-13, user's call, on the 4-bank):
 *  a guaranteed execute at one enemy stone in shared water. Pierces Ward by
 *  construction (nothing in its pool or apply path checks isWarded — the
 *  "pierce by omission" idiom Charged Shot uses); does NOT pierce a shield
 *  tile, a Bulwark or a Vanish (excluded from the pool outright), and a
 *  blessed victim is WOUNDED, not killed. Ends the turn, breaks the streak.
 *
 *  HISTORY: this is the 2026-07-21 broad version. It first shipped WITH a
 *  send-home refund and blew out 62-76% rogue-favored (backstab/g 10-16);
 *  with the refund removed it landed near even vs archer/mage/cleric but
 *  ~62% vs warrior/necromancer. It was then narrowed into a middle-shield
 *  breaker, which crashed the class to 23-42% everywhere, and retired for
 *  Vanish (d1ee4f8). It comes back BROAD, on top of Vanish, because the
 *  4-bank changed the economy it was priced in: at cap 2 it was the whole
 *  purse; at cap 4 it is half, competing with Pickpocket and Vanish for
 *  the same mana. No refund on a real kill (see applyBackstab) — that rule
 *  was the whole first balance fix and stays. Larceny's drain applies on
 *  the kill like any other. STARTING PRICE; 3 is the next stop if the
 *  matrix says the rogue over-corrects. */
export const BACKSTAB_COST = 4;
/* 2 -> 3 after the first matrix at 2: rogue 58.8% vs the field (66% vs
 * warrior, backstab/g 8.2) — the same warrior/necromancer overshoot the
 * July trace recorded. At 3 a Backstab is most of the purse again. */

/** Warlock's DARK BARGAIN (passive, free, 2026-09-16 — replaces Blood Pact
 *  as the class passive at the user's direction): when an ENEMY would kill
 *  one of the warlock's stones below ultimate tier, the stone instead
 *  steps back DARK_BARGAIN_RETREAT tile along its own path and the
 *  warlock's LEAST-ADVANCED other on-board stone is taken in its place.
 *  That stand-in's death pays the warlock BLOOD_PACT_CHARGES (the old
 *  pact's income survives only as the bargain's payout — a plain death
 *  the fiend refused pays nothing). The bargain is struck only when the
 *  price is cheaper than the loss: the stand-in must stand STRICTLY BEHIND
 *  the stone it saves (so it always preserves progress, never spends it),
 *  the retreat tile must be free (the stand-in itself may be the one
 *  vacating it — "takes its place" literally), and the stone must be the
 *  warlock's own to lose (a body possessed by an enemy necromancer is the
 *  necromancer's loss). No per-turn cap: every trigger costs a real stone
 *  and the strictly-behind rule bounds it by construction (a Warrior
 *  sweep that kills two runners can cost two rear stones — the same two
 *  deaths, better-chosen). Ultimates take what they want (roster
 *  convention — Blink Strike, Rain of Arrows, Grand Heist, Fel
 *  Storm, Wild Hunt, Bloodbath all bypass it (Shield Wall/Benediction never
 *  kill, so the question doesn't arise); a Bard march that lands on
 *  a warlock stone — Song of Haste or Crescendo — is an ordinary landing
 *  capture and DOES bargain), and the
 *  warlock's own Sacrifice is suicide, never a bargain (killer === owner).
 *  Ordering vs Rogue's Larceny is unchanged from the pact: the drain
 *  resolves FIRST, then the bargain pays. Every sub-ultimate kill path
 *  runs applyDarkBargain where it used to run grantBloodPact; the
 *  attacker's own income (capture charge, Soul Harvest bounty, Larceny)
 *  is untouched — a stone still died — but a necromancer's corpse and
 *  grave follow the stone that ACTUALLY died (the stand-in, on its own
 *  tile). Statuses the kill hooks stripped from the saved stone (wound,
 *  curse, freeze, inspiration) are restored: it did not die.
 *
 *  FIRST BALANCE PASS (1000/matchup, warlock vs field; Blood Pact design
 *  48.0%): retreat 1 payout 1 = 53.2% (bargain/g 5-24, archer matchup
 *  66-70% warlock — the archer's kit is all kills and every kill on a
 *  runner now lands on a cheap rear stone); retreat 1 payout 0 = 53.0%
 *  (the payout is nearly inert — generic capture income already fills a
 *  4-cap bank — so the swap IS the passive); retreat 2 payout 1 = 51.0%
 *  but bargain/g ROSE to 21 vs archer (a runner thrown two back gets hit
 *  again) and archer stayed 66%. Shipped retreat 1 / payout 1: the user's
 *  literal "move back a space", and the archer number is partly the sim's
 *  (a bot archer keeps killing runners; a human aims at the rear stones
 *  or saves Rain of Arrows, which bypasses the bargain). Known bot gap:
 *  attacker scoring still prices a capture of a bargainable runner as a
 *  full kill. */
export const BLOOD_PACT_CHARGES = 1;
/** How far the saved stone steps back along its own path. 1 = it ends
 *  directly behind whatever killed it, in flip-1 revenge range. */
export const DARK_BARGAIN_RETREAT = 1;
/** THE ARCHER LEVER (2026-09-17, playtest protocol): when true the fiend
 *  intervenes only when an enemy stone physically LANDS on the warlock's
 *  servant — ranged and indirect kills (Push and Charged Shot send-homes,
 *  Snipe, a Charge sweep, Corpse Explosion, Backstab, Sacrifice, Piercing
 *  Shot, Reckless Swing, Whirlwind, a sprung trap, the wolf) send home
 *  for real. Why: the archer's whole win condition is the ranged send-home
 *  and the bargain converts every one of them into a rear-stone kill plus
 *  a one-tile retreat — archer vs warlock sat at 27/73, the roster's one
 *  matchup outside 35/65, and teaching the bot archer to decline those
 *  shots only made it worse (see scoreMove). Flavour and math agree:
 *  the fiend answers a blade, not an arrow. The trap the protocol names:
 *  landing-vs-ranged is a property of every capture, so this also frees
 *  the necromancer's blast and the hunter's shot from the bargain — kept
 *  pure on purpose; a Necro/Warlock inflation is its own ticket, not a
 *  veto. SHIPS ONLY after playtest Test 1 confirms the 27/73 is
 *  structural (a human archer can find no non-trading line); until then
 *  the flag stays false and the sim measurement below is the record.
 *
 *  MEASURED 2026-09-17, flag flipped to true locally, 1000/matchup, then
 *  restored to false. Warlock's win% against each class, baseline (flag
 *  off) -> lever: archer 71.9->68.4 (i.e. archer 28.1->31.6 — climbing
 *  toward the 35 bar but not over it at this sample size), mage 49->51,
 *  warrior 62->57, necro 40->39 (flat — the watched Necro/Warlock cell did
 *  NOT inflate), cleric 45->53, rogue 63->51 (rogue's Backstab is ranged;
 *  it now lands for real and rogue stops feeding the bargain), hunter
 *  48->54, barbarian 56->55, bard 44->59. Field-wide: warlock 54.7->51.2,
 *  archer 45.7->46.5. WHOLE-GRID RESULT: zero matchups outside 35/65 (was
 *  one — this cell). No Warlock matchup crossed ~65 the wrong way. Read:
 *  a clean, ship-CANDIDATE batch by the pre-committed rule — but ships
 *  only when Test 1 says the 27/73 is structural, not on this number
 *  alone. */
export const DARK_BARGAIN_LANDING_ONLY = false;
/** How a kill reached the victim — the only thing DARK_BARGAIN_LANDING_ONLY
 *  reads. "landing" = the killer's stone ends its move on the victim's tile
 *  (a landing capture, a Bard march). Everything else is "ranged". */
export type KillDelivery = "landing" | "ranged";

/** The bargain a warlock struck most recently THIS turn — announcement
 *  state for the client (proc + activity log), cleared by
 *  tickDarkBargainForNewTurn at every fresh flip. */
export interface DarkBargain {
  savedTokenId: number;
  from: number;
  to: number;
  sacrificedTokenId: number;
  sacrificedFrom: number;
}

/** Warlock's Curse of Chains: mana cost of marking one enemy stone in
 *  shared water. Keeps the turn (Re-flip/Bless/Pickpocket's contract) —
 *  hex first, then still make your move. */
export const CURSE_COST = 1;

/** How many of the VICTIM's turn-starts the curse survives — ticked on
 *  every fresh flip dealt to the victim (tickCurseForNewTurn, the
 *  tickThrallForNewTurn convention exactly: decrement at turn start,
 *  gone when it hits 0, so N=3 means the chains bind for the victim's
 *  next TWO turns). Extra turns from shield landings burn a curse turn
 *  too, same self-balancing trade the thrall's doc describes. STARTING
 *  VALUE, not yet sim-tuned. */
export const CURSE_TURNS = 3;

/** How many tiles the curse shaves off every move the cursed stone makes —
 *  at 1, a flip of 1 leaves the stone unable to move at all, and an exact
 *  escape needs one more pip than usual. Nothing else in the game modifies
 *  move DISTANCE (knockbacks move a resting stone; this bends the flip
 *  itself), which is the design space the class claims. Applied per-token
 *  inside getLegalPowerMoves — the victim's OTHER stones move normally. */
export const CURSE_SLOW = 1;

/** Warlock's Sacrifice: the full-bank cast (Charged Shot / Reinforced
 *  Bulwark / Bless's spend pattern) that sends the warlock's own
 *  MOST-ADVANCED on-board stone home (auto-selected — Blink Strike's
 *  convention, keeping the one-tap targeting UI; WHICH stone was
 *  a load-bearing balance choice, see applySacrifice's doc) to kill one
 *  enemy stone in shared water THROUGH Ward and Blessing — a full kill,
 *  never a Cleric wound. Bulwark, Vanish, and shield tiles still block it:
 *  this is the MAGICAL half of the defense roster pierced below ultimate
 *  tier; Barbarian's kit (pass 4) gets the physical half, and neither tool
 *  answers everything — that split is load-bearing for the whole
 *  four-class expansion, do not widen either side.
 *
 *  ECONOMY (corrected 2026-07-26 after the first balance run): the kill
 *  banks NOTHING — no capture charge (Corpse Explosion's desecrate
 *  precedent, the ritual pays in blood not mana) — AND Blood Pact does not
 *  pay for the sacrificed stone either. The design as first planned had
 *  the pact refunding that death, on the reasoning that the net price
 *  would be "SACRIFICE_COST minus BLOOD_PACT_CHARGES plus a stone's whole
 *  run." That arithmetic was wrong in practice and the sim caught it: a
 *  class's own income passive refunding its own spend makes the spend
 *  nearly free, and the run being thrown away was near-zero too while the
 *  cast auto-selected the rearmost stone. Both halves are now closed (see
 *  applySacrifice) and the real price is the full bank plus the lead
 *  runner. Ends the turn, breaks the shield streak (Push's precedent — an
 *  attack, not a placement). */
export const SACRIFICE_COST = 2;

/** Warlock's Fel Storm ultimate: the contested-row position every enemy
 *  stone in shared water is dragged back to — the whole row collapses onto
 *  this tile and stacks BACKWARD from it (4, then 3, 2, ... down the
 *  victim's own path), most-advanced victim placed first so the pack keeps
 *  its relative order. Through ALL protection (Ward, Bulwark, Vanish,
 *  Blessing, shield tiles — the ultimate convention; a dragged stone keeps
 *  its Bulwark/Blessing, it never died). Board-wide displacement is the
 *  mechanical space no other ultimate occupies — the existing five are
 *  teleport-captures, a random strike, a mass self-buff, and a
 *  win-condition reach. Never kills by construction (the walk always finds
 *  a tile — at most 4 victims + 1 blocker across 5+ slots) EXCEPT a
 *  thrall walked below tile 4, which crumble-dies by the existing
 *  chained-to-the-row rule (computeKnockbackLanding's precedent). 4 = the
 *  first contested tile: the gentlest phrasing of "start the gauntlet
 *  over," and sim-adjustable downward never being possible (private lanes
 *  are the victims' own), only the pile order is tunable. */
export const FEL_STORM_RETURN_POSITION = 4;

/** Hunter's Wolf Companion (passive, free, added 2026-07-26): the hunter's
 *  MOST-advanced on-board stone is the wolf (see wolfGuardTile — it shipped
 *  least-advanced, this comment lagged), and it guards the contested
 *  tile directly ahead of itself — an enemy that LANDS there is knocked
 *  back this many tiles along its own path. Snipe's shape aimed the other
 *  way: Snipe is a free capture the archer takes on its OWN turn, this is a
 *  free shove the hunter's board position takes on the ENEMY's. Deliberately
 *  a knockback rather than a capture — a passive that costs nothing and
 *  fires on someone else's turn should not be the roster's cheapest kill.
 *  Standard collision math (computeKnockbackLanding), so a blocked landing
 *  is a send-home, which IS the passive's rare big moment. Respects every
 *  protection (isProtected): a warded/bulwarked/shield-tile enemy walks past
 *  the wolf untouched. */
export const WOLF_BITE_DISTANCE = 1;

/** Does the wolf CAPTURE what it catches, or merely shove it?
 *
 *  Capture, and this was the pass's decisive fix. The passive first shipped
 *  as a WOLF_BITE_DISTANCE knockback on the reasoning that "a free passive
 *  firing on someone else's turn shouldn't be the roster's cheapest kill" —
 *  but Archer's Snipe is precisely a free passive capture, and the wolf is
 *  strictly more avoidable than Snipe is: it guards ONE announced tile
 *  (wolfGuardTile is public board truth) and only bites a stone whose owner
 *  CHOSE to land there, where Snipe is aimed by the archer at a victim with
 *  no say. The knockback version left the hunter with a kit that was 100%
 *  denial and 0% tempo — the failure this file has now recorded four times
 *  (the old necromancer attrition kit, the cleric's first pass, Bulwark's
 *  own trace, and this): in a RACE, delaying the opponent does not advance
 *  you, so every mana spent on denial is a mana the opponent simply
 *  out-runs. See TRAP_BOUNTY for the other half of the same correction. */
export const WOLF_CAPTURES = true;

/** What a sprung trap pays its SETTER, in charges. The hunter's income
 *  engine and the second half of the denial-to-tempo fix above: without
 *  it, Snare converted mana into nothing but the opponent's inconvenience
 *  at a miserable rate (measured: 12.9 snares per game producing 2.3
 *  springs, of which 0.49 sent anyone home — the rest of that mana simply
 *  evaporated). Paying on the SPRING rather than the placement is what
 *  keeps it honest: a trap the enemy successfully routes around still
 *  costs the hunter full price, so good placement is the skill the ability
 *  rewards. Runs through addCharge, so it caps at CHARGE_CAP like all
 *  generic income. Deliberately paid even when the victim's armour absorbs
 *  the throw — the trap did its job by being stepped in. */
export const TRAP_BOUNTY = 1;

/** Hunter's Snare: mana cost of setting a trap. Keeps the turn (Curse /
 *  Bless / Pickpocket's contract) — set the trap, then still make your
 *  move, which is what makes a trap a piece of board development rather
 *  than a whole turn spent on a maybe. */
export const SNARE_COST = 1;

/** How far a sprung trap throws its victim back along its own path.
 *  Bigger than the wolf's nip (the trap cost mana and a placement) but
 *  short of Charged Shot's 4 — an archer's full-bank shot should still be
 *  the biggest single knockback in the game. */
export const TRAP_KNOCKBACK = 2;

/** Hunter's Piercing Shot: the full-bank cast (Charged Shot / Sacrifice's
 *  spend pattern). The hunter's most-advanced stone looses an arrow down
 *  the contested row and takes the FIRST enemy stone ahead of it, at any
 *  range — the class's only real removal, and the reason it can win a race
 *  at all.
 *
 *  REPLACED HAMSTRING (a full-bank 2-turn freeze on one stone) after the
 *  first balance run, which the original plan pre-authorised. The reason
 *  turned out not to be the predicted one ("miserable to play against") but
 *  something this file has now recorded five times: DENIAL DOES NOT WIN
 *  RACES. The shipped Hunter was 100% denial — wolf shove, trap shove,
 *  freeze, freeze-plus-one-kill — so every mana it spent bought the
 *  opponent a delay and the hunter nothing, and it lost 60-81% to the whole
 *  field. Paying the traps and letting the wolf capture (see TRAP_BOUNTY /
 *  WOLF_CAPTURES) recovered ~6 points; the rest needed an actual offensive
 *  spend, because pausing ONE of four stones for two turns is close to
 *  worthless at any price. Freeze survives as Wild Hunt's ultimate-only
 *  effect, which is where an effect that strong and that un-counterable
 *  belongs anyway. The bow in the portrait was always the better read. */
/* 3 since 2026-09-16 (was 2, the full bank of the 2-cap era). The bot
 * hunter had been re-laying Snare on ~30 turns a game — one mana each,
 * moving the trap a tile at a time — which quietly burned the income this
 * shot needed. Once scoreSnare priced a re-lay by its IMPROVEMENT over
 * the armed trap (master-killer-bot.ts), the trap stayed put and sprang
 * more (5.2 -> 6.2/game), the saved mana went here (1.4 -> 4.2 shots/game)
 * and the hunter jumped 49 -> 59% vs the field: the spam had been masking
 * an overtuned kit. Sweep (1000/matchup): cost 3 = 50.9%, cost 4 = 46.0%,
 * SNARE_COST 2 instead = 58.0% (the trap is not the problem). */
export const PIERCING_SHOT_COST = 3;

/** Hunter's Wild Hunt ultimate: every trap in the world snaps shut at once
 *  — every enemy stone in shared water is frozen for this many of its
 *  owner's turn-starts, and the wolf takes the nearest one through every
 *  protection there is. ONE turn, and freeze is now an ultimate-only
 *  effect: the mortal-tier freeze this constant was originally the shorter
 *  counterpart to (Hamstring) was cut after the first balance run — see
 *  PIERCING_SHOT_COST. A board-wide multi-turn freeze would simply end
 *  games on the spot, which is why the breadth is paid for in duration. */
export const WILD_HUNT_FREEZE_TURNS = 1;

/** Barbarian's Rage (passive, free, added 2026-07-27): how many extra tiles
 *  the barbarian's every move gets when they are DOWN stones relative to
 *  their opponent — one per stone of deficit, capped here. The roster's
 *  only comeback mechanic and its only upward modifier of the mover's own
 *  stride (Curse of Chains bends it the other way; the two compose
 *  additively — see getLegalPowerMoves).
 *
 *  THE DEFICIT, NOT THE RAW RESERVE COUNT, and the first balance run is why.
 *  Rage first shipped as "one per own stone in reserve", on the theory that
 *  reserve = losses. It is not: at the opening BOTH players have all four
 *  stones home, so the barbarian simply got a free +2 on every move for the
 *  whole development phase — a permanent head start wearing a comeback
 *  mechanic's clothes. It took 67-86% off the entire field (archer 84.6,
 *  rogue 86.2, warlock 82.2) while its three ACTIVES fired at perfectly
 *  healthy rates (reckless 1.1/g, whirlwind 0.8/g, bloodbath 0.27/g) — the
 *  tell that the passive was the whole problem. Measuring own-reserve MINUS
 *  foe-reserve makes it zero at the opening, zero whenever the barbarian is
 *  ahead, and positive exactly when they are behind, which is what the
 *  design was always supposed to say. */
export const RAGE_MAX = 2;

/** How many stones of deficit the barbarian eats before Rage pays anything.
 *  Zero: being down even one stone stokes it. The tuning that made this
 *  workable lives in RAGE_SCOPE below, not here. */
export const RAGE_FREE_DEFICIT = 0;

/** WHICH of the barbarian's stones Rage speeds up — and this is the dial
 *  that finally made the passive tunable at all.
 *
 *  THE TUNING TRACE, 400-500 games/matchup, everything else held fixed.
 *  Rage began as a flat bonus on EVERY move the barbarian made, and at that
 *  scope it is an enormous, un-dialable lever in a race:
 *    all stones, RAGE_MAX 2, raw reserve count ... 67-86% (broken; the raw
 *      count also meant a free opening burst — see RAGE_MAX's own doc)
 *    all stones, RAGE_MAX 2, deficit-based .......  45-71% (over)
 *    all stones, RAGE_MAX 1, deficit-based .......  42-74% (over)
 *    all stones, RAGE_MAX 0 (rage off) ...........  23-51% (badly under —
 *      the three actives cannot carry the class alone)
 *    all stones, first deficit free ..............  26-58% (under)
 *  The class swings ~25-30 points between "no rage" and "one tile of rage
 *  on everything", with no integer stop in between, and gating on a bigger
 *  deficit overshot the other way because a two-stone hole is rare.
 *
 *  Narrowing the SCOPE is the missing granularity: the bonus keeps its full
 *  uptime (any deficit at all) but touches one stone instead of four. The
 *  stone it touches is the LEAST-advanced — counting reserve as least — so
 *  in practice it is whichever stone just died coming back angry, which is
 *  both the tightest fit to "comeback" and the best picture the passive
 *  has. */
export type RageScope = "all" | "least-advanced";
export const RAGE_SCOPE: RageScope = "least-advanced";

/** Barbarian's Reckless Swing: mana cost of the adjacent strike on an
 *  unprotected enemy. HISTORICAL: until 2026-09-17 this pierced Bulwark
 *  and Vanish — the "physical half" of a defence-piercing split with the
 *  Warlock's Sacrifice (which pierced Ward and Blessing, the "magical
 *  half") — but walls are absolute now and every bespoke breaker retired
 *  with them, Sacrifice's included. A real identity loss for both casts,
 *  flagged rather than patched around; the sim decides whether either
 *  needs a new lever. */
export const RECKLESS_SWING_COST = 1;

/** What the swing costs the SWINGER: its own stone is thrown this many
 *  tiles backwards along its own path, standard collision math (a blocked
 *  landing is a send-home — recklessness can genuinely kill you). This is
 *  the whole price of a Bulwark-piercing kill at 1 mana, so it must stay
 *  meaningful; the Warlock's Sacrifice pays a whole stone for the magical
 *  equivalent. */
export const RECKLESS_SELF_KNOCKBACK = 2;

/** Barbarian's Whirlwind: the full-bank spin. Every enemy within
 *  WHIRLWIND_RADIUS of ANY of the barbarian's on-board stones, anywhere on
 *  the contested row, is caught: up to WHIRLWIND_CAP of them are captured
 *  and the rest are knocked back 1. Radial and stationary, where Warrior's
 *  Charge is a lane the warrior moves along. The capture cap deliberately
 *  matches CHARGE_SWEEP_CAP's own principle — no class's single move should
 *  out-capture the others by more than one extra — with the knockbacks as
 *  the compensation for the breadth. Respects every protection (isProtected):
 *  this is a wide swing, not a piercing one. */
export const WHIRLWIND_COST = 2;
export const WHIRLWIND_RADIUS = 1;
export const WHIRLWIND_CAP = 1;

/** RETIRED 2026-09-18 (Rework III) — "Extended Charge," the historical name
 *  for Bloodbath's ORIGINAL mechanic: the lead stone charged to the END of
 *  shared water, taking every enemy in its path through every protection
 *  there is (the uncapped version of Charge). Replaced outright, not kept
 *  alongside — Bloodbath now runs Warpath's exact teleport-and-sweep
 *  mechanic instead (see applyBloodbath), ported wholesale from the
 *  Warrior after Warpath's own 2026-09-17 retirement. This constant is
 *  dead; nothing reads it any more. Kept only as the changelog marker for
 *  where Extended Charge's one defining number used to live. */
export const EXTENDED_CHARGE_RETIRED = true;

/** Bard's Encore (passive, free, added 2026-07-27): what a ZERO FLIP pays a
 *  bard, instead of the usual 1. The class's income engine, and the thing
 *  that makes a buff-stacking kit affordable at all — every other class
 *  treats a dead flip as a consolation charge, the bard turns it into the
 *  next verse. Nothing else in the game modifies the zero-flip grant, so
 *  this is scoped by construction. */
export const ENCORE_ZERO_FLIP_CHARGES = 2;

/** The bard's charge cap — deeper than everyone else's CHARGE_CAP, and the
 *  fix that made the class function at all.
 *
 *  A buff-stacking kit needs a purse it can stack OUT OF. The first balance
 *  run had the bard on the standard 2-charge bank and it collapsed to
 *  18-40% against the field with the mirror stalemating 28% of games at the
 *  turn cap: Inspire (1 each) and Song of Haste (the full bank) were
 *  competing for the same two charges, so the bard spammed the cheap buff
 *  and could never afford the payoff — measured inspire/g 18-48 against
 *  haste/g 2.2, with each song marching only ~1.4 stones. Neither half of
 *  the kit ever ran.
 *
 *  Unlike NECRO_CHARGE_CAP — whose third pip is a SOUL GEM only
 *  grantKillBounty can reach — this raises the cap for ordinary income too
 *  (see chargeCapFor/addCharge): the bard's whole design is having mana to
 *  spread, and gating it behind a special income source would just recreate
 *  the starvation. Safe by construction against the other classes' full-bank
 *  gates: Ward, Charged Shot and Reinforced Bulwark all test CHARGE_CAP and
 *  are class-locked to mage/archer/warrior, so none of them can ever see
 *  this number. */
export const BARD_CHARGE_CAP = 4;

/** Bard's Inspire: mana per stone. Deliberately the cheapest active in the
 *  game, because the kit's whole identity is having SEVERAL stones lit at
 *  once (the user's brief: "I want the bard to be able to buff a lot") —
 *  there is no cap on how many stones may carry it, only what the bank can
 *  fund. Keeps the turn (Re-flip / Bless / Curse / Snare's contract), so a
 *  bard with a full bank can light two stones and still move. */
export const INSPIRE_COST = 2;

/* INSPIRE_COST IS THE CLASS'S BALANCE LEVER — found last, after everything
 * else turned out to be nearly inert. Once the exact-escape bug and the
 * can't-escape-on-a-march bug were fixed (see getLegalPowerMoves and
 * advanceStones), the bard sat at 48-81% and every obvious dial barely
 * moved it, measured at 300-400 games/matchup:
 *     bank 4 -> 3 ............ ~3 points
 *     march 2 tiles -> 1 ..... ~1 point
 *     Song of Haste 2 -> 3 ... ~1 point
 *     adding INSPIRE_CAP=2 ... ~1 point
 *     Encore 2 -> 1 .......... ~5 points
 * The overtuning was spread thinly across all of them, which is the shape
 * you get when the CORE effect is underpriced rather than any one rider
 * being wrong. Doubling the buff's own price did in one step what five
 * other levers could not: 55.0 archer, 44.8 warrior, 53.3 necromancer,
 * 46.5 cleric, 54.5 rogue, 56.3 warlock, 51.2 hunter, 50.5 barbarian,
 * 47.8 mirror — eight of nine matchups inside 35/65 and most within a few
 * points of even. (Only mage-vs-bard sits outside at 67.3/32.8, the same
 * roster-wide Mage thread every other class in this expansion also runs
 * into; do not chase it with bard levers.)
 *
 * BARD_CHARGE_CAP was then restored to 4 with the cost held here: it kept
 * every number in range while giving the class back the room to actually
 * stack buffs, which is the brief. */

/** How many extra tiles an inspired stone moves.
 *
 *  ONE, and the Barbarian's Rage trace two passes earlier is exactly why —
 *  that pass measured a flat per-move stride bonus as worth ~25-30 points
 *  of win rate at +1 across a whole army, with no integer stop below it.
 *  Rage had to be narrowed to a single stone to become tunable at all. The
 *  bard deliberately buys the un-narrowed version, several stones at once,
 *  which is the same lever pointed the other way — so the magnitude stays
 *  at the floor and the ECONOMY (one mana per stone, a duration that
 *  expires, and a bank that only refills on zero flips and the usual
 *  income) is what does the limiting. Do not raise this without re-running
 *  the whole matrix. */
export const INSPIRE_BONUS = 1;

/** Whether an inspiration EXPIRES on its own.
 *
 *  CURRENT VALUE: false — inspirations DO expire, after INSPIRE_TURNS of the
 *  bard's turn-starts (tickInspireForNewTurn runs), and the balance matrix
 *  the roster ships on was run with that countdown ON. The trace below
 *  records the permanent-until-death experiment this flag was added for.
 *
 *  The experiment's reasoning, kept for the next person who reaches for it:
 *  a lit stone stays lit until it dies, the Cleric's blessing
 *  model rather than the curse/freeze countdown model. It shipped as a
 *  3-turn countdown and that was the class's second structural failure
 *  (after the exact-escape overshoot; see getLegalPowerMoves): buffs faded
 *  faster than a 4-charge bank could lay them down, so the board was never
 *  more than one or two stones lit, and Song of Haste — which SPENDS THE
 *  WHOLE TURN, replacing the mover's own flip — was worth less than simply
 *  moving. Measured: inspire/g 18-48 against haste/g 2.2, each song
 *  marching ~1.5 stones. Cheapening the song made it strictly worse
 *  (7-21%, 65% mirror stalemates) because the bot then traded good flips
 *  for bad marches.
 *
 *  Persistent-until-death makes Inspire a one-time investment per stone —
 *  four mana lights the whole army for good — which is what "buff a lot"
 *  has to mean for the payoff to ever be worth a turn. The counterplay is
 *  the honest one: killing a lit stone strips the buff with it
 *  (clearInspireOnCapture), so the opponent can un-do the investment. */
export const INSPIRE_PERMANENT = false;

/** How many of the bard's stones may carry an inspiration AT ONCE — Bless's
 *  BLESSING_CAP in every respect, including that only the ULTIMATE
 *  (Crescendo) may exceed it.
 *
 *  THE CLASS'S MAIN BALANCE LEVER, found by elimination. With escapes fixed
 *  the bard was 48-81% and the obvious dials all turned out to be nearly
 *  inert: the bank 4 -> 3 moved it ~3 points, the march 2 tiles -> 1 moved
 *  it ~1. What actually carries the class is INSPIRE itself, which is the
 *  Barbarian's Rage finding restated — a +1 stride is worth ~25-30 points
 *  when it applies broadly, and Rage had to be narrowed to a single stone
 *  for exactly this reason. The bard is allowed the wide version, so the
 *  COUNT is where it gets priced. Two lit stones is still "a lot" beside a
 *  roster where nobody else buys movement at all, and Crescendo's
 *  army-wide light stays the thing that feels like a crescendo. */
export const INSPIRE_CAP = 2;

/** The countdown an inspiration is stored with. Inert while
 *  INSPIRE_PERMANENT is true (tickInspireForNewTurn returns early), and
 *  kept as a real number so flipping that flag back is a one-line
 *  experiment rather than a schema change. */
export const INSPIRE_TURNS = 3;

/** Bard's Song of Haste: the full-bank payoff that cashes every inspired
 *  stone at once — each advances this many tiles immediately, no flip,
 *  capturing normally on landing. The reason to spread inspirations wide
 *  rather than keep one stone lit: the song scales with how much of the
 *  army is singing. Ends the turn.
 *
 *  BOUGHT MOVEMENT, NEVER AN EXTRA TURN — the one hard constraint carried
 *  down from the plan, and this file's two recorded catastrophes are why
 *  (Push-grants-extra-turn at 95/5, the necromancer's tile-12 placement at
 *  97.8/2.2). The stones move; the turn ends. */
export const HASTE_COST = 2;
export const HASTE_TILES = 2;

/** Bard's Crescendo ultimate: inspires the bard's ENTIRE on-board army for
 *  INSPIRE_TURNS and immediately advances every one of them this far — the
 *  whole kit fired at once, and the only way to light four stones without
 *  paying four mana. */
export const CRESCENDO_TILES = 3;

// ============================================================================
// TYPES
// ============================================================================

/** Every class the game KNOWS ABOUT — not every class you can pick. The
 *  four at the end (2026-07-26) have portraits and a full set of UI colours
 *  but no kit yet; they're built one at a time, and each one becomes
 *  selectable only when its abilities land. The shipped-and-playable subset
 *  is room-engine.ts's MK_CLASSES, which is what the class picker offers and
 *  what the CPU draws from — keeping the two lists separate is what lets a
 *  portrait ship ahead of its rules without ever handing a player an empty
 *  class. */
export type PlayerClass =
  | "archer"
  | "mage"
  | "warrior"
  | "necromancer"
  | "cleric"
  | "rogue"
  | "warlock"
  | "hunter"
  | "barbarian"
  | "bard";

export interface PowerState {
  classes: Record<PlayerId, PlayerClass>;
  /** Banked charges, 0..CHARGE_CAP, per player. */
  charges: Record<PlayerId, number>;
  /** How many Re-flips the Mage has fired THIS turn, 0..REFLIPS_PER_TURN
   *  (was a once-per-turn boolean, reflipUsedThisTurn, before the second
   *  banked charge earned a second re-flip). Reset whenever a fresh flip
   *  is dealt (a new turn, or after auto-skip). */
  reflipsUsedThisTurn: number;
  /** Consecutive shield-tile landings within one unbroken turn-chain, 0-2
   *  (fires/banks and resets to 0 the instant it would become
   *  ULTIMATE_STREAK). Shared by all three classes. Deliberately NOT reset
   *  by resetTurnFlags — that fires on every resolved turn, including the
   *  shield landing's own extra turn, which is exactly the turn this streak
   *  has to survive. Only cleared by resolveShieldStreak (a non-landing
   *  move/charge that ends the turn), applyPush (never lands the mover on a
   *  shield), or breakShieldStreak (called directly by the server's
   *  auto-skip paths, which resolve a turn-end without going through
   *  resolveTurn at all — same shape of problem zeroFlipChargeBefore in
   *  referee.ts/api/ws.ts already solves for the charge economy). */
  shieldStreak: Record<PlayerId, number>;
  /** True once a Mage or Warrior has completed the shield-streak combo —
   *  their ultimate (not yet built) is banked and spendable on a future
   *  turn of their choosing, unlike Archer's, which resolves immediately
   *  and never sets this. Persists indefinitely until spent: never touched
   *  by resetTurnFlags, and not yet consumed by anything (no ultimate
   *  action exists yet), so it just sits true once earned. */
  ultimateReady: Record<PlayerId, boolean>;
  /** THE WALL (2026-09-17 rework — Warrior's Bulwark and Cleric's Blessing
   *  collapse into one system): token id -> which wall it carries.
   *  Presence in the map means the token cannot be captured, shoved, or
   *  otherwise sent home by any NORMAL attack — no pierce, no bespoke
   *  breaker, only an ultimate reaches it (folded into isProtected/
   *  isWalled — see those). No countdown and no save-count: a wall is up
   *  for as long as its owner can pay WALL_BLEED for it every one of
   *  their own turns (tickWallUpkeepForNewTurn) — it falls the instant
   *  they can't, never by blocking a capture. Ward (the Mage's) is
   *  deliberately NOT a wall: it keeps its own full-bank threshold and
   *  never bleeds — see isWarded. Vanish (the Rogue's) is deliberately
   *  ALSO not a wall — see PowerState.vanished — a fixed-duration dodge,
   *  not a paid-for wall. Cleared on every reserve trip
   *  (clearWallsOnReserveTrip) so a wall never rides free protection back
   *  from the dead. */
  walls: Record<number, WallKind>;
  /** Rogue's Vanish: token id -> turns remaining before it expires — split
   *  off Bulwark's old shared map (2026-09-17) because Vanish stays a
   *  fixed-duration dodge under the wall rework, not a paid wall: it does
   *  not bleed mana and it does expire on its own. Ticked once per the
   *  VANISHED player's own fresh flip (tickVanishForNewTurn). Cleared on
   *  every reserve trip alongside walls. */
  vanished: Record<number, number>;
  /** Necromancer's corpse marker: the last QUALIFYING kill this player made
   *  (see SOUL_BOUNTY_CHARGES for what qualifies), remembered as the killed
   *  token and the contested tile it died on. Only ever populated for a
   *  necromancer. Overwritten by every newer kill (only the freshest corpse
   *  keeps its soul), consumed by Revive, and DEAD-LETTERED — not eagerly
   *  cleared — the moment the victim re-enters that token from reserve:
   *  Revive's legality (getReviveSpawnTile) lazily requires the corpse
   *  token to still be AT position -1, so re-entry is the denial counter-
   *  play without any extra clearing hook (the engine derives the DENIED
   *  announcement from the same condition). */
  corpse: Record<PlayerId, { tokenId: number; tile: number } | null>;
  /** Necromancer's grave (2026-09-16): the contested tile of the same last
   *  qualifying kill, remembered SEPARATELY from the body so the two rites
   *  stop being exclusive. Set alongside the corpse on every kill
   *  (overwritten by the freshest, like the corpse), left in place by
   *  Revive — raising the body leaves the open grave — and consumed only
   *  by Corpse Explosion, which detonates the ground, not the body. Never
   *  dead-lettered: the victim re-entering its token takes Revive away,
   *  not the mine. Before this split the blast needed the same raisable
   *  body Revive did, so every fresh corpse was a choice between a thrall
   *  that keeps the turn and a blast that ends it, and the blast measured
   *  0.03-0.2 casts per game. Only ever populated for a necromancer. */
  grave: Record<PlayerId, number | null>;
  /** Necromancer's active thrall: the possessed enemy token and how many of
   *  the necromancer's own turns it has left (see THRALL_TURNS). The token
   *  NEVER changes owner in GameState — possession is entirely this entry
   *  plus effectiveOwner()'s reading of it, threaded through every
   *  legality/targeting enumeration. At most one thrall per player by
   *  construction (a single slot, and Revive requires it empty). */
  thrall: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  /** Warlock's Curse of Chains (2026-07-26): the caster's single live curse
   *  — the afflicted enemy token and how many of the VICTIM's turn-starts
   *  it has left (see CURSE_TURNS). Keyed by the CASTER (the corpse
   *  convention): at most one curse per warlock, and a fresh cast simply
   *  re-aims it (the old mark lifts — you pay full price each time, so
   *  there's nothing to exploit). Only ever populated for a warlock.
   *  Ticked by tickCurseForNewTurn on the victim's fresh flips; cleared
   *  early when the cursed token is killed (clearCurseOnCapture — the
   *  reserve-trip hygiene every status gets) or escapes (resolveTurn — a
   *  stone that came home in glory drags no chains). */
  curse: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  /** Warlock's Dark Bargain struck this turn, per warlock (see DarkBargain).
   *  Transient: set by applyDarkBargain, cleared at the next fresh flip. */
  darkBargain: Record<PlayerId, DarkBargain | null>;
  /** Hunter's Snare (2026-07-26): each hunter's single armed trap, as the
   *  CONTESTED TILE INDEX it sits on — the game's only piece of persistent
   *  board state that isn't a stone. Keyed by the setter (the corpse/curse
   *  convention): one trap per hunter, and a fresh Snare re-sites it (the
   *  old trap is lifted — full price each time, nothing to exploit).
   *  PUBLIC to both seats by design: routing around a visible trap is the
   *  play, and hidden board state would break the both-clients-can-verify
   *  model this codebase is built on. Sprung (and cleared) by the first
   *  enemy stone to LAND on the tile — see the trap check in resolveTurn.
   *  Tile index only: contested tiles 4-11 are the same physical square in
   *  both players' numbering, so no owner disambiguation is needed. */
  /** Bard's Inspire (2026-07-27): token id -> the BARD's own turn-starts
   *  remaining on that stone's inspiration. Keyed by token rather than by
   *  caster (the curse's shape) precisely because the class is built to
   *  have SEVERAL lit at once — that is the kit's identity, not an edge
   *  case. Only ever populated for a bard's own stones. Ticked by
   *  tickInspireForNewTurn on the bard's fresh flips and cleared on a
   *  reserve trip (clearInspireOnCapture) like every other per-token
   *  status. */
  inspired: Record<number, number>;
  traps: Record<PlayerId, number | null>;
  /** Hunter's Hamstring / Wild Hunt (2026-07-26): token id -> the VICTIM's
   *  turn-starts remaining before the stone can move again. Unlike `curse`
   *  (one slot per caster) this is keyed by TOKEN, because Wild Hunt
   *  freezes the whole enemy row at once. A frozen stone is skipped
   *  entirely by getLegalPowerMoves; everything else about it is normal
   *  (it can still be captured, still blocks tiles, still carries its own
   *  protections). Ticked on the victim's fresh flips
   *  (tickHamstringForNewTurn) and cleared on a reserve trip
   *  (clearHamstringOnCapture) like every other per-token status. */
  hamstrung: Record<number, number>;
  /** Grace turns of waived wall upkeep, per player — Cleric's Vigil and
   *  Sanctified Ground grant it, Benediction and Warrior's Shield Wall
   *  spend it too (2026-09-17). Consumed by tickWallUpkeepForNewTurn
   *  BEFORE it charges anyone anything; 0/absent means no grace banked. */
  wallGrace: Record<PlayerId, number>;
}

/** THE WALL SYSTEM (2026-09-17 rework): a wall is any effect that makes a
 *  stone uncapturable except by an ultimate. Two kinds share the one rule
 *  and the one price (WALL_BLEED per turn, see wallUpkeepFor) — Warrior's
 *  Bulwark and Cleric's Blessing. Ward Breaker is retired: nothing pierces
 *  a wall below ultimate tier any more, which is the entire point — no
 *  more bespoke per-class breakers, no more "why does the Archer pierce
 *  these two defenses and not the others." */
export type WallKind = "bulwark" | "blessing";

/** Superset of rulebook.Move — same fields, plus power-derived ones. */
export interface PowerMove {
  tokenId: number;
  from: number;
  to: number;
  captures: number[];
  /** Archer Snipe: 0 or 1 extra captured token id, free of charge. */
  bonusCaptures: number[];
  landsOnShield: boolean;
  causesWin: boolean;
  /** RETIRED 2026-09-17 (Ward Breaker is gone; walls are absolute now) —
   *  always false. Kept on the type/wire so nothing downstream needs its
   *  own removal pass. */
  breaksWard: boolean;
  /** True if a Warrior could spend a charge to Charge through this move
   *  (from >= 0, clear lane of own tokens, at least implicitly meaningful
   *  even if chargeSweepCaptures ends up empty). */
  chargeAvailable: boolean;
  /** Precomputed: enemies on contested tiles strictly between from and to
   *  that a Charge would additionally capture. Only meaningful when
   *  chargeAvailable is true. */
  chargeSweepCaptures: number[];
}

export type PowerAction =
  | { kind: "move"; move: PowerMove }
  | { kind: "push"; targetTokenId: number }
  | { kind: "chargedShot"; targetTokenId: number }
  | { kind: "reflip" }
  /** Archer's Rain of Arrows (banked, aimed since 2026-09-16): one enemy in
   *  shared water, through everything — getRainOfArrowsTargets' pool. */
  | { kind: "rainOfArrows"; targetTokenId: number }
  | { kind: "charge"; move: PowerMove }
  | { kind: "blinkStrike"; targetTokenId: number }
  /** Warrior's Shield Wall ultimate (2026-09-17, replaces Warpath): no
   *  target — walls the warrior's whole on-board army. Benediction's exact
   *  twin, see getShieldWallTargets. */
  | { kind: "shieldWall" }
  /** Warrior's Bulwark: the reinforced tier retired 2026-09-13, before the
   *  wall rework — there is only the one 1-charge cast now. */
  | { kind: "bulwark"; tokenId: number }
  /** Necromancer's Revive: no target — the corpse (PowerState.corpse)
   *  fully determines what rises and where. Legality lives in
   *  getReviveSpawnTile, the drift-proof single source shared by the
   *  server's validation, the bot, and the client's gem gate. */
  | { kind: "revive" }
  /** Necromancer's Corpse Explosion: no target either — the marked corpse
   *  is the epicenter and getCorpseExplosionTargets is the shared oracle
   *  (empty pool = not castable). */
  | { kind: "corpseExplosion" }
  | { kind: "exhume"; targetTokenId: number }
  /** Cleric's Bless: raise a wall on one own stone (see BLESS_COST /
   *  PowerState.walls). Targets an OWN token, Bulwark's shape. */
  | { kind: "bless"; targetTokenId: number }
  /** Cleric's Vigil (2026-09-17, replaces Heal): no target — waives upkeep
   *  for every wall the caster already holds (canCastVigil is the shared
   *  oracle). */
  | { kind: "vigil" }
  /** Cleric's Benediction ultimate: no target — blesses the cleric's whole
   *  on-board army. getBenedictionTargets is the shared oracle (empty pool
   *  = nothing would change = not castable; a blessing that blesses no one
   *  is a misclick, not a choice). */
  | { kind: "benediction" }
  /** Rogue's Pickpocket: targets an enemy in shared water (see
   *  getPickpocketTargets) but the effect is bank-level, not stone-level —
   *  the target only anchors the UI's "tap a stone" flow. */
  | { kind: "pickpocket"; targetTokenId: number }
  /** Rogue's Backstab: a guaranteed execute at a target in shared water. */
  | { kind: "backstab"; targetTokenId: number }
  /** Mage's Blink: a TILE, not a token (Snare's shape) — the stone is
   *  server-selected (the mover's least-advanced on-board stone). */
  | { kind: "blink"; tile: number }
  /** Rogue's Vanish: targets one of the mover's own on-board stones, same
   *  shape as Bulwark's tokenId (see getVanishTargets/applyVanish). */
  | { kind: "vanish"; tokenId: number }
  /** Rogue's Grand Heist ultimate: teleport-capture like Blink Strike,
   *  plus draining the target owner's entire bank. */
  | { kind: "grandHeist"; targetTokenId: number }
  /** Warlock's Curse of Chains: targets an enemy in shared water (see
   *  getCurseTargets). Keeps the turn — Bless's commit contract. */
  | { kind: "curse"; targetTokenId: number }
  /** Warlock's Sacrifice: targets the enemy stone to kill; the warlock's
   *  own least-advanced stone is auto-selected as the price (Blink
   *  Strike's one-tap convention — see SACRIFICE_COST). */
  | { kind: "sacrifice"; targetTokenId: number }
  /** Warlock's Fel Storm ultimate: no target — the whole shared row is the
   *  target. getFelStormTargets is the shared oracle (empty pool = no one
   *  to drag = not castable, Benediction's misclick rule). */
  | { kind: "felStorm" }
  /** Bard's Inspire: targets one of the caster's OWN stones (Bulwark's
   *  shape). Several may carry it at once — see getInspireTargets. */
  | { kind: "inspire"; targetTokenId: number }
  /** Bard's Song of Haste / Crescendo: no target — every inspired stone
   *  (Haste) or the whole army (Crescendo) is the subject. */
  | { kind: "songOfHaste" }
  | { kind: "crescendo" }
  /** Barbarian's Reckless Swing: targets the enemy to kill; the striker
   *  (the barbarian stone directly behind it) is determined by the board,
   *  not chosen — see getRecklessSwingTargets. */
  | { kind: "recklessSwing"; targetTokenId: number }
  /** Barbarian's Whirlwind: no target — every enemy in reach is caught. */
  | { kind: "whirlwind" }
  /** Barbarian's Bloodbath ultimate (2026-09-18, Rework III: Warpath's
   *  mechanic ported wholesale after the Warrior's own retirement) —
   *  targets an enemy in shared water; the mover's own least-advanced
   *  stone is auto-selected as the one that teleports, Blink Strike's
   *  one-tap convention. See getBloodbathTargets/applyBloodbath. */
  | { kind: "bloodbath"; targetTokenId: number }
  /** Hunter's Snare: the only action in the game that targets a TILE
   *  rather than a stone (see getSnareTiles). */
  | { kind: "snare"; tile: number }
  /** Hunter's Hamstring: targets an enemy in shared water. */
  /** Hunter's Piercing Shot: no target — the arrow's path decides who it
   *  hits (see piercingShotVictim). */
  | { kind: "piercingShot" }
  /** Hunter's Wild Hunt ultimate: no target — the whole row freezes and
   *  the wolf picks its own quarry (getWildHuntTargets is the oracle). */
  | { kind: "wildHunt" };

// ============================================================================
// STATE
// ============================================================================

export function initialPowerState(): PowerState {
  return {
    classes: { p1: "archer", p2: "archer" }, // placeholder until picked
    charges: { p1: 0, p2: 0 },
    reflipsUsedThisTurn: 0,
    shieldStreak: { p1: 0, p2: 0 },
    ultimateReady: { p1: false, p2: false },
    walls: {},
    vanished: {},
    wallGrace: { p1: 0, p2: 0 },
    corpse: { p1: null, p2: null },
    grave: { p1: null, p2: null },
    thrall: { p1: null, p2: null },
    curse: { p1: null, p2: null },
    darkBargain: { p1: null, p2: null },
    inspired: {},
    traps: { p1: null, p2: null },
    hamstrung: {},
  };
}

/** Called once each turn a fresh flip is dealt (new turn or post-skip). */
export function resetTurnFlags(power: PowerState): PowerState {
  return { ...power, reflipsUsedThisTurn: 0 };
}

/** THE Re-flip legality gate, shared by the server's validation, the bot,
 *  and the client's button so the three can never drift: another Re-flip is
 *  legal as long as the Mage can still pay for it (2026-09-17, Zach's add —
 *  the old per-turn cap is gone; REFLIPS_PER_TURN survives only as the
 *  sim loops' own safety bound, see its doc). (Class gating stays at the
 *  call sites — this answers "may THIS mage re-flip again," not "is this
 *  player a mage.") */
export function canReflipAgain(power: PowerState, mover: PlayerId): boolean {
  return power.charges[mover] >= REFLIP_COST;
}

/** Which player's thrall this token currently is — null when unpossessed.
 *  The id-level primitive under effectiveOwner, exported for the engine's
 *  broadcast/announcement derivations. */
export function possessorOf(power: PowerState, tokenId: number): PlayerId | null {
  if (power.thrall.p1?.tokenId === tokenId) return "p1";
  if (power.thrall.p2?.tokenId === tokenId) return "p2";
  return null;
}

/** THE possession rule (Revive rework, 2026-07-19): for every LEGALITY and
 *  TARGETING question, a possessed token counts as its possessor's — the
 *  necromancer can move it and stack-blocks against it; the victim's own
 *  army can capture it (a mercy kill that earns the standard charge); the
 *  opponent's Snipe/Charged Shot/Push/sweep all treat it as the
 *  necromancer's stone. Real `token.owner` remains authoritative for
 *  everything PHYSICAL and PERMANENT: win counting, which reserve it
 *  crumbles back to, whose lane its private indices name, and same-tile
 *  collision physics (contested indices 4-11 — the only tiles a thrall can
 *  occupy — are the same square for both numberings anyway). */
export function effectiveOwner(power: PowerState, token: TokenState): PlayerId {
  return possessorOf(power, token.id) ?? token.owner;
}

/** On-board only (0 <= position < PATH_LENGTH_PER_PLAYER) — escaped tokens
 *  sit at position 15, which would otherwise always outrank real board
 *  positions and permanently (and pointlessly — an escaped token can't be
 *  captured) hog "most advanced", including multiple escaped tokens tying
 *  and warding simultaneously once more than one has come home. Possessed
 *  tokens are excluded on BOTH sides (as candidate and as pool): a token
 *  serving the enemy neither carries its true owner's Ward nor consumes
 *  the "most advanced" slot their free tokens compete for. */
function isMostAdvanced(state: GameState, power: PowerState, token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  if (possessorOf(power, token.id) !== null) return false;
  const mine = state.tokens.filter(
    (t) =>
      t.owner === token.owner &&
      t.position >= 0 &&
      t.position < PATH_LENGTH_PER_PLAYER &&
      possessorOf(power, t.id) === null,
  );
  if (mine.length === 0) return false;
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best;
}

/** Mage's Blink Strike ultimate always moves the mover's most-advanced
 *  on-board token (the same one Ward would protect) — null if they have no
 *  on-board tokens at all. Effective ownership: a token of the mover's
 *  that currently serves the enemy as a thrall is not theirs to relocate. */
function findMostAdvancedToken(state: GameState, power: PowerState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) =>
      effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position > best.position ? t : best));
}

/** The mover's LEAST-advanced on-board token — the one that benefits most
 *  from an instant reposition (Mage's Blink, via blinkStone) — null if they
 *  have no on-board tokens at all. Same effective-ownership rule as
 *  findMostAdvancedToken. NOTE: a mover's THRALL is never a candidate here
 *  either — only a necromancer can hold a thrall, so effectiveOwner alone
 *  settles it. */
function findLeastAdvancedToken(state: GameState, power: PowerState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) =>
      effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position < best.position ? t : best));
}

/** Is this token currently protected by its owner's Ward? Derived, not
 *  stored — see the Mage kit note in the plan for why it's gated at the
 *  full charge cap rather than any-charge. A POSSESSED token is never
 *  warded (isMostAdvanced already refuses it): the soul isn't home, and a
 *  Mage's magic guarding the necromancer's weapon against the Mage's own
 *  rescue attempts would be absurd. */
export function isWarded(
  state: GameState,
  power: PowerState,
  token: TokenState,
): boolean {
  if (power.classes[token.owner] !== "mage") return false;
  if (power.charges[token.owner] < CHARGE_CAP) return false;
  if (WARD_SCOPE === "most-advanced") return isMostAdvanced(state, power, token);
  return true;
}

/** Is this token currently protected by a real shield TILE (base-game rule,
 *  same as rulebook's Q5a — every class respects this, including Warriors). */
function onShieldTile(token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  return BOARD_LAYOUT[token.position].type === "shield";
}

/** Is this token currently walled — Warrior's Bulwark or Cleric's
 *  Blessing? Live map lookup, presence in power.walls means "still up."
 *  Nothing below ultimate tier pierces a wall — see isProtected, which is
 *  now the ONE predicate every enemy-targeting pool and every landing
 *  capture checks. A wall falls only when its owner can't pay
 *  wallUpkeepFor it (tickWallUpkeepForNewTurn); this function never
 *  changes state, it only reads it. */
export function isWalled(power: PowerState, token: TokenState): boolean {
  return power.walls[token.id] !== undefined;
}

/** May `token`'s owner ever hold a wall on it? The Barbarian's whole
 *  identity is having none, by rule (2026-09-17) — not a kit gap, a
 *  guardrail against a future wall-granting ability (a cross-class buff,
 *  the Warpath-into-Shield-Wall retheme was exactly this risk) silently
 *  handing him one. Checked at every wall-granting pool AND apply (Bulwark,
 *  Bless, Benediction, Shield Wall) — a shield TILE still protects him;
 *  only the paid-for kind is denied. */
export function canHoldWall(power: PowerState, token: TokenState): boolean {
  return power.classes[token.owner] !== "barbarian";
}

/** Is this token hidden by a Rogue's Vanish? Own map (2026-09-17 — split
 *  off Bulwark's, see PowerState.vanished): a fixed VANISH_TURNS dodge,
 *  not a paid wall — it does not bleed and it does expire on its own
 *  (tickVanishForNewTurn). Fully immune to everything a wall is, folded
 *  into isProtected below, same as before the split. */
export function isVanished(power: PowerState, token: TokenState): boolean {
  return power.vanished[token.id] !== undefined;
}

/** THE single "is this token capturable/pushable/sweepable/advanceable AT
 *  ALL right now" check (2026-09-17: now used EVERYWHERE, including the
 *  main landing-capture path and Push, which used to carve out their own
 *  partial exceptions for Ward Breaker and a "soft" push — both retired.
 *  A wall or a shield tile stops every class with no exception; ultimates
 *  are the only thing that ever reaches a protected stone, and they check
 *  for it nowhere at all — that's what "pierces everything" means. */
export function isProtected(state: GameState, power: PowerState, token: TokenState): boolean {
  return (
    onShieldTile(token) ||
    isWarded(state, power, token) ||
    isWalled(power, token) ||
    isVanished(power, token)
  );
}

/** How far a Push against this specific target knocks it back:
 *  PUSH_WARD_DISTANCE if it's currently warded, PUSH_DISTANCE otherwise. */
/** RETIRED tier collapsed 2026-09-17: a Warded target can no longer reach
 *  this at all (getPushTargets excludes every protected stone outright),
 *  so Push always knocks back PUSH_DISTANCE now. Kept as its own function
 *  — not inlined at the call site — so a future distance-tier reopens in
 *  one place. */
function pushDistance(state: GameState, power: PowerState, target: TokenState): number {
  void state; void power;
  return PUSH_DISTANCE;
}

/** How deep this player's bank goes for ORDINARY income. CHARGE_CAP for
 *  everyone except the bard, whose kit is built on having mana to spread
 *  (see BARD_CHARGE_CAP). Deliberately does NOT return NECRO_CHARGE_CAP:
 *  the necromancer's third pip is a soul gem only grantKillBounty may
 *  reach, and routing it through here would hand it away for free. */
export function chargeCapFor(power: PowerState, player: PlayerId): number {
  return power.classes[player] === "bard" ? BARD_CHARGE_CAP : CHARGE_CAP;
}

function addCharge(power: PowerState, player: PlayerId): PowerState {
  const current = power.charges[player];
  if (current >= chargeCapFor(power, player)) return power;
  return { ...power, charges: { ...power.charges, [player]: current + 1 } };
}

/** The zero-flip consolation charge — ENCORE_ZERO_FLIP_CHARGES of them for a
 *  BARD (see that constant: a dead flip is the class's income engine), one
 *  for everyone else. Gated on class here so every call site stays
 *  unconditional, grantKillBounty's own shape. Still runs through addCharge,
 *  so it caps at CHARGE_CAP like all generic income — a bard at 1 charge
 *  rolling a zero reaches the cap and no further. */
export function grantZeroFlipCharge(power: PowerState, mover: PlayerId): PowerState {
  const n = power.classes[mover] === "bard" ? ENCORE_ZERO_FLIP_CHARGES : 1;
  let next = power;
  for (let i = 0; i < n; i++) next = addCharge(next, mover);
  return next;
}

/** THE WALL SYSTEM'S TICK (2026-09-17): charges `mover` wallUpkeepFor every
 *  wall they hold, front (most-advanced) stone first — "the front holds
 *  longest" — and DROPS any it can't afford, reporting which. Call once
 *  per fresh flip dealt to `mover`, AFTER the other economy ticks
 *  (zero-flip grant, thrall, curse, hamstring, inspire, Dark Bargain) and
 *  BEFORE move generation — a dropped wall unprotects that stone THIS
 *  turn, so the move list has to see the post-upkeep board. Grace
 *  (wallGrace, Vigil/Sanctified Ground/Benediction/Shield Wall) waives ONE
 *  wall's payment before charging anything — spent front-first too, same
 *  order as payment, and never lets a grace turn go to waste on an empty
 *  wall list. No voluntary drop: spending below upkeep IS the drop. */
export function tickWallUpkeepForNewTurn(
  state: GameState,
  power: PowerState,
): { power: PowerState; paid: number; droppedTokenIds: number[] } {
  const mover = state.currentPlayer;
  const mine = Object.keys(power.walls)
    .map(Number)
    .filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover)
    .sort((a, b) => {
      const pa = state.tokens.find((t) => t.id === a)!.position;
      const pb = state.tokens.find((t) => t.id === b)!.position;
      return pb - pa; // most-advanced first
    });
  if (mine.length === 0) return { power, paid: 0, droppedTokenIds: [] };

  let grace = power.wallGrace[mover] ?? 0;
  let charges = power.charges[mover];
  let paid = 0;
  const droppedTokenIds: number[] = [];
  const walls = { ...power.walls };
  for (const id of mine) {
    if (grace > 0) {
      grace -= 1;
      continue;
    }
    const cost = wallUpkeepFor(power, mover);
    if (charges >= cost) {
      charges -= cost;
      paid += cost;
    } else {
      delete walls[id];
      droppedTokenIds.push(id);
    }
  }
  const nextPower: PowerState = {
    ...power,
    walls,
    charges: { ...power.charges, [mover]: charges },
    wallGrace: { ...power.wallGrace, [mover]: grace },
  };
  return { power: nextPower, paid, droppedTokenIds };
}

/** Rogue's Vanish: ticks down the countdown on every token `mover`
 *  currently has hidden — one of THEIR OWN turns has just started. A
 *  fixed-duration dodge, not a wall (see PowerState.vanished) — no
 *  upkeep, no grace, just VANISH_TURNS and then it's gone. Same calling
 *  convention as tickHamstringForNewTurn: once per fresh flip, before
 *  move generation. Returns the ids that expired so the server can
 *  announce them. */
export function tickVanishForNewTurn(
  state: GameState,
  power: PowerState,
): { power: PowerState; expiredTokenIds: number[] } {
  const mover = state.currentPlayer;
  const mine = Object.keys(power.vanished)
    .map(Number)
    .filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover);
  if (mine.length === 0) return { power, expiredTokenIds: [] };
  const vanished = { ...power.vanished };
  const expiredTokenIds: number[] = [];
  for (const id of mine) {
    const left = vanished[id] - 1;
    if (left <= 0) {
      delete vanished[id];
      expiredTokenIds.push(id);
    } else {
      vanished[id] = left;
    }
  }
  return { power: { ...power, vanished }, expiredTokenIds };
}

/** Necromancer's Soul Harvest (passive, REWORKED — see SOUL_BOUNTY_CHARGES
 *  for the design story): the necromancer's own QUALIFYING kills bank
 *  SOUL_BOUNTY_CHARGES each, up to NECRO_CHARGE_CAP — the only income in
 *  the game that can fill the third pip (the soul gem). Gated on the
 *  MOVER's class here so the call site stays unconditional. The caller
 *  filters for qualifying kills (real owner = the foe) BEFORE counting —
 *  see resolveTurn, the necromancer's only kill path (no Snipe, no sweep,
 *  and Exhume is a return, not a kill; the thrall's captures resolve
 *  through resolveTurn like any landing move, which is exactly how a
 *  thrall kill funds the NEXT thrall). */
function grantKillBounty(power: PowerState, mover: PlayerId, count: number): PowerState {
  if (count <= 0 || power.classes[mover] !== "necromancer") return power;
  const current = power.charges[mover];
  const next = Math.min(NECRO_CHARGE_CAP, current + count * SOUL_BOUNTY_CHARGES);
  if (next === current) return power;
  return { ...power, charges: { ...power.charges, [mover]: next } };
}

/** A captured thrall dies for real: its possession entry must fall with it
 *  (the token itself is already headed to position -1 — its real owner's
 *  reserve — which is the fairness invariant: no worse off than the kill
 *  that enabled the possession). Same call-site discipline as
 *  clearCapturedBulwarks: every path that sends tokens home must run this —
 *  resolveTurn (landing captures, Snipe, sweeps, Rain of Arrows),
 *  applyPush/applyChargedShot (sendsHome branch), applyBlinkStrike.
 *  No-op (same reference back) when no thrall was hit. */
function clearThrallIfCaptured(power: PowerState, capturedIds: number[]): PowerState {
  const hit = (["p1", "p2"] as PlayerId[]).filter((pl) => {
    const th = power.thrall[pl];
    return th !== null && capturedIds.includes(th.tokenId);
  });
  if (hit.length === 0) return power;
  const thrall = { ...power.thrall };
  for (const pl of hit) thrall[pl] = null;
  return { ...power, thrall };
}

/** Warlock's Blood Pact (see BLOOD_PACT_CHARGES): every kill pays the
 *  VICTIM's owner when that owner is a warlock — real `token.owner`, not
 *  effective: a warlock's stone dying while possessed against them is
 *  still their blood, and the pact still pays (mercy kills included).
 *  Same call-site discipline as clearThrallIfCaptured/clearVitality:
 *  every path that sends tokens home for good must run this — resolveTurn
 *  kills, Push/Charged Shot send-homes, Blink Strike, Corpse
 *  Explosion, Grand Heist (whose drain-to-zero then robs the grant right
 *  back — see BLOOD_PACT_CHARGES's ordering note), Sacrifice, and Fel
 *  Storm's thrall-crumble deaths. Not the non-kill returns (thrall
 *  expiry, Exhume). No-op (same reference back) when no warlock lost a
 *  stone. Gated on the VICTIM owner's class here so call sites stay
 *  unconditional, grantKillBounty's own shape. */
/** Warlock's Dark Bargain — see BLOOD_PACT_CHARGES's doc for the rule.
 *  Runs AFTER a kill path has sent `killedIds` home and run its reserve-
 *  trip hygiene, at the exact slot grantBloodPact used to occupy, and
 *  rewrites the outcome for every warlock stone the enemy just killed
 *  that the fiend will trade for: the stone returns to the board one tile
 *  back, its least-advanced stand-in goes home instead (with the same
 *  hygiene the stand-in would have had as a normal death), the payout
 *  lands, and a necromancer killer's corpse/grave follow the stand-in.
 *  `preTokens` is the board immediately BEFORE the kill (where the victim
 *  stood when it died); `prePower` the pre-action power (possession and
 *  statuses as they were). Pure; returns the same references back when
 *  nothing bargained. */
export function applyDarkBargain(
  preTokens: TokenState[],
  prePower: PowerState,
  tokens: TokenState[],
  nextPower: PowerState,
  killedIds: number[],
  killer: PlayerId,
  delivery: KillDelivery,
): { tokens: TokenState[]; power: PowerState } {
  // The archer lever: the fiend answers a blade, not an arrow.
  if (DARK_BARGAIN_LANDING_ONLY && delivery !== "landing") return { tokens, power: nextPower };
  let out = tokens;
  let pw = nextPower;
  for (const id of killedIds) {
    const victim = preTokens.find((t) => t.id === id);
    if (!victim) continue;
    const owner = victim.owner;
    if (owner === killer) continue; // blood the warlock spills itself — Sacrifice — is never bargained
    if (prePower.classes[owner] !== "warlock") continue;
    if (effectiveOwner(prePower, victim) !== owner) continue; // a possessed body is the necromancer's loss
    if (victim.position < DARK_BARGAIN_RETREAT) continue;
    const retreat = victim.position - DARK_BARGAIN_RETREAT;
    const standIn = pickDarkBargainStandIn(out, prePower, victim, killedIds);
    if (!standIn) continue;
    if (darkBargainRetreatBlocked(out, owner, retreat, standIn.id)) continue;

    out = out.map((t) =>
      t.id === id ? { ...t, position: retreat } : t.id === standIn.id ? { ...t, position: -1 } : t,
    );
    // The saved stone did not die: put back what the kill hooks stripped.
    // (A warlock's own stone can never be Blessed/walled — that's a
    // Cleric-only grant onto the Cleric's own stones — so there is no
    // vitality/wall entry to restore here any more, only these three.)
    if (prePower.hamstrung?.[id] !== undefined) pw = { ...pw, hamstrung: { ...pw.hamstrung, [id]: prePower.hamstrung[id] } };
    if (prePower.inspired?.[id] !== undefined) pw = { ...pw, inspired: { ...pw.inspired, [id]: prePower.inspired[id] } };
    for (const pl of ["p1", "p2"] as PlayerId[]) {
      if (prePower.curse[pl]?.tokenId === id) pw = { ...pw, curse: { ...pw.curse, [pl]: prePower.curse[pl] } };
    }
    // The stand-in died for real: the standard reserve-trip hygiene.
    pw = clearCurseOnCapture(pw, [standIn.id]);
    pw = clearHamstringOnCapture(pw, [standIn.id]);
    pw = clearInspireOnCapture(pw, [standIn.id]);
    pw = clearWallsOnReserveTrip(pw, [standIn.id]);
    // A necromancer's corpse and grave follow the stone that actually died.
    if (pw.corpse[killer]?.tokenId === id) {
      pw = {
        ...pw,
        corpse: { ...pw.corpse, [killer]: { tokenId: standIn.id, tile: standIn.position } },
        grave: { ...pw.grave, [killer]: standIn.position },
      };
    }
    for (let i = 0; i < BLOOD_PACT_CHARGES; i++) pw = addCharge(pw, owner);
    pw = {
      ...pw,
      darkBargain: {
        ...pw.darkBargain,
        [owner]: {
          savedTokenId: id,
          from: victim.position,
          to: retreat,
          sacrificedTokenId: standIn.id,
          sacrificedFrom: standIn.position,
        },
      },
    };
  }
  return { tokens: out, power: pw };
}

/** The stand-in Dark Bargain would take for `victim`: the warlock's
 *  least-advanced OTHER stone on `tokens`, strictly behind the victim, its
 *  own to lose (not possessed), and not in `excludeIds` (the stones dying
 *  in the same blow). Lowest id breaks ties, deterministically. */
function pickDarkBargainStandIn(
  tokens: TokenState[],
  prePower: PowerState,
  victim: TokenState,
  excludeIds: number[],
): TokenState | undefined {
  const owner = victim.owner;
  return tokens
    .filter(
      (t) =>
        t.owner === owner &&
        t.id !== victim.id &&
        !excludeIds.includes(t.id) &&
        t.position >= 0 &&
        t.position < victim.position &&
        effectiveOwner(prePower, t) === owner,
    )
    .sort((a, b) => a.position - b.position || a.id - b.id)[0];
}

/** Is the retreat tile taken? Contested tiles (4-11) are one square for
 *  both numberings; a private-lane tile only ever holds its owner's stones.
 *  The stand-in itself never blocks — it is the one leaving. */
function darkBargainRetreatBlocked(tokens: TokenState[], owner: PlayerId, retreat: number, standInId: number): boolean {
  return tokens.some(
    (t) =>
      t.id !== standInId &&
      t.position === retreat &&
      (retreat >= 4 && retreat <= 11 ? true : t.owner === owner),
  );
}

/** Clear both players' Dark Bargain announcements at the start of a fresh
 *  turn — tickHamstringForNewTurn's slot (room-engine's commitTurnFlip and
 *  the sims' takeTurn, BEFORE move gen). No-op (same reference) when
 *  nothing is set. */
export function tickDarkBargainForNewTurn(power: PowerState): PowerState {
  if (power.darkBargain.p1 === null && power.darkBargain.p2 === null) return power;
  return { ...power, darkBargain: { p1: null, p2: null } };
}

/** A killed token's curse lifts with it — the same reserve-trip hygiene
 *  clearCapturedBulwarks/clearVitality apply, same call-site discipline:
 *  any path that sends tokens home for good must run this. Without it, a
 *  stale curse entry would ride the reserve trip and re-shackle the stone
 *  the moment it re-enters — un-recast, unpaid-for slowdown, the exact
 *  leak shape the Bulwark cleanup guards against in reverse. No-op (same
 *  reference back) when nothing captured was cursed. */
function clearCurseOnCapture(power: PowerState, capturedIds: number[]): PowerState {
  const hit = (["p1", "p2"] as PlayerId[]).filter((pl) => {
    const c = power.curse[pl];
    return c !== null && capturedIds.includes(c.tokenId);
  });
  if (hit.length === 0) return power;
  const curse = { ...power.curse };
  for (const pl of hit) curse[pl] = null;
  return { ...power, curse };
}

/** Is this token wearing Curse of Chains right now? Either caster's slot —
 *  the filter in getLegalPowerMoves and the client's ring both key on the
 *  token, not the caster. */
export function isCursed(power: PowerState, tokenId: number): boolean {
  return power.curse.p1?.tokenId === tokenId || power.curse.p2?.tokenId === tokenId;
}

/** Barbarian's Rage (see RAGE_MAX): how many extra tiles every one of this
 *  player's moves gets right now — one per stone of theirs in reserve,
 *  capped. Zero for every other class, so the call site in
 *  getLegalPowerMoves stays unconditional. Real `owner`, not effective: a
 *  stone of theirs serving an enemy necromancer as a thrall is on the
 *  BOARD, not in reserve, so it correctly stokes nothing — and the moment
 *  it crumbles home it does. Exported for the client's rage pip and the
 *  bot's eval. */
export function rageFor(state: GameState, power: PowerState, player: PlayerId): number {
  if (power.classes[player] !== "barbarian") return 0;
  const reserveOf = (pl: PlayerId) =>
    state.tokens.filter((t) => t.owner === pl && t.position < 0).length;
  // The DIFFERENTIAL, not the raw count — this is what makes it a comeback
  // mechanic instead of a permanent head start (see RAGE_MAX's doc) — and
  // the first RAGE_FREE_DEFICIT stones of that deficit pay nothing, which
  // is the fine dial the tuning actually needed (see its own doc).
  const deficit = reserveOf(player) - reserveOf(otherPlayerId(player)) - RAGE_FREE_DEFICIT;
  return Math.max(0, Math.min(RAGE_MAX, deficit));
}

/** The single stone Rage speeds up under RAGE_SCOPE="least-advanced": the
 *  mover's least-advanced token, counting RESERVE as least of all (so the
 *  stone that just died is the one that comes back running). Effective
 *  ownership, so a stone serving an enemy necromancer is not a candidate.
 *  Exported for the client's rage marker and the bot. */
export function ragedToken(state: GameState, power: PowerState, player: PlayerId): number | null {
  const mine = state.tokens.filter(
    (t) => effectiveOwner(power, t) === player && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position < best.position ? t : best)).id;
}

/** Is this stone carrying the Bard's inspiration right now (+INSPIRE_BONUS
 *  to its every move)? Several of a bard's stones may be, at once — that is
 *  the class's whole point. */
export function isInspired(power: PowerState, tokenId: number): boolean {
  return (power.inspired?.[tokenId] ?? 0) > 0;
}

/** An inspired stone sent home loses the song — the reserve-trip hygiene
 *  every per-token status gets, and the same leak it prevents: a stale
 *  entry would re-light the stone the moment it re-entered, unpaid for. */
function clearInspireOnCapture(power: PowerState, capturedIds: number[]): PowerState {
  if (!capturedIds.some((id) => power.inspired?.[id] !== undefined)) return power;
  const inspired = { ...power.inspired };
  for (const id of capturedIds) delete inspired[id];
  return { ...power, inspired };
}

/** Is this token frozen by Hamstring / Wild Hunt? A frozen stone generates
 *  no moves at all this turn (see getLegalPowerMoves) — every other rule
 *  treats it as an ordinary stone. */
export function isHamstrung(power: PowerState, tokenId: number): boolean {
  return (power.hamstrung?.[tokenId] ?? 0) > 0;
}

/** Which contested tile the hunter's wolf currently guards — the tile
 *  directly ahead of their MOST-advanced on-board stone, or null when they
 *  have no stone on the board, the wolf stands at the row's end, or the
 *  guarded square isn't contested (a wolf in its own private lane guards
 *  nothing: tiles 0-3 and 12-14 are a different physical square for each
 *  owner, the same rule that makes home base safe from Snipe).
 *  Exported because the client draws the guarded tile and the bot reads it.
 *
 *  MOST-advanced, corrected 2026-07-26 after the first balance run. The
 *  wolf was first tied to the LEAST-advanced stone (Warpath's convention,
 *  picked without thinking about where that stone actually stands), which
 *  made the passive nearly dead: a hunter's rearmost stone spends most of
 *  the game in its own private lane, where this function correctly returns
 *  null, so wolfBite/g sat at 0.46 across a whole game. The lead stone is
 *  out in the contested row by definition, so the wolf now ranges ahead of
 *  the pack — which is also the right picture. */
export function wolfGuardTile(state: GameState, power: PowerState, hunter: PlayerId): number | null {
  if (power.classes[hunter] !== "hunter") return null;
  const wolf = findMostAdvancedToken(state, power, hunter);
  if (!wolf) return null;
  const guarded = wolf.position + 1;
  if (guarded >= PATH_LENGTH_PER_PLAYER || !BOARD_LAYOUT[guarded].isContested) return null;
  return guarded;
}

/** A frozen token's timer dies with it — the reserve-trip hygiene every
 *  per-token status gets (clearVitality/clearCurseOnCapture's discipline),
 *  and the same leak it prevents: a stale entry would re-freeze the stone
 *  the moment it re-entered, unpaid for. */
function clearHamstringOnCapture(power: PowerState, capturedIds: number[]): PowerState {
  if (!capturedIds.some((id) => power.hamstrung?.[id] !== undefined)) return power;
  const hamstrung = { ...power.hamstrung };
  for (const id of capturedIds) delete hamstrung[id];
  return { ...power, hamstrung };
}

/** Is this token Blessed — under the wall rework (2026-09-17), IS this
 *  token's wall a Blessing specifically? A Blessing is now a wall like any
 *  other (see PowerState.walls/isWalled) — this is display/card plumbing
 *  (which art, which class chapter) for the two kinds, not a legality
 *  check anywhere. Kept exported under its old name because the client
 *  and the guide still say "blessed," not "walled-by-blessing." */
export function isBlessed(power: PowerState, tokenId: number): boolean {
  return power.walls[tokenId] === "blessing";
}

// RETIRED 2026-09-17: staggerBackTile (the stagger-back walk for a wounded
// stone whose tile the killer now occupies) went with the wound split — a
// walled/Blessed stone can no longer be hit at all, so nothing ever needs
// to stagger. Its collision-walk shape is echoed once more in
// applyCorpseExplosion's own knockback loop (see that function's comment).

// ============================================================================
// MOVE GENERATION
//
// Reimplements rulebook.getLegalMoves()'s from/to/occupancy walk rather than
// wrapping it — Ward changes LEGALITY (a warded-but-non-shield landing must
// flip from "legal capture" to "illegal" for non-Warriors), which a wrapper
// around the classic function can't express without changing its signature.
// Kept intentionally close in shape/order to the original so a side-by-side
// diff stays readable; see the anti-drift regression test for the safety
// net this duplication needs.
// ============================================================================

export function getLegalPowerMoves(
  state: GameState,
  power: PowerState,
  flip: number,
): PowerMove[] {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];

  const player = state.currentPlayer;
  const cls = power.classes[player];
  const moves: PowerMove[] = [];
  const rageBonus = rageFor(state, power, player);
  // Which single stone Rage speeds up (see RAGE_SCOPE) — the least-advanced
  // one, with reserve counting as least, so the stone that just died comes
  // back running. Null when the scope is "all" or there is no rage at all.
  const ragedTokenId =
    rageBonus > 0 && RAGE_SCOPE === "least-advanced" ? ragedToken(state, power, player) : null;

  for (const token of state.tokens) {
    // Effective ownership (see effectiveOwner): the mover's pool includes a
    // thrall they possess and excludes any of their own tokens possessed
    // AGAINST them — the victim can neither move nor re-enter their
    // possessed stone (it isn't in reserve, and it isn't effectively theirs).
    if (effectiveOwner(power, token) !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue; // already escaped
    const isThrall = possessorOf(power, token.id) === player;

    // Hunter's Hamstring / Wild Hunt: a frozen stone generates no moves at
    // all — the only status in the game that removes a stone from its own
    // owner's options entirely. Checked before the stride math below
    // because a frozen stone's stride is moot.
    if (isHamstrung(power, token.id)) continue;

    // The two stride modifiers, applied together. Warlock's Curse of Chains
    // shortens THIS token by CURSE_SLOW; Barbarian's Rage lengthens every
    // one of the mover's by however many of their stones sit in reserve
    // (capped at RAGE_MAX). The flip itself is untouched in both cases —
    // the victim's other stones move their full distance, and a Mage
    // re-flipping doesn't shake the chains, it only re-rolls what they
    // bind. At effFlip <= 0 the stone has no move at all this turn.
    //
    // Order matters only in that they are ADDITIVE and then floored: a
    // cursed barbarian is slowed relative to its own rage, not cancelled
    // outright, which is the reading that keeps both abilities honest when
    // they meet. Rage is deliberately computed per MOVER (not per token) so
    // a barbarian's whole army speeds up together.
    const myRage = ragedTokenId === null || ragedTokenId === token.id ? rageBonus : 0;
    const slow = isCursed(power, token.id) ? CURSE_SLOW : 0;
    // THE SONG NEVER CARRIES YOU PAST THE FINISH. An escape needs the stone
    // to land on PATH_LENGTH_PER_PLAYER-1 EXACTLY, so a permanent stride
    // bonus is a liability at the end of the lane, not a gift: an inspired
    // stone on tile 13 would need an effective flip of 1 and can no longer
    // produce one, so it could never escape until the song faded. The first
    // balance run caught it as a grind — the bard mirror stalemating 28%
    // (and 50% once the bank got deeper and the buff got wider) with the
    // class at 10-40% against the field. Dropping the bonus rather than the
    // move keeps the invariant that an inspiration only ever ADDS options.
    // Deliberately checked against the boosted total, not the plain one, so
    // the bonus still applies whenever it doesn't overshoot.
    const boosted = isInspired(power, token.id) ? INSPIRE_BONUS : 0;
    // `to` is position+effFlip on the board and effFlip-1 from reserve —
    // the same arithmetic, since a reserve token sits at -1.
    const wouldOvershoot =
      token.position + flip + myRage + boosted - slow > PATH_LENGTH_PER_PLAYER - 1;
    const inspireBonus = wouldOvershoot ? 0 : boosted;
    const effFlip = flip + myRage + inspireBonus - slow;
    if (effFlip <= 0) continue;

    const from = token.position;
    const to = from === -1 ? effFlip - 1 : from + effFlip;

    // SOUL CLAIM: a token whose corpse the enemy necromancer has marked
    // AND funded (full soul bank) cannot re-enter from reserve — the soul
    // is already claimed; the body will not rise on its own. The claim
    // holds even while a thrall is still up (the chain's NEXT corpse stays
    // claimed until the slot frees); it lapses only when the bank is spent
    // or the corpse overwritten, and then re-entry denial works as before.
    // Without this, the first balance run measured denial eating half of
    // all corpses (any flip 1-4 re-enters), starving the class's entire
    // kit: 82.7/17.3 vs mage. The thrall-active arm was added when the
    // claim-lapses-during-possession version still leaked the chain's
    // follow-up corpse to cheap denial.
    if (from === -1) {
      const foe = otherPlayerId(player);
      if (
        power.classes[foe] === "necromancer" &&
        power.corpse[foe]?.tokenId === token.id &&
        power.charges[foe] >= REVIVE_COST
      ) {
        continue;
      }
    }

    // A thrall is chained to the contested row (see THRALL_TURNS's history
    // note): tiles past 11 are the VICTIM's private return lane in its own
    // position numbering — holy ground the dead may not walk, and the road
    // to an escape it must never have. Overshooting moves simply don't
    // exist for it (the necromancer's other tokens still move normally).
    if (isThrall && to > 11) continue;

    // Escape — identical to the classic rule, no power interacts with it.
    // (Unreachable for a thrall: its `to` is capped at 11 above.)
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      // Win counting stays REAL-owner: a token of yours serving the enemy
      // as a thrall is on the board (position <= 11), so it counts as
      // not-escaped and correctly blocks causesWin until it comes home.
      const remaining = state.tokens.filter(
        (t) => t.owner === player && t.id !== token.id && t.position < PATH_LENGTH_PER_PLAYER,
      );
      moves.push({
        tokenId: token.id,
        from,
        to: PATH_LENGTH_PER_PLAYER,
        captures: [],
        bonusCaptures: [],
        landsOnShield: false,
        causesWin: remaining.length === 0,
        breaksWard: false,
        chargeAvailable: false,
        chargeSweepCaptures: [],
      });
      continue;
    }

    const destTile = BOARD_LAYOUT[to];
    // The occupancy FILTER stays real-owner (physics: same-owner indices
    // name the same tile everywhere, cross-owner only on contested tiles);
    // the self/enemy CLASSIFICATION is effective-owner (allegiance) — the
    // one split that lets the victim's own army capture their possessed
    // stone while the necromancer stack-blocks against it.
    const occupants = state.tokens.filter(
      (t) => t.position === to && t.id !== token.id && (destTile.isContested || t.owner === player),
    );
    const self = occupants.find((t) => effectiveOwner(power, t) === player);
    const enemy = occupants.find((t) => effectiveOwner(power, t) !== player);

    if (self) continue; // own-token blocks, same as classic

    let captures: number[] = [];
    // RETIRED 2026-09-17 (walls are absolute now): Ward Breaker (Warriors
    // pierced Ward), the necromancer thrall's Ward pierce, and the Blessed
    // Blade (a blessed attacker's strike pierced Ward) are all gone — one
    // isProtected check covers shield tile, Ward, Bulwark, Blessing and
    // Vanish alike, and nothing below ultimate tier reaches any of them.
    // `breaksWard` stays on PowerMove/the wire, always false now, so
    // nothing downstream needs its own removal pass.
    const breaksWard = false;

    if (enemy) {
      if (isProtected(state, power, enemy)) continue;
      captures = [enemy.id]; // normal contested capture
    }

    // Archer Snipe (passive, free): a second unprotected enemy exactly one
    // tile further along the shared contested row. MUST check that to+1 is
    // itself a contested tile, not just "<= 11" — tiles 0-3 and 12-14 are
    // each player's own private lane, where the SAME index numbers a
    // completely different physical square for each owner (this is what
    // makes "home base" safe at all). Without this check, an Archer sitting
    // in their own private lane could snipe an enemy token that merely
    // shares a numeric index in ITS OWN separate private lane — a real bug
    // found via playtest confusion ("why are we attacking tokens on the
    // home base?"), confirmed with a repro: archer enters at to=0, enemy
    // sits at their own private position 1, Snipe fired anyway.
    const bonusCaptures: number[] = [];
    if (cls === "archer" && BOARD_LAYOUT[to + 1].isContested) {
      // Effective ownership: an archer's own token possessed against them
      // is a legitimate Snipe victim (mercy at range).
      const sniped = state.tokens.find(
        (t) => t.position === to + 1 && effectiveOwner(power, t) !== player && t.id !== enemy?.id,
      );
      if (sniped && !isProtected(state, power, sniped)) {
        bonusCaptures.push(sniped.id);
      }
    }

    // Warrior Charge availability: from must be on-board and every
    // intermediate contested tile must be clear of the Warrior's own
    // tokens. The sweep itself only touches contested tiles strictly
    // between from and to, and — like a normal move — never crosses a
    // shield tile. Every protection blocks it now (2026-09-17: walls are
    // absolute, and Ward Breaker's old "a Warded token IS captured, same
    // as a direct landing" carve-out retired with it) — one isProtected
    // check, same as the landing tile.
    let chargeAvailable = false;
    const chargeSweepCaptures: number[] = [];
    if (cls === "warrior" && from >= 0) {
      let laneClear = true;
      for (let i = from + 1; i < to; i++) {
        const tile = BOARD_LAYOUT[i];
        if (!tile.isContested) continue; // sweep only matters on shared tiles
        const occ = state.tokens.filter((t) => t.position === i && t.id !== token.id);
        // Effective ownership on both sides: the warrior's possessed token
        // is not a lane-blocker of theirs — it's an enemy the sweep can cut
        // down on the way through.
        if (occ.some((t) => effectiveOwner(power, t) === player)) {
          laneClear = false;
          break;
        }
        const foe = occ.find((t) => effectiveOwner(power, t) !== player);
        if (
          foe &&
          chargeSweepCaptures.length < CHARGE_SWEEP_CAP &&
          !isProtected(state, power, foe)
        ) {
          chargeSweepCaptures.push(foe.id);
        }
        // Keep scanning past the cap anyway — laneClear still needs the
        // WHOLE lane checked for the Warrior's own blocking tokens, even
        // once no more captures will be recorded.
      }
      chargeAvailable = laneClear;
    }

    moves.push({
      tokenId: token.id,
      from,
      to,
      captures,
      bonusCaptures,
      landsOnShield: destTile.type === "shield",
      causesWin: false,
      breaksWard,
      chargeAvailable,
      chargeSweepCaptures,
    });
  }

  return moves;
}

// ============================================================================
// APPLYING MOVES / ACTIONS
// ============================================================================

/** Rain of Arrows' target pool (Archer's ultimate only): enemy tokens,
 *  on-board, anywhere in the contested zone — deliberately skipping
 *  onShieldTile/isWarded/isBulwarked, since punching through every
 *  protection is the whole point. Nothing guards against it. */
export function getRainOfArrowsTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .map((t) => t.id);
}

/** Breaks a player's shield-streak combo — called both from applyPush
 *  (which never lands the mover on a shield, so it always ends any live
 *  streak) and directly by the server's auto-skip paths (referee.ts/
 *  api/ws.ts resolve a turn-end without ever going through resolveTurn,
 *  same shape of problem grantZeroFlipCharge already solves for the charge
 *  economy). No class gate needed — every class tracks this now. */
export function breakShieldStreak(power: PowerState, player: PlayerId): PowerState {
  if (power.shieldStreak[player] === 0) return power;
  return { ...power, shieldStreak: { ...power.shieldStreak, [player]: 0 } };
}

/** Advances or breaks the mover's shield-streak for this resolving action,
 *  and resolves what completing it means: EVERY class banks ultimateReady
 *  to spend later. (Until 2026-09-16 the Archer's Rain of Arrows fired on
 *  the third landing itself, at a random target, and wasted when nothing
 *  stood in shared water — it landed in 1-in-100 games while every banked
 *  ultimate fired in ~1-in-10, and the archer sat second-from-bottom. It
 *  now banks like the other nine and is cast, aimed, from the dock — see
 *  applyRainOfArrows. The `rainOfArrows` slot in this result is kept for
 *  the callers' shape and is always null.) */
function resolveShieldStreak(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  landsOnShield: boolean,
  allCaptures: number[],
  rand: () => number,
): { power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  if (!landsOnShield) return { power: breakShieldStreak(power, mover), rainOfArrows: null };

  const next = power.shieldStreak[mover] + 1;
  if (next < ULTIMATE_STREAK) {
    return { power: { ...power, shieldStreak: { ...power.shieldStreak, [mover]: next } }, rainOfArrows: null };
  }

  // Completed the combo — consumed either way, regardless of class or target availability.
  void state; void allCaptures; void rand; // the archer's auto-fire used these; retired 2026-09-16
  const reset: PowerState = { ...power, shieldStreak: { ...power.shieldStreak, [mover]: 0 } };
  return { power: { ...reset, ultimateReady: { ...reset.ultimateReady, [mover]: true } }, rainOfArrows: null };
}

/** Archer's Rain of Arrows (banked ultimate since 2026-09-16): strikes one
 *  chosen enemy stone in shared water down through every protection —
 *  shield tile, Ward, Bulwark, Blessing, Vanish — the exact pool
 *  getRainOfArrowsTargets has always described. Spends ultimateReady, not
 *  a charge; grants exactly 1 charge back like any capturing action
 *  (Blink Strike's economy). An ultimate, so the Warlock's Dark Bargain
 *  does not answer it. Ends the turn, breaks the shield streak — an
 *  attack, not a placement (Push's shape). Callers gate on
 *  ultimateReady + the pool, as for every banked ultimate. */
export function applyRainOfArrows(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: -1 } : t));
  let nextPower: PowerState = clearWallsOnReserveTrip(
    { ...power, ultimateReady: { ...power.ultimateReady, [mover]: false } },
    [targetTokenId],
  );
  nextPower = clearThrallIfCaptured(nextPower, [targetTokenId]);
  nextPower = clearCurseOnCapture(nextPower, [targetTokenId]);
  nextPower = clearHamstringOnCapture(nextPower, [targetTokenId]);
  nextPower = clearInspireOnCapture(nextPower, [targetTokenId]);
  nextPower = addCharge(nextPower, mover);
  nextPower = breakShieldStreak(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: [] };
}

/** Shared plumbing: send a set of token ids to reserve, advance the mover,
 *  grant a charge for a capturing/shield-landing move, hand the turn to
 *  the opponent (or keep it on a shield landing), and reset per-turn flags
 *  for the next flip.
 *
 *  THE WOUND SPLIT RETIRED (2026-09-17, the wall rework): every capture in
 *  `allCaptures` used to resolve as either a KILL or — when the victim
 *  carried an unbroken Blessing — a WOUND that left the stone on the
 *  board, earning the attacker nothing. Blessing is now a WALL (see
 *  PowerState.walls): a walled stone can't be captured at all below
 *  ultimate tier, so it never reaches `allCaptures` in the first place —
 *  every capture here is unconditionally a real kill. `wounded` and
 *  `mendedTokenIds` stay in the return shape, always empty, for the
 *  callers (the wire, the client) that still read them. */
function resolveTurn(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  tokenId: number,
  to: number,
  allCaptures: number[],
  landsOnShield: boolean,
  causesWin: boolean,
  rand: () => number = Math.random,
): {
  state: GameState;
  power: PowerState;
  rainOfArrows: { targetTokenId: number | null } | null;
  wounded: { tokenId: number; to: number }[];
  mendedTokenIds: number[];
  /** Hunter's Snare sprung on the mover's landing (null otherwise) — the
   *  tile it was set on, who stepped in it, and whether the throw sent
   *  them home. Server-computed so the client never re-derives it. */
  trapSprung: { tile: number; tokenId: number; sentHome: boolean } | null;
  /** Hunter's Wolf Companion bit the mover (null otherwise). */
  wolfBite: { tokenId: number; sentHome: boolean } | null;
} {
  const streakResult = resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand);
  power = streakResult.power;
  const rainOfArrows = streakResult.rainOfArrows;

  // No wound split any more (2026-09-17): every capture-producing path
  // (landing, Snipe, Charge sweep) already excludes a protected/walled
  // stone via isProtected, so allCaptures can never include one — every
  // capture here is a real kill. `wounded` stays in the return shape,
  // always empty, for the callers that still read it.
  const kills = [...allCaptures];
  // Rain of Arrows pierces every protection — the pick joins the kill list
  // unconditionally (its pool already excluded allCaptures).
  if (rainOfArrows?.targetTokenId != null) kills.push(rainOfArrows.targetTokenId);
  const wounded: { tokenId: number; to: number }[] = [];

  let tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (kills.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let nextPower: PowerState = clearWallsOnReserveTrip(power, kills);
  // A captured thrall's possession entry falls with it — before income, so
  // the accounting below reads a settled board.
  nextPower = clearThrallIfCaptured(nextPower, kills);
  // A dead stone's curse lifts (reserve-trip hygiene); so does the mover's
  // own if THIS move carried the cursed stone off the board entirely — an
  // escape drags no chains, and a stale entry on position 15 would draw a
  // curse ring on an escaped token until expiry.
  nextPower = clearCurseOnCapture(nextPower, kills);
  // A walled or Vanished stone that escapes takes its status off the board
  // with it (2026-09-17 — the wall system's own reserve-trip-shaped gap: an
  // escape is not a reserve trip, so clearWallsOnReserveTrip(kills) above
  // never sees the MOVER's own stone). Without this a home escapee would
  // keep bleeding its owner's mana forever with nothing left to protect.
  if (to >= PATH_LENGTH_PER_PLAYER) {
    nextPower = clearWallsOnReserveTrip(nextPower, [tokenId]);
  }
  if (to >= PATH_LENGTH_PER_PLAYER && isCursed(nextPower, tokenId)) {
    nextPower = clearCurseOnCapture(nextPower, [tokenId]);
    nextPower = clearHamstringOnCapture(nextPower, [tokenId]);
    nextPower = clearInspireOnCapture(nextPower, [tokenId]);
  }

  // Income + corpse. QUALIFYING kills (real owner = the foe — reclaiming
  // your own possessed body in a necromancer mirror is not a soul) pay a
  // necromancer mover the kill bounty INSTEAD of the generic capture
  // charge, and leave the corpse marker on the landing tile (the captured
  // token stood exactly there; the necromancer has no Snipe/sweep, so a
  // landing capture is its only kill shape and the freshest kill simply
  // overwrites). Everyone else — and a necromancer's non-qualifying
  // reclaim — keeps the classic one-charge-per-qualifying-move economy.
  // (HISTORICAL: this line used to also pay a WOUND the standard capture
  // charge, back when a Blessing survived a hit as a wound instead of
  // blocking it outright — see BLESSING_CAP's doc for the 66-81% blowout
  // that taught the lesson. Walls retired the wound split 2026-09-17; the
  // lesson — a breaker must be paid something, or defenders stop
  // attacking — is why walls bleed instead of being free.)
  const foe = otherPlayerId(mover);
  const soulKills =
    power.classes[mover] === "necromancer"
      ? kills.filter((id) => state.tokens.find((t) => t.id === id)?.owner === foe)
      : [];
  if (soulKills.length > 0) {
    nextPower = grantKillBounty(nextPower, mover, soulKills.length);
    nextPower = {
      ...nextPower,
      corpse: { ...nextPower.corpse, [mover]: { tokenId: soulKills[soulKills.length - 1], tile: to } },
      // The grave is dug on the same tile, and the freshest kill moves it
      // (see PowerState.grave) — Revive will take the body and leave this.
      grave: { ...nextPower.grave, [mover]: to },
    };
    // A shield landing's generic charge still applies on top (addCharge's
    // CHARGE_CAP clamp makes it a no-op whenever the bounty already filled
    // the soul gem — the common case).
    if (landsOnShield) nextPower = addCharge(nextPower, mover);
  } else if (kills.length > 0 || landsOnShield) {
    nextPower = addCharge(nextPower, mover);
  }
  // Escape pays — see ESCAPE_CHARGES.
  if (to >= PATH_LENGTH_PER_PLAYER) {
    for (let i = 0; i < ESCAPE_CHARGES; i++) nextPower = addCharge(nextPower, mover);
  }

  // Cleric's Sanctified Ground (passive, reworked 2026-09-17 for the wall
  // system): the mover's shield-tile LANDING sustains the light — this
  // turn's wall upkeep is waived (wallGrace). A stone parked ON a shield
  // tile is already protected for free, so the wall would have nothing to
  // do there; it is the landing that earns the grace, not standing still.
  // Bounded by construction: only 3 shield tiles exist. The old mend
  // (wounded -> blessed on a shield landing) retired with the wound split.
  const mendedTokenIds: number[] = [];
  if (power.classes[mover] === "cleric" && landsOnShield) {
    nextPower = { ...nextPower, wallGrace: { ...nextPower.wallGrace, [mover]: 1 } };
  }

  // Rogue's Larceny (passive): every REAL kill (never a wound — see
  // ROGUE_STEAL_ON_CAPTURE's doc) drains the foe's bank too, on top of
  // whatever the mover's own capture income already paid above.
  if (power.classes[mover] === "rogue" && kills.length > 0) {
    nextPower = {
      ...nextPower,
      charges: {
        ...nextPower.charges,
        [foe]: Math.max(0, nextPower.charges[foe] - ROGUE_STEAL_ON_CAPTURE * kills.length),
      },
    };
  }

  // Warlock's Dark Bargain: the fiend may trade a rear stone for each
  // runner that just died. AFTER Larceny by design — see
  // BLOOD_PACT_CHARGES's ordering note (the soul's price can't be
  // pickpocketed off the corpse).
  // Landing captures first (the victim stood on the landing tile), then
  // the ranged ones of the same move (Snipe one tile ahead, a Charge
  // sweep behind) — the split is what DARK_BARGAIN_LANDING_ONLY reads.
  const landingKills = kills.filter((id) => state.tokens.find((t) => t.id === id)?.position === to);
  const rangedKills = kills.filter((id) => !landingKills.includes(id));
  ({ tokens, power: nextPower } = applyDarkBargain(state.tokens, power, tokens, nextPower, landingKills, mover, "landing"));
  ({ tokens, power: nextPower } = applyDarkBargain(state.tokens, power, tokens, nextPower, rangedKills, mover, "ranged"));
  // A dead stone's freeze timer dies with it (reserve-trip hygiene).
  nextPower = clearHamstringOnCapture(nextPower, kills);
  nextPower = clearInspireOnCapture(nextPower, kills);

  // ---- HUNTER's reactive layer: the enemy's SNARE and their WOLF both
  // fire on the mover's landing, after every capture above has settled.
  // Order is trap-then-wolf and it matters: a trap throws the mover clear
  // of the wolf's tile, so a stone can't be punished twice for one step.
  // Both are skipped entirely when the move ends the game (nothing may
  // rewind a win) and when the mover is protected (isProtected — a shield
  // tile, Ward or Bulwark stops a trap and a wolf exactly as it stops
  // every other shove).
  let trapSprung: { tile: number; tokenId: number; sentHome: boolean } | null = null;
  let wolfBite: { tokenId: number; sentHome: boolean } | null = null;
  if (!causesWin && to >= 0 && to < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[to].isContested) {
    const knockBack = (distance: number): boolean | null => {
      const working: GameState = { ...state, tokens };
      const victim = tokens.find((t) => t.id === tokenId)!;
      if (isProtected(working, nextPower, victim)) return null;
      // No wound split any more (2026-09-17): isProtected already excludes
      // a Blessed/walled stone, so a knockback that reaches here is always
      // a real send-home if it lands home at all.
      const landing = computeKnockbackLanding(working, nextPower, victim, distance);
      tokens = tokens.map((t) => (t.id === tokenId ? { ...t, position: landing } : t));
      if (landing === -1) {
        nextPower = clearThrallIfCaptured(nextPower, [tokenId]);
        nextPower = clearCurseOnCapture(nextPower, [tokenId]);
        nextPower = clearHamstringOnCapture(nextPower, [tokenId]);
        nextPower = clearInspireOnCapture(nextPower, [tokenId]);
        nextPower = clearWallsOnReserveTrip(nextPower, [tokenId]);
        // The trap is the FOE's kill of the mover's stone: bargainable.
        ({ tokens, power: nextPower } = applyDarkBargain(working.tokens, power, tokens, nextPower, [tokenId], foe, "ranged"));
      }
      return landing === -1;
    };

    if (nextPower.traps?.[foe] === to) {
      // The trap is consumed whether or not the victim was protected —
      // stepping on it springs it; armour only decides if it hurts. The
      // BOUNTY is paid on the same terms, for the same reason (see
      // TRAP_BOUNTY): the trap did its job by being stepped in.
      nextPower = { ...nextPower, traps: { ...nextPower.traps, [foe]: null } };
      const sentHome = knockBack(TRAP_KNOCKBACK);
      for (let i = 0; i < TRAP_BOUNTY; i++) nextPower = addCharge(nextPower, foe);
      trapSprung = { tile: to, tokenId, sentHome: sentHome === true };
    }
    // Re-read the mover's tile: a sprung trap may have moved it off the
    // wolf's square (or off the board entirely).
    const nowAt = tokens.find((t) => t.id === tokenId)!.position;
    if (nowAt >= 0 && wolfGuardTile({ ...state, tokens }, nextPower, foe) === nowAt) {
      const working: GameState = { ...state, tokens };
      const victim = tokens.find((t) => t.id === tokenId)!;
      if (!isProtected(working, nextPower, victim)) {
        // No wound split any more (2026-09-17): isProtected already
        // excludes a Blessed/walled stone, so the wolf always bites for
        // real when WOLF_CAPTURES is on.
        if (WOLF_CAPTURES) {
          const bitten = tokens;
          tokens = tokens.map((t) => (t.id === tokenId ? { ...t, position: -1 } : t));
          nextPower = clearThrallIfCaptured(nextPower, [tokenId]);
          nextPower = clearCurseOnCapture(nextPower, [tokenId]);
          nextPower = clearHamstringOnCapture(nextPower, [tokenId]);
          nextPower = clearInspireOnCapture(nextPower, [tokenId]);
          nextPower = clearWallsOnReserveTrip(nextPower, [tokenId]);
          ({ tokens, power: nextPower } = applyDarkBargain(bitten, power, tokens, nextPower, [tokenId], foe, "ranged"));
          nextPower = addCharge(nextPower, foe); // the kill pays the hunter, like any capture
          wolfBite = { tokenId, sentHome: true };
        } else {
          const sentHome = knockBack(WOLF_BITE_DISTANCE);
          if (sentHome !== null) wolfBite = { tokenId, sentHome };
        }
      }
    }
  }

  const extraTurn = landsOnShield;
  const nextState: GameState = {
    tokens,
    currentPlayer: extraTurn ? mover : otherPlayerId(mover),
    lastFlip: null,
    winner: causesWin ? mover : null,
    extraTurn,
  };
  return {
    state: nextState,
    power: resetTurnFlags(nextPower),
    rainOfArrows,
    wounded,
    mendedTokenIds,
    trapSprung,
    wolfBite,
  };
}

export function applyPowerMove(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): {
  state: GameState;
  power: PowerState;
  rainOfArrows: { targetTokenId: number | null } | null;
  wounded: { tokenId: number; to: number }[];
  mendedTokenIds: number[];
  trapSprung: { tile: number; tokenId: number; sentHome: boolean } | null;
  wolfBite: { tokenId: number; sentHome: boolean } | null;
} {
  const allCaptures = [...move.captures, ...move.bonusCaptures];
  return resolveTurn(
    state,
    power,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    rand,
  );
}

/** Warrior's Charge: same move, but the sweep captures ride along too. */
export function applyCharge(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): {
  state: GameState;
  power: PowerState;
  rainOfArrows: { targetTokenId: number | null } | null;
  wounded: { tokenId: number; to: number }[];
  mendedTokenIds: number[];
  trapSprung: { tile: number; tokenId: number; sentHome: boolean } | null;
  wolfBite: { tokenId: number; sentHome: boolean } | null;
} {
  const allCaptures = [...move.captures, ...move.bonusCaptures, ...move.chargeSweepCaptures];
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
  };
  // resolveTurn grants a charge back if this capture-laden move qualifies
  // under the normal economy (it almost always will) — that's correct, not
  // a double-spend: the -1 above IS the Charge action's cost, separate from
  // whatever this move's own capture(s) earn.
  return resolveTurn(
    state,
    spent,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    rand,
  );
}

/** Shared collision math for a hypothetical knockback of `distance` tiles
 *  against `target`: the landing tile it would end up on, or -1 if it
 *  collides/underflows and gets sent all the way home. Read-only —
 *  parameterized by distance so Push (computePushLanding, PUSH_DISTANCE/
 *  PUSH_WARD_DISTANCE via pushDistance()) and Charged Shot
 *  (computeChargedShotLanding, flat CHARGED_SHOT_DISTANCE) can each resolve
 *  their OWN collision math against a single shared source of truth for
 *  what counts as a send-home, without either one having to reimplement it. */
function computeKnockbackLanding(
  state: GameState,
  power: PowerState,
  target: TokenState,
  distance: number,
): number {
  const rawTo = target.position - distance;
  // A THRALL knocked below the contested row crumbles instead of landing:
  // tiles 0-3 in its position numbering are the VICTIM's private lane, and
  // a necromancer-controlled stone squatting the victim's own safe row
  // would break the game's most sacred guarantee. Symmetric with the >11
  // cap on its forward movement — leaving the row in EITHER direction ends
  // the possession (and a send-home is what -1 already means here, so the
  // pusher's functionally-a-capture refund applies as usual).
  if (possessorOf(power, target.id) !== null && rawTo < 4) return -1;
  // Same-owner tokens share a lane everywhere, so any position match is a
  // real collision. Different-owner tokens only physically share a tile in
  // the contested zone (positions 4-11 are the SAME square for both
  // players' path numbering) — a match outside it is two different tiles
  // that just happen to have the same index, not a collision. Without the
  // contested check here, a push could silently land an enemy token on top
  // of the pusher's own token (both owners, same contested tile), which
  // getLegalPowerMoves's single-token-per-tile assumptions can't handle.
  const contestedLanding = rawTo >= 0 && rawTo < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[rawTo].isContested;
  const collides = state.tokens.some(
    (t) =>
      t.id !== target.id &&
      t.position === rawTo &&
      (t.owner === target.owner || contestedLanding),
  );
  return collides || rawTo < 0 ? -1 : rawTo;
}

/** Archer's Push: see computeKnockbackLanding — used both to decide THIS
 *  turn's legal Push targets (see getPushTargets's Bulwark-aware filter
 *  below — the one case Bulwark blocks a Push) and to actually resolve a
 *  chosen push (applyPush). */
function computePushLanding(state: GameState, power: PowerState, target: TokenState): number {
  return computeKnockbackLanding(state, power, target, pushDistance(state, power, target));
}

/** Archer's Charged Shot: same idea as computePushLanding — CHARGED_SHOT_DISTANCE
 *  against an unwarded target, CHARGED_SHOT_WARD_DISTANCE against a Warded
 *  one (added 2026-07-16; previously flat regardless of Ward, back when a
 *  Warded target was fully excluded from getChargedShotTargets instead — see
 *  CHARGED_SHOT_WARD_DISTANCE's doc for why that changed). This is Charged
 *  Shot's own collision math, deliberately not reusing pushDistance()'s
 *  PUSH_DISTANCE/PUSH_WARD_DISTANCE values (the two abilities' Ward-tiers are
 *  independently tunable, per Kasen's requested strict ordering). Used by
 *  both getChargedShotTargets's Bulwark-aware filter and applyChargedShot. */
/** RETIRED tier collapsed 2026-09-17 — see pushDistance's identical note:
 *  a Warded target never reaches this any more, so the shot always flies
 *  CHARGED_SHOT_DISTANCE. */
function computeChargedShotLanding(state: GameState, power: PowerState, target: TokenState): number {
  void power;
  return computeKnockbackLanding(state, power, target, CHARGED_SHOT_DISTANCE);
}

/** Archer's Push: valid targets are enemy tokens on a contested tile that
 *  aren't protected — walls are absolute now (2026-09-17), so there is no
 *  more per-target Ward-affordability tier and no more "soft push still
 *  reaches a plain Bulwark" carve-out: a walled, Warded or Vanished stone
 *  simply never appears in this pool, the same single isProtected check
 *  every other targeted ability now uses. Ends the turn — no token of the
 *  pusher's moves (see applyPush's history note for why granting an extra
 *  turn here was tried and reverted). Refunds its charge (see applyPush)
 *  specifically when it sends the target all the way home to reserve —
 *  that outcome is functionally a capture — so it earns the same refund
 *  any other capturing action gets under the shared charge economy. A
 *  partial shove that leaves the target on the board is NOT a capture and
 *  never refunds. */
export function getPushTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

export function applyPush(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; woundedTokenId: number | null } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const landing = computePushLanding(state, power, target);
  // A send-home is functionally a capture — refunded below. No wound split
  // any more (2026-09-17): a Blessed/walled target is excluded from
  // getPushTargets outright, so it never reaches this code at all —
  // `woundedTokenId` stays in the return shape (the wire, the client)
  // always null.
  const sendsHome = landing === -1;

  let tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
  };
  if (sendsHome) {
    spentPower = addCharge(spentPower, mover);
    // A pushed-home THRALL dies for real (incl. the below-row crumble in
    // computeKnockbackLanding) — its possession entry falls with it. Ditto
    // a cursed one's chains, and the Blood Pact/Dark Bargain economy.
    spentPower = clearThrallIfCaptured(spentPower, [targetTokenId]);
    spentPower = clearCurseOnCapture(spentPower, [targetTokenId]);
    spentPower = clearHamstringOnCapture(spentPower, [targetTokenId]);
    spentPower = clearInspireOnCapture(spentPower, [targetTokenId]);
    ({ tokens, power: spentPower } = applyDarkBargain(state.tokens, power, tokens, spentPower, [targetTokenId], mover, "ranged"));
  }
  spentPower = breakShieldStreak(spentPower, mover); // Push never lands the mover on a shield
  // TRIED AND REVERTED: granting Push an extra turn (same mechanism as a
  // shield-tile landing — currentPlayer stays the mover) was meant to stop
  // Push from costing the Archer's own board progress, matching how
  // Warrior's Charge advances-while-capturing and Mage's Re-flip doesn't
  // end the turn at all. It compounds instead of just offsetting: a fully
  // charged Archer could chain 2 free pushes (CHARGE_CAP) THEN still make a
  // real move, 3 actions against the opponent's 1, every single round.
  // Result: archer-vs-mage 95.3/4.7, archer-vs-warrior 91.8/8.2 — nowhere
  // close to a fix, a total blowout. Reverted to ending the turn normally.
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(spentPower),
    woundedTokenId: null,
  };
}

/** Archer's Charged Shot: same target pool shape as Push — an enemy in
 *  shared water that isn't protected (2026-09-17: walls are absolute now,
 *  so the old Bulwark-vs-would-this-shot-send-home carve-out and the Ward
 *  distance tier both retired; a single isProtected check does the whole
 *  job). Gated on `power.charges[mover] === CHARGE_CAP` right here in the
 *  pure target-getter, unlike getPushTargets/getBulwarkTargets (whose
 *  baseline "at least 1 charge" gate is dispatch-layer/UI-only) — Charged
 *  Shot's affordability is a single uniform "has the mover banked the full
 *  cap at all" check, identical for every target, so baking it in here
 *  means the server dispatch, the bot, and the client's target highlights
 *  can never drift on it independently — an empty pool below the cap is
 *  the whole answer, everywhere this is called. */
export function getChargedShotTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < CHARGED_SHOT_COST) return [];
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

/** Archer's Charged Shot: spends BOTH banked charges (CHARGE_CAP) at once —
 *  like every other power action's pure apply* function, this doesn't
 *  self-guard on `power.charges[mover] === CHARGE_CAP`; the caller (see
 *  getChargedShotTargets's doc) already verified it. Refunds 1 charge via
 *  the exact same mechanism applyPush uses when it sends the target all the
 *  way home — reusing addCharge, not a reimplementation — so a hit nets -1
 *  charges (spend 2, refund 1) rather than Push's net 0 (spend 1, refund 1).
 *  Ends the turn, same as Push (no token of the Archer's own moves), and
 *  breaks any live shield streak for the same reason. */
export function applyChargedShot(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; woundedTokenId: number | null } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const landing = computeChargedShotLanding(state, power, target);
  // No wound split any more (2026-09-17) — see applyPush's identical note.
  const sendsHome = landing === -1;

  let tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CHARGED_SHOT_COST },
  };
  if (sendsHome) {
    spentPower = addCharge(spentPower, mover);
    // Same thrall-death rule as Push's — see clearThrallIfCaptured. And
    // the same curse reserve-trip hygiene + Blood Pact/Dark Bargain payout.
    spentPower = clearThrallIfCaptured(spentPower, [targetTokenId]);
    spentPower = clearCurseOnCapture(spentPower, [targetTokenId]);
    spentPower = clearHamstringOnCapture(spentPower, [targetTokenId]);
    spentPower = clearInspireOnCapture(spentPower, [targetTokenId]);
    ({ tokens, power: spentPower } = applyDarkBargain(state.tokens, power, tokens, spentPower, [targetTokenId], mover, "ranged"));
  }
  spentPower = breakShieldStreak(spentPower, mover); // Charged Shot never lands the mover on a shield
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(spentPower),
    woundedTokenId: null,
  };
}

/** Mage's Re-flip: spends a charge, does NOT end the turn — the caller
 *  re-rolls with flipCoins() and recomputes legal moves against the same
 *  (unmoved) GameState. Guarded to REFLIPS_PER_TURN per turn by
 *  reflipsUsedThisTurn (see canReflipAgain — the shared legality gate). */
export function applyReflip(power: PowerState, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - REFLIP_COST },
    reflipsUsedThisTurn: power.reflipsUsedThisTurn + 1,
  };
}

// ============================================================================
// ULTIMATES — see ULTIMATE_STREAK. Archer's Rain of Arrows (above) is
// passive and fully automatic; the rest are active — completing the
// shield-streak combo banks ultimateReady, and each class spends it on its
// own ultimate. Mage's Blink Strike auto-selects WHICH of the mover's own
// tokens relocates (most-advanced/Ward-carrying) rather than letting the
// player choose a source token, keeping the target-selection UI identical
// to Push's "tap one target" flow. Warrior's Shield Wall (below, with
// Bulwark) and Cleric's Benediction take no target at all — the whole
// on-board army is the subject, Corpse Explosion's instant-cast shape.
// ============================================================================

/** Mage's Blink Strike ultimate: valid targets are exactly Rain of Arrows'
 *  pool (contested-zone enemies, bypassing shield tiles, Ward, AND Bulwark —
 *  every ultimate punches through everything; 2026-07-17, Kasen's fix list
 *  dropped the old Bulwark-blocks-ultimates carve-out). Reused directly so
 *  the two rules can't drift. Empty if the mover has no on-board token to
 *  relocate at all. */
export function getBlinkStrikeTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findMostAdvancedToken(state, power, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Every REAL kill (or escape) clears the dead/departed token's wall AND
 *  Vanish entries (2026-09-17: replaces clearCapturedBulwarks +
 *  clearVitality in one call — a walled stone can only ever leave the
 *  board via an ultimate, since a wall blocks everything else, but the
 *  hygiene has to hold structurally, not just by the current cast list).
 *  Same call-site discipline as before: any path that sends a token home
 *  for good, or off the board via an escape, must run this. No-op (same
 *  reference back) when nothing in the list carried either entry. */
function clearWallsOnReserveTrip(power: PowerState, capturedIds: number[]): PowerState {
  const hit = capturedIds.some((id) => power.walls[id] !== undefined || power.vanished[id] !== undefined);
  if (!hit) return power;
  const walls = { ...power.walls };
  const vanished = { ...power.vanished };
  for (const id of capturedIds) {
    delete walls[id];
    delete vanished[id];
  }
  return { ...power, walls, vanished };
}

/** Mage's Blink Strike: instantly relocates the mover's most-advanced
 *  on-board token onto the target's tile, capturing it — bypassing shield
 *  tiles, Ward, and Bulwark, same as Rain of Arrows (see
 *  getBlinkStrikeTargets). Spends the banked ultimateReady flag, not a
 *  charge — but still grants a charge back on the capture, same as any
 *  other capturing action. Always ends the turn, even if the destination
 *  happens to be a shield tile — deliberately no extra-turn interaction
 *  here, given this codebase's history with extra-turn balance blowups. */
export function applyBlinkStrike(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const mine = findMostAdvancedToken(state, power, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let nextPower: PowerState = clearWallsOnReserveTrip(
    {
      ...power,
      ultimateReady: { ...power.ultimateReady, [mover]: false },
    },
    [targetTokenId],
  );
  nextPower = clearThrallIfCaptured(nextPower, [targetTokenId]);
  // Ultimates PIERCE the blessing — a blessed target dies for real here
  // (the wound split is resolveTurn's, for mortal weapons), and the dead
  // token's vitality entry clears with it. Curse hygiene + Blood Pact,
  // the same every-kill-path pair.
  nextPower = clearCurseOnCapture(nextPower, [targetTokenId]);
  nextPower = clearHamstringOnCapture(nextPower, [targetTokenId]);
  nextPower = clearInspireOnCapture(nextPower, [targetTokenId]);
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  // sweptTokenIds is always empty for Blink Strike — kept in the return
  // shape purely so callers that once handled applyWarpath's sweeps too
  // stayed uniform; Blink Strike itself never sweeps.
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: [] };
}

/** Warrior's Shield Wall ultimate (2026-09-17, replaces Warpath outright —
 *  the teleport-capture identity is gone, not kept alongside this): the
 *  ids the cast would actually CHANGE — every own on-board stone that
 *  isn't already walled (canHoldWall guard, moot here — only a Warrior
 *  ever reaches this). Empty pool = not castable, Benediction's misclick
 *  rule — this is mechanically Benediction's exact twin, see
 *  applyShieldWall's FLAG note. */
export function getShieldWallTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isWalled(power, t) && canHoldWall(power, t))
    .map((t) => t.id);
}

/** Warrior's Shield Wall: spends the banked ultimateReady flag to wall the
 *  whole on-board army at once (getShieldWallTargets' pool), with a turn
 *  of grace so the fresh walls don't collapse to the very next upkeep tick
 *  (an ultimate's privilege, same as Benediction's). Ends the turn with no
 *  extra-turn interaction and leaves the shield streak alone, matching its
 *  Blink Strike/Exhume/Benediction siblings. Grants nothing (no capture —
 *  Warpath's charge-on-capture economy is gone with it). FLAG: mechanically
 *  this is Cleric's Benediction twin (wall the army + a turn of free
 *  upkeep) — the difference is Hold the Line's discount vs Vigil/
 *  Sanctified Ground synergy; see Benediction's own doc for the same flag
 *  from the other side. Returns the walled ids so the server can announce
 *  the cast without re-deriving the pool.
 *
 *  C4 SIM CHECK (2026-09-17, 1000 games/matchup): Warrior's 9-matchup
 *  average landed at 51.68% (archer 51.5 / mage 49.6 / necromancer 52.7 /
 *  cleric 59.5 / rogue 46.1 / warlock 45.2 / hunter 54.1 / barbarian 55.0 /
 *  bard 51.4) — inside the 47-53 target band, every matchup inside the
 *  35/65 bar, shieldWall/g firing at a healthy low rate. Shipped as-is,
 *  no further tuning needed. */
export function applyShieldWall(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; walledTokenIds: number[] } {
  const walledTokenIds = getShieldWallTargets(state, power, mover);
  const walls = { ...power.walls };
  for (const id of walledTokenIds) walls[id] = "bulwark";
  const nextPower: PowerState = {
    ...power,
    walls,
    wallGrace: { ...power.wallGrace, [mover]: (power.wallGrace[mover] ?? 0) + 1 },
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), walledTokenIds };
}

// ============================================================================
// WARRIOR'S BULWARK — a second charge-spend active for Warrior (alongside
// Charge). The mover taps ONE OF THEIR OWN on-board tokens to raise a wall
// on it: full immunity to a normal capture, a Charge sweep or a Push
// (folded into isProtected/isWalled, so every existing capture-legality
// check above already respects it for free), and NOT to any ultimate —
// Rain of Arrows and Blink Strike punch straight through a wall, the
// roster convention (Shield Wall/Benediction never capture at all, so the
// question doesn't arise for them). This is the one power action that targets
// the MOVER'S OWN token instead of an enemy's or having no target at all.
// A wall is not free (2026-09-17): it bleeds wallUpkeepFor(power, mover)
// every one of the owner's turns (tickWallUpkeepForNewTurn) and falls the
// moment they can't pay it — no countdown, no save-count, no consumption
// by blocking a capture any more.
// ============================================================================

/** Warrior's Bulwark: valid targets are the mover's own on-board tokens
 *  that aren't already walled and CAN hold one at all (canHoldWall — the
 *  Barbarian's glass-cannon rule; moot here since only a Warrior ever
 *  reaches this pool, but the guard is uniform across every wall-granting
 *  pool). No point re-flagging an already-walled stone, so it's excluded
 *  from the target list entirely. */
export function getBulwarkTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  // Effective ownership: a warrior's token possessed against them is not
  // theirs to shield (and shielding the enemy's weapon would be absurd).
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isWalled(power, t) && canHoldWall(power, t))
    .map((t) => t.id);
}

/** Warrior's Bulwark: spends a charge to raise a wall on one of the
 *  mover's own on-board tokens (see WALL_BLEED for what it costs to keep
 *  up, tickWallUpkeepForNewTurn for the tick that charges it). Hold the
 *  Line banks HOLD_THE_LINE_FREE_TURNS of wallGrace on every cast — the
 *  fresh wall's own first upkeep bill (or, if grace is already banked,
 *  whichever wall is most-advanced when the tick runs — same front-first
 *  spend order tickWallUpkeepForNewTurn always uses) rides for free. No
 *  board movement at all — never lands the mover on a shield, so (like
 *  Push) it always breaks any live shield streak and always ends the
 *  turn, no extra-turn interaction. Doesn't grant a charge back — it
 *  doesn't capture anything itself. (The reinforced second-charge tier
 *  retired 2026-09-13, before the wall rework; see
 *  BULWARK_REINFORCED_RETIRED.) Like every other pure apply* here, this
 *  doesn't self-guard on affordability; the caller already verified it. */
export function applyBulwark(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    walls: { ...power.walls, [targetTokenId]: "bulwark" },
    wallGrace: { ...power.wallGrace, [mover]: (power.wallGrace[mover] ?? 0) + HOLD_THE_LINE_FREE_TURNS },
  };
  const broken = breakShieldStreak(spent, mover); // Bulwark never lands the mover on a shield
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(broken) };
}

/** Ids of the CURRENT mover's opponent's walled or Vanished tokens that
 *  their protection ACTUALLY blocked THIS flip — would have been captured
 *  by a normal move (including Snipe), a Charge sweep, or Push (only if
 *  the mover can actually afford it this turn), had the protection not
 *  been there. Ultimates are deliberately NOT considered: they pierce a
 *  wall outright, so a wall never "blocks" one. ANNOUNCEMENT ONLY
 *  (2026-09-17): a wall no longer expires or gets consumed by blocking —
 *  it falls only when its owner can't pay wallUpkeepFor it
 *  (tickWallUpkeepForNewTurn) — so this function is now a pure read with
 *  no state to mutate; it exists purely to tell the client "that would
 *  have connected."
 *
 *  Computed by diffing the real move lists against the SAME lists with
 *  every wall and Vanish switched off, rather than reimplementing any
 *  capture legality here — so this can never drift from the rules
 *  enforced above (isProtected/isWalled/isVanished). A token surfacing as
 *  a NEW capture once they're switched off, that isn't in the real
 *  (protection-respecting) result, means the wall or Vanish was the thing
 *  blocking it. */
export function getBulwarkBlockedIds(state: GameState, power: PowerState, flip: number): number[] {
  if (Object.keys(power.walls).length === 0 && Object.keys(power.vanished).length === 0) return [];
  const mover = state.currentPlayer;
  const unprotectedPower: PowerState = { ...power, walls: {}, vanished: {} };
  const blocked = new Set<number>();

  const realMoves = getLegalPowerMoves(state, power, flip);
  const openMoves = getLegalPowerMoves(state, unprotectedPower, flip);
  for (const om of openMoves) {
    // Charge's sweep is only a live threat if the mover could actually
    // afford AND use it this turn — otherwise the sweep numbers are
    // precomputed-but-unusable, and nothing is "blocking" anything real.
    const canCharge = power.charges[mover] >= 1 && om.chargeAvailable;
    const openCaptures = [...om.captures, ...om.bonusCaptures, ...(canCharge ? om.chargeSweepCaptures : [])];
    if (openCaptures.length === 0) continue;
    const rm = realMoves.find((m) => m.tokenId === om.tokenId && m.to === om.to);
    const realCaptures = rm
      ? [...rm.captures, ...rm.bonusCaptures, ...(canCharge ? rm.chargeSweepCaptures : [])]
      : [];
    for (const id of openCaptures) {
      if ((power.walls[id] !== undefined || power.vanished[id] !== undefined) && !realCaptures.includes(id)) {
        blocked.add(id);
      }
    }
  }

  return [...blocked];
}

/** Wall/Vanish block bookkeeping for the START of a brand-new turn (a
 *  fresh flip dealt to state.currentPlayer, NOT a Re-flip). No mutation
 *  any more (2026-09-17 — see getBulwarkBlockedIds): `power` passes
 *  through unchanged; only `blockedIds` is real, for the "Blocked!"
 *  announcement (same idea as lastRainOfArrows/lastUltimate). Call this
 *  once, right after tickWallUpkeepForNewTurn and move-list computation,
 *  from every place that commits a fresh turn, so the servers can't drift
 *  on it. */
export function tickBulwarkForNewTurn(
  state: GameState,
  power: PowerState,
  flip: number,
): { power: PowerState; blockedIds: number[] } {
  return { power, blockedIds: getBulwarkBlockedIds(state, power, flip) };
}

/** Same announcement, for a Re-flip's replacement roll — a fresh flip can
 *  reveal a block the original one didn't. No mutation, same as
 *  tickBulwarkForNewTurn. */
export function tickBulwarkForReflip(
  state: GameState,
  power: PowerState,
  flip: number,
): { power: PowerState; blockedIds: number[] } {
  return { power, blockedIds: getBulwarkBlockedIds(state, power, flip) };
}

// ============================================================================
// NECROMANCER (REWORKED 2026-07-19 — the Revive/thrall kit; the original
// Soul-Harvest-on-death + Raise Dead + Dark Resurrection kit is gone, see
// SOUL_BOUNTY_CHARGES for why). The class that raises the enemy's dead
// against them. Passive: Soul Harvest — QUALIFYING kills bank
// SOUL_BOUNTY_CHARGES up to NECRO_CHARGE_CAP (the soul gem, the only
// income that fills pip 3 — see grantKillBounty) and leave a corpse marker
// on the death tile (resolveTurn). Active: Revive (REVIVE_COST = the full
// soul bank) — consume the corpse, raise the killed ENEMY token where it
// died, and command it as a THRALL for THRALL_TURNS of the caster's turns
// (effectiveOwner is the whole possession mechanic; getLegalPowerMoves
// generates its row-chained moves). Ultimate: Exhume, unchanged. The
// class's persistent footprint is PowerState.corpse + PowerState.thrall.
// ============================================================================

/** Necromancer's Revive: THE legality-and-spawn oracle, shared by the
 *  server's validation, the bot, and the client's gem gate so the three
 *  can never drift (Charged Shot's bake-the-gate-in precedent — Revive's
 *  affordability is one uniform full-soul-bank check, and it has no
 *  target list to hang a per-target gate on). Returns the tile the thrall
 *  would rise on, or null when Revive is illegal right now:
 *  no corpse banked; the corpse token no longer waiting in reserve (the
 *  victim re-entered it — the denial counterplay — or it's already back
 *  on the board some other way); a thrall already up (one army slot); or
 *  the bank short of REVIVE_COST.
 *
 *  Spawn walk: the corpse tile itself when free, else the nearest free
 *  contested tile BEHIND it (Exhume's backward-walk temperament — further
 *  from tile 11 = more runway for the hunt), else forward of it. A free
 *  tile always exists: both armies total 8 tokens, the corpse itself lies
 *  in reserve, so at most 7 stand on the row's 8 tiles. Occupancy is any
 *  token at the numeric position — every candidate is contested (4-11),
 *  where both numberings share the square. */
export function getReviveSpawnTile(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): number | null {
  if (power.charges[mover] < REVIVE_COST) return null;
  if (power.thrall[mover] !== null) return null;
  const corpse = power.corpse[mover];
  if (!corpse) return null;
  const body = state.tokens.find((t) => t.id === corpse.tokenId);
  if (!body || body.position !== -1) return null; // dead-lettered: soul reclaimed
  const free = (tile: number) => !state.tokens.some((t) => t.position === tile);
  for (let tile = corpse.tile; tile >= 4; tile--) if (free(tile)) return tile;
  for (let tile = corpse.tile + 1; tile <= 11; tile++) if (free(tile)) return tile;
  return null; // unreachable by the counting argument above — kept as a guard
}

/** Necromancer's Revive: spends the whole soul bank, consumes the corpse
 *  (the body — the GRAVE stays open on the row for Corpse Explosion, see
 *  PowerState.grave), and raises the killed enemy token on
 *  getReviveSpawnTile's answer as a thrall for THRALL_TURNS. Does NOT end
 *  the turn — the caller keeps the
 *  SAME flip and recomputes legal moves against the new board (the risen
 *  stone may be the one that moves), exactly the Re-flip contract, and
 *  like Re-flip no resetTurnFlags and no streak interaction: a raise is a
 *  placement, not a landing (no charge, no extra turn, no streak link —
 *  the thrall EARNS streak links the honest way, by landing on tile 7).
 *
 *  FAIRNESS INVARIANT (load-bearing for the whole design): possession
 *  never leaves the victim worse off than the kill that enabled it. The
 *  token was already reserve-bound; expiry (tickThrallForNewTurn) and
 *  thrall-death (clearThrallIfCaptured at every send-home site) both end
 *  at that same reserve. The victim's only NEW cost is time: the token
 *  can't re-enter while it serves. The token carries no stale protection
 *  state by construction (bulwarked entries cleared at capture time), and
 *  can't be Warded/Bulwarked while possessed (isWarded/getBulwarkTargets
 *  refuse). Like every pure apply* here, no legality self-guard — the
 *  caller already consulted getReviveSpawnTile. */
export function applyRevive(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; raisedTokenId: number; raisedTo: number } {
  const corpse = power.corpse[mover]!;
  const tile = getReviveSpawnTile(state, power, mover)!;
  const tokens = state.tokens.map((t) => (t.id === corpse.tokenId ? { ...t, position: tile } : t));
  const nextPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - REVIVE_COST },
    corpse: { ...power.corpse, [mover]: null },
    thrall: { ...power.thrall, [mover]: { tokenId: corpse.tokenId, turnsLeft: THRALL_TURNS } },
  };
  return { state: { ...state, tokens }, power: nextPower, raisedTokenId: corpse.tokenId, raisedTo: tile };
}

/** Necromancer's Corpse Explosion: the blast's victim list, and THE
 *  legality oracle (Charged Shot's bake-it-in precedent — affordability is
 *  uniform, and an empty pool means "not castable" everywhere: server
 *  validation, bot, dock gate). Requires a GRAVE (PowerState.grave — the
 *  ground, which Revive leaves behind and a re-entered victim does not
 *  disarm; the raisable-body requirement was the old exclusive-rite
 *  design, see CORPSE_EXPLOSION_RADIUS's history) and CORPSE_EXPLOSION_COST
 *  banked — but NOT a free thrall slot, and not the full bank. Victims:
 *  enemy stones (by EFFECTIVE owner — the caster's own thrall is family;
 *  an enemy necromancer's thrall is fair game) on contested tiles within
 *  CORPSE_EXPLOSION_RADIUS of the grave, excluding everything protected
 *  (shield tile, Ward, Bulwark — the cheapest-per-target attack in the
 *  game gets no pierces). Empty when nothing would be struck: a blast
 *  with no victims is a misclick, not a choice. */
export function getCorpseExplosionTargets(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): number[] {
  if (power.charges[mover] < CORPSE_EXPLOSION_COST) return [];
  const grave = power.grave[mover];
  if (grave === null) return [];
  return state.tokens
    .filter((t) => effectiveOwner(power, t) !== mover)
    .filter((t) => t.position >= 4 && t.position <= 11)
    .filter((t) => Math.abs(t.position - grave) <= CORPSE_EXPLOSION_RADIUS)
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

/** Necromancer's Corpse Explosion: spends CORPSE_EXPLOSION_COST, consumes
 *  the GRAVE and — if the body is still banked — the corpse with it (the
 *  desecration: a blown grave raises nothing), and sends every oracle
 *  victim home (lethal since 2026-09-13; a blessed one is wounded in
 *  place). Desecration rule: blast send-homes pay NO bounty and mark NO
 *  corpse or grave (see CORPSE_EXPLOSION_COST's doc — chain explosions
 *  stay impossible), and unlike Push there is no send-home refund: the
 *  flat 2 is the whole price. A struck enemy THRALL that goes home dies
 *  for real (clearThrallIfCaptured). Ends the turn, breaks the caster's
 *  shield streak — Push's exact shape. Victims resolve nearest-the-grave
 *  first (deterministic). Returns the struck/sent-home lists so the
 *  server can announce the blast without re-deriving it. */
export function applyCorpseExplosion(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): {
  state: GameState;
  power: PowerState;
  struckTokenIds: number[];
  sentHomeIds: number[];
  woundedTokenIds: number[];
  tile: number;
} {
  const grave = power.grave[mover]!;
  const victims = getCorpseExplosionTargets(state, power, mover)
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .sort((a, b) => Math.abs(a.position - grave) - Math.abs(b.position - grave));

  let tokens = state.tokens;
  const sentHomeIds: number[] = [];
  const woundedTokenIds: number[] = [];
  let working: GameState = state;
  for (const victim of victims) {
    // Lethal: every body in the radius goes home. No wound split any more
    // (2026-09-17) — a blessed/walled body is excluded from
    // getCorpseExplosionTargets outright, so it never reaches this loop.
    sentHomeIds.push(victim.id);
    tokens = working.tokens.map((t) => (t.id === victim.id ? { ...t, position: -1 } : t));
    working = { ...working, tokens };
  }

  let nextPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CORPSE_EXPLOSION_COST },
    corpse: { ...power.corpse, [mover]: null },
    grave: { ...power.grave, [mover]: null },
  };
  nextPower = clearThrallIfCaptured(nextPower, sentHomeIds);
  nextPower = clearWallsOnReserveTrip(nextPower, sentHomeIds); // unreachable while a wall blocks the blast, but a reserve trip must never carry protection — same guard as every send-home path
  nextPower = clearCurseOnCapture(nextPower, sentHomeIds);
  nextPower = clearHamstringOnCapture(nextPower, sentHomeIds);
  nextPower = clearInspireOnCapture(nextPower, sentHomeIds);
  // Desecration denies the CASTER's income (no bounty, no corpse) — not
  // the VICTIM's compensation: a warlock's stones killed in the blast
  // may still strike their owner's Dark Bargain.
  ({ tokens, power: nextPower } = applyDarkBargain(state.tokens, power, tokens, nextPower, sentHomeIds, mover, "ranged"));
  nextPower = breakShieldStreak(nextPower, mover); // never lands the mover on a shield

  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(nextPower),
    struckTokenIds: victims.map((v) => v.id),
    sentHomeIds,
    woundedTokenIds,
    tile: grave,
  };
}

/** Thrall bookkeeping for the START of a brand-new turn — the
 *  tickBulwarkExpiry convention: call once per fresh flip dealt to
 *  state.currentPlayer (extra turns included, Re-flips not), and call it
 *  BEFORE computing the turn's move list AND before the Bulwark tick — a
 *  crumbling thrall changes the board both of those must read. Decrements
 *  the CURRENT player's own thrall; at 0 the possession ends and the
 *  token crumbles home to its real owner's reserve (position -1, the
 *  fairness invariant's terminus). Returns the crumbled token id so the
 *  server can announce it (lastThrallExpired), or null. */
export function tickThrallForNewTurn(
  state: GameState,
  power: PowerState,
): { state: GameState; power: PowerState; expiredTokenId: number | null } {
  const mover = state.currentPlayer;
  const th = power.thrall[mover];
  if (!th) return { state, power, expiredTokenId: null };
  const turnsLeft = th.turnsLeft - 1;
  if (turnsLeft > 0) {
    return {
      state,
      power: { ...power, thrall: { ...power.thrall, [mover]: { ...th, turnsLeft } } },
      expiredTokenId: null,
    };
  }
  const tokens = state.tokens.map((t) => (t.id === th.tokenId ? { ...t, position: -1 } : t));
  return {
    state: { ...state, tokens },
    power: { ...power, thrall: { ...power.thrall, [mover]: null } },
    expiredTokenId: th.tokenId,
  };
}

/** Necromancer's Exhume ultimate: valid targets are the opponent's ESCAPED
 *  tokens (position >= PATH_LENGTH_PER_PLAYER) — empty if none have
 *  escaped yet, the same "structurally nothing to do" empty-pool shape as
 *  Blink Strike with no on-board token. Nothing protects an escaped token:
 *  shield tiles and Ward derive from board position (both exclude escaped
 *  positions already), transient safety cannot survive the escaping move
 *  itself (resolveTurn clears the mover's), and a stale Bulwark entry is
 *  deliberately ignored here AND stripped on the way back (see
 *  applyExhume) — death claims all. ultimateReady gating stays at the
 *  dispatch layer, same as Blink Strike. */
export function getExhumeTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  void power; // uniform target-getter signature; nothing in PowerState gates this pool
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= PATH_LENGTH_PER_PLAYER)
    .map((t) => t.id);
}

// ============================================================================
// CLERIC (added 2026-07-21; RE-THEMED 2026-09-17 for the wall system —
// Kasen's original spec was "increase maximum hp to 2 and heal them," and
// the class kept that shape until Blessing joined the wall system). The
// class that refuses to trade. Passive: SANCTIFIED GROUND — a shield-tile
// landing waives the cleric's own wall upkeep for a turn (resolveTurn's
// wallGrace grant; the old mend-wounded-to-blessed retired with the wound
// split). Actives: BLESS (BLESS_COST, keeps the turn) raises a wall on one
// stone — uncapturable except by an ultimate, same as a Warrior's Bulwark,
// and it bleeds the same WALL_BLEED (Hold the Line's discount is
// Warrior-only). VIGIL (VIGIL_COST, ends the turn, was HEAL) waives ALL of
// the cleric's walls' upkeep for one turn — worthless with a single wall,
// the reason to hold two or more. Ultimate: BENEDICTION — wall the whole
// on-board army at once, with a turn of grace so the fresh walls don't
// collapse the instant they're cast. Ultimates still pierce every wall.
// ============================================================================

/** How many of `mover`'s own stones currently carry a LIVE wall —
 *  BLESSING_CAP's gate on Bless's pool (VIGIL_COST no longer cares —
 *  waiving upkeep never adds a wall). Ownership is real ownership (walls
 *  only ever mark the cleric's own stones for a Blessing, but the filter
 *  keeps a mirror's two ledgers separate). */
function liveBlessings(state: GameState, power: PowerState, mover: PlayerId): number {
  return Object.entries(power.walls).filter(
    ([id, kind]) => kind === "blessing" && state.tokens.find((t) => t.id === Number(id))?.owner === mover,
  ).length;
}

/** Cleric's Bless: valid targets are the cleric's own on-board stones that
 *  aren't already walled and CAN hold one (canHoldWall — moot here, only a
 *  Cleric ever reaches this pool, but uniform across every wall-granting
 *  pool). Affordability AND the BLESSING_CAP are baked in (Charged Shot's
 *  precedent — uniform checks, identical for every target), so an empty
 *  pool is the whole legality answer everywhere: server validation, bot,
 *  dock gate. Effective ownership: a stone possessed against the cleric is
 *  not theirs to bless (and blessing the enemy's weapon would be absurd —
 *  getBulwarkTargets's rule). Private-lane stones are eligible, same as
 *  Bulwark's pool: blessing a stone that can't be attacked is
 *  legal-but-wasteful, the bot's problem, not the rulebook's. */
export function getBlessTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < BLESS_COST) return [];
  if (liveBlessings(state, power, mover) >= BLESSING_CAP) return [];
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isWalled(power, t) && canHoldWall(power, t))
    .map((t) => t.id);
}

/** Cleric's Bless: spends BLESS_COST to raise a wall on one own stone
 *  (kind "blessing" — uncapturable except by an ultimate, and it bleeds
 *  WALL_BLEED like any wall). Does NOT end the turn — Revive's exact
 *  contract: the caller keeps the SAME flip and recomputes legal moves
 *  (the board itself is untouched — only a flag changed — but the
 *  recompute keeps the contract uniform), so the cleric blesses AND still
 *  marches. That turn-keeping is load-bearing balance, not a nicety: as a
 *  turn-ending cast the class lost 72.9/27.1 to archer and 75.7/24.3 to
 *  mage at 1200/matchup even with BLESS_COST=1 — a whole turn per cast
 *  against classes that spend none was the structural hole (the mana
 *  price is real; the tempo price was fatal). Like Revive: no
 *  resetTurnFlags, no streak interaction (a blessing is a prayer, not a
 *  landing — the streak lives or dies by the move that follows), no
 *  charge grant, and no affordability self-guard (the caller already
 *  consulted getBlessTargets). At most CHARGE_CAP casts can fund
 *  themselves in one turn, so the act-then-redecide loop is bounded by
 *  the bank exactly like Re-flip's is. */
export function applyBless(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - BLESS_COST },
    walls: { ...power.walls, [targetTokenId]: "blessing" },
  };
  return { state, power: spent };
}

/** Cleric's Vigil (2026-09-17, replaces Heal under the wall rework): no
 *  target — it waives upkeep for every wall the mover already holds, not
 *  one stone specifically (the whole point is a multi-wall tool). Legal
 *  only when the mover can afford it AND holds at least one wall — a
 *  vigil over nothing is a misclick, Corpse Explosion's precedent. */
export function canCastVigil(state: GameState, power: PowerState, mover: PlayerId): boolean {
  if (power.charges[mover] < VIGIL_COST) return false;
  return state.tokens.some((t) => t.owner === mover && power.walls[t.id] !== undefined);
}

/** Cleric's Vigil: spends VIGIL_COST to bank one turn of wall-upkeep grace
 *  (consumed by tickWallUpkeepForNewTurn, front wall first, same order as
 *  payment). ENDS the turn — Bulwark's exact shape (no board movement,
 *  never lands on a shield, so it breaks any live streak) — deliberately
 *  NOT Bless's turn-keeping contract, the same tempo-price discipline
 *  HEAL_COST's old doc recorded (a turn-keeping mend/vigil let the class
 *  farm blessings for free; ending the turn is what makes the trade real).
 *  Worthless with a single wall (pay VIGIL_COST to skip one wall's
 *  cheaper upkeep is a losing trade) — the tool is for two or more. */
export function applyVigil(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - VIGIL_COST },
    wallGrace: { ...power.wallGrace, [mover]: (power.wallGrace[mover] ?? 0) + 1 },
  };
  const broken = breakShieldStreak(spent, mover);
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(broken) };
}

/** Cleric's Benediction ultimate: the ids the cast would actually CHANGE —
 *  every own on-board stone that isn't already walled (canHoldWall guard,
 *  moot here). Empty pool = not castable (a benediction that walls no one
 *  is a misclick, not a choice — Corpse Explosion's precedent).
 *  ultimateReady gating stays at the dispatch layer, same as Blink
 *  Strike/Exhume (and Shield Wall's own version of this same pool). */
export function getBenedictionTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isWalled(power, t) && canHoldWall(power, t))
    .map((t) => t.id);
}

/** Cleric's Benediction: spends the banked ultimateReady flag to wall the
 *  whole on-board army at once (getBenedictionTargets' pool), with a turn
 *  of grace so the fresh walls don't collapse to the very next upkeep tick
 *  (2026-09-17 — an ultimate's privilege, consistent with "ultimates
 *  ignore walls" cutting both ways: they also ignore the price of raising
 *  one). Ends the turn with no extra-turn interaction and — unlike the
 *  charge-spend actives — leaves the shield streak alone, exactly matching
 *  its Blink Strike/Exhume/Shield Wall siblings. Grants nothing (no capture).
 *  Returns the walled ids so the server can announce the cast without
 *  re-deriving the pool. FLAG: mechanically this is Warrior's Shield Wall
 *  twin (wall the army + a turn of free upkeep) — the difference is
 *  Vigil/Sanctified Ground synergy vs Hold the Line's discount. If the
 *  table can't tell them apart, that is a second ticket, not a bug here. */
export function applyBenediction(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; blessedTokenIds: number[] } {
  const blessedTokenIds = getBenedictionTargets(state, power, mover);
  const walls = { ...power.walls };
  for (const id of blessedTokenIds) walls[id] = "blessing";
  const nextPower: PowerState = {
    ...power,
    walls,
    wallGrace: { ...power.wallGrace, [mover]: (power.wallGrace[mover] ?? 0) + 1 },
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), blessedTokenIds };
}

/** Necromancer's Exhume: drags the escaped target back to
 *  EXHUME_RETURN_POSITION, walking backward one tile at a time past any
 *  occupied square — same collision semantics as computeKnockbackLanding
 *  (own-owner tokens collide anywhere on the target's path; cross-owner
 *  only on a contested tile), reimplemented as a walk rather than reusing
 *  that function because a knockback resolves ONE candidate tile to
 *  home-or-not, while Exhume keeps searching for the nearest free tile
 *  (it must never itself send the token home or capture — it's a return,
 *  not an attack). The walk can't leave the contested row in practice
 *  (see EXHUME_RETURN_POSITION's doc), and if it ever underflowed, -1 is
 *  the reserve — a harmless degenerate fallback, not a crash. Spends
 *  ultimateReady (never a charge), grants nothing (no capture happened),
 *  ends the turn with no extra-turn interaction, and leaves the shield
 *  streak alone — all exactly matching its Blink Strike sibling.
 *  Strips any stale wall the token carried off the board (an escaped
 *  stone's wall is cleared on the way out — see resolveTurn's escape
 *  branch — but this stays as the same belt-and-suspenders every
 *  ultimate-capture path carries) so it can't ride back as free un-recast
 *  protection. Returns `returnedTo` so the server can announce/animate
 *  the landing tile without re-deriving the walk client-side. */
export function applyExhume(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; returnedTo: number } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  let landing = EXHUME_RETURN_POSITION;
  while (landing >= 0) {
    const contested = BOARD_LAYOUT[landing].isContested;
    const occupied = state.tokens.some(
      (t) => t.id !== target.id && t.position === landing && (t.owner === target.owner || contested),
    );
    if (!occupied) break;
    landing--;
  }

  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  const nextPower: PowerState = {
    ...clearWallsOnReserveTrip(power, [targetTokenId]),
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), returnedTo: landing };
}

// ============================================================================
// ROGUE (added 2026-07-21, reworked 2026-07-22) — the thief. Passive:
// LARCENY — every real kill the Rogue lands drains ROGUE_STEAL_ON_CAPTURE
// mana from the victim's owner too (wired into resolveTurn; see
// ROGUE_STEAL_ON_CAPTURE's doc for why Grand Heist doesn't also stack it).
// Actives: PICKPOCKET (PICKPOCKET_COST) drains a target's bank directly
// without capturing — no protection applies, since nothing is attacking the
// stone itself. VANISH (VANISH_COST) grants one of the mover's own stones
// Bulwark-identical protection — untargetable and uncapturable for
// VANISH_TURNS — the class's missing defensive lever (see VANISH_COST's
// doc for why this reuses Bulwark's mechanic outright rather than a
// parallel system, and for the discarded Backstab shield-breaker rework it
// replaces). Ultimate: GRAND HEIST teleport-captures like Blink Strike,
// pierces everything (Bulwark and Blessing included — every ultimate does),
// and drains the victim's ENTIRE remaining bank on the kill. The class has
// no PowerState field fully its own — Larceny/Pickpocket read and write the
// existing `charges` map, and Vanish shares Bulwark's `bulwarked` map.
// ============================================================================

/** Rogue's Pickpocket: valid targets are enemy stones in shared water that
 *  actually have mana worth stealing (power.charges[foe] >= 1) — a target
 *  pool that offered a 0-mana stone would be a legal-but-worthless trap,
 *  the exact failure mode this codebase has burned real sessions on before
 *  (see PUSH_WARD_DISTANCE=0's own history). Since the effect is bank-level
 *  rather than stone-level, shield tiles, Ward, and Bulwark are all
 *  irrelevant here — reused directly from getRainOfArrowsTargets's "any
 *  enemy on a contested tile" pool (that function already resolves
 *  possession/thrall correctly via effectiveOwner) rather than
 *  reimplementing the same contested-zone walk. Affordability
 *  (PICKPOCKET_COST) baked in, uniform for every target. */
export function getPickpocketTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  // RETIRED 2026-09-13 (user's call): with Backstab back the Rogue had
  // three actives, and Larceny already drains the purse on every kill.
  // Kit is Larceny / Backstab / Vanish / Grand Heist. The oracle is the
  // gate everywhere (client, validator, bot, sim), so an empty pool retires
  // the cast without unthreading its turn-keeping plumbing — Hamstring's
  // own precedent. The apply path stays for tests and for a future return.
  if (PICKPOCKET_RETIRED) return [];
  if (power.charges[mover] < PICKPOCKET_COST) return [];
  const foe = otherPlayerId(mover);
  if (power.charges[foe] < 1) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Rogue's Pickpocket: spends PICKPOCKET_COST, drains PICKPOCKET_STEAL from
 *  the foe's bank (floored at 0 — the oracle already guarantees at least 1
 *  is there, but the floor stays as defensive hygiene against a stale
 *  target id from a race). Does NOT end the turn (Re-flip/Bless's
 *  contract) and does not touch the board at all — no tokens move, no
 *  vitality/Bulwark/thrall bookkeeping applies, since nothing was
 *  captured. Leaves the shield streak untouched, same as Re-flip. */
export function applyPickpocket(power: PowerState, mover: PlayerId): PowerState {
  const foe = otherPlayerId(mover);
  return {
    ...power,
    charges: {
      ...power.charges,
      [mover]: power.charges[mover] - PICKPOCKET_COST,
      [foe]: Math.max(0, power.charges[foe] - PICKPOCKET_STEAL),
    },
  };
}

/** Rogue's Vanish: valid targets are the mover's own on-board tokens that
 *  aren't already hidden — no afford check here, matching Bulwark's own
 *  established convention — the caller gates on charges. */
export function getVanishTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isVanished(power, t))
    .map((t) => t.id);
}

/** Rogue's Vanish: spends VANISH_COST to hide one of the mover's own
 *  on-board tokens for VANISH_TURNS of the mover's own turns (own map since
 *  2026-09-17 — see PowerState.vanished; a fixed-duration dodge, not a
 *  paid wall). No board movement at all, so it always breaks any live
 *  shield streak and always ends the turn; doesn't grant a charge back,
 *  since it doesn't capture anything itself. */
/** Rogue's Backstab: valid targets are enemy stones in shared water that
 *  aren't protected — walls are absolute now (2026-09-17), so the old
 *  "Ward pierced by simple omission" carve-out is gone: a single
 *  isProtected check blocks it same as every other non-ultimate strike.
 *  Affordability baked in. */
export function getBackstabTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < BACKSTAB_COST) return [];
  return getRainOfArrowsTargets(state, power, mover).filter((id) => {
    const t = state.tokens.find((tok) => tok.id === id)!;
    return !isProtected(state, power, t);
  });
}

/** Rogue's Backstab: spends BACKSTAB_COST for a guaranteed hit — no
 *  distance/collision math (a direct strike, not a shove), a real kill
 *  every time (2026-09-17: no more wound split — a Blessed/walled target
 *  is excluded from the pool outright). Does NOT refund (an unconditional
 *  hit that also refunded was a net -1-mana always-available kill and blew
 *  out the first balance pass) but carries every reserve-trip hygiene a
 *  capture does and triggers Larceny's drain on top. The mover never
 *  moves, so it never lands on a shield: breaks any live streak. */
export function applyBackstab(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; woundedTokenId: number | null } {
  const foe = otherPlayerId(mover);
  let tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: -1 } : t));

  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - BACKSTAB_COST },
  };
  spentPower = clearThrallIfCaptured(spentPower, [targetTokenId]);
  spentPower = clearWallsOnReserveTrip(spentPower, [targetTokenId]);
  spentPower = clearCurseOnCapture(spentPower, [targetTokenId]);
  spentPower = clearHamstringOnCapture(spentPower, [targetTokenId]);
  spentPower = clearInspireOnCapture(spentPower, [targetTokenId]);
  // Larceny: a real kill drains the victim's bank.
  spentPower = {
    ...spentPower,
    charges: {
      ...spentPower.charges,
      [foe]: Math.max(0, spentPower.charges[foe] - ROGUE_STEAL_ON_CAPTURE),
    },
  };
  // Then the victim's own Dark Bargain, in Larceny's shadow (the ordering
  // BLOOD_PACT_CHARGES's doc fixes for every kill).
  ({ tokens, power: spentPower } = applyDarkBargain(state.tokens, power, tokens, spentPower, [targetTokenId], mover, "ranged"));
  spentPower = breakShieldStreak(spentPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(spentPower),
    woundedTokenId: null,
  };
}

export function applyVanish(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - VANISH_COST },
    vanished: { ...power.vanished, [targetTokenId]: VANISH_TURNS },
  };
  const broken = breakShieldStreak(spent, mover);
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(broken) };
}

/** Rogue's Grand Heist ultimate: same target eligibility as Blink Strike —
 *  Rain of Arrows' pool (every protection pierced), empty if the
 *  mover has no on-board token to relocate. */
export function getGrandHeistTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findMostAdvancedToken(state, power, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Rogue's Grand Heist: instantly relocates the mover's most-advanced
 *  on-board token onto the target's tile, capturing it — bypassing shield
 *  tiles, Ward, and Bulwark, same as every other ultimate — then drains
 *  the target owner's ENTIRE remaining bank, not just ROGUE_STEAL_ON_
 *  CAPTURE's flat amount (Larceny's own drain is deliberately NOT also
 *  applied here — this supersedes it as the bigger, ultimate-tier version
 *  of the same idea, not a stack on top of it). Spends ultimateReady, not
 *  a charge; still grants exactly 1 charge back on the capture, matching
 *  Blink Strike's own economy. Always ends the turn — no
 *  extra-turn interaction. */
export function applyGrandHeist(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const mine = findMostAdvancedToken(state, power, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const foe = otherPlayerId(mover);
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let nextPower: PowerState = clearWallsOnReserveTrip(
    { ...power, ultimateReady: { ...power.ultimateReady, [mover]: false } },
    [targetTokenId],
  );
  nextPower = clearThrallIfCaptured(nextPower, [targetTokenId]);
  nextPower = clearCurseOnCapture(nextPower, [targetTokenId]);
  nextPower = clearHamstringOnCapture(nextPower, [targetTokenId]);
  nextPower = clearInspireOnCapture(nextPower, [targetTokenId]);
  // Blood Pact's grant lands here — and the drain-to-zero below takes it
  // straight back. Deliberate (see BLOOD_PACT_CHARGES's ordering note):
  // the heist robs the grave too. The call stays for uniform kill-path
  // discipline, not effect.
  nextPower = addCharge(nextPower, mover);
  nextPower = { ...nextPower, charges: { ...nextPower.charges, [foe]: 0 } };
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower) };
}

// ============================================================================
// WARLOCK (added 2026-07-26) — profits from its own dead; the only class
// that WANTS to lose stones. Passive: DARK BARGAIN (2026-09-16, replaced
// Blood Pact) — an enemy's sub-ultimate kill of a warlock stone becomes a
// one-tile retreat and the death of the warlock's least-advanced other
// stone instead, paying BLOOD_PACT_CHARGES (applyDarkBargain, threaded
// through every sub-ultimate kill path the way clearVitality is). Actives:
// CURSE OF CHAINS (CURSE_COST, keeps the turn) shortens one enemy stone's
// every move by CURSE_SLOW for CURSE_TURNS of the victim's turn-starts —
// the game's only move-DISTANCE modifier; SACRIFICE (SACRIFICE_COST, the
// full bank) trades the warlock's own most-advanced stone for a kill
// through Ward and Blessing — the magical half of the defense roster,
// pierced below ultimate tier (Bulwark/Vanish/shield tiles still block it).
// Ultimate: FEL STORM drags every enemy stone in shared water back to the
// row's gate (FEL_STORM_RETURN_POSITION), through everything. The class's
// persistent footprint is PowerState.curse.
// ============================================================================

/** Warlock's Curse of Chains: valid targets are enemy stones in shared
 *  water — getRainOfArrowsTargets' pool (possession resolved via
 *  effectiveOwner) minus two exclusions: a VANISHED stone (untargetable by
 *  every enemy ability below an ultimate — Vanish's absolute contract) and
 *  the stone the mover's own curse already binds (re-cursing it would be a
 *  full-price no-op — the pool refusing it is the same legal-but-worthless
 *  trap-avoidance getPickpocketTargets documents). Ward, Bulwark,
 *  Blessing, and shield tiles do NOT block it — the chains bind the legs,
 *  not the armor; nothing is captured or moved, Pickpocket's own
 *  reasoning. Affordability (CURSE_COST) baked in, uniform for every
 *  target. */
export function getCurseTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < CURSE_COST) return [];
  return getRainOfArrowsTargets(state, power, mover)
    .filter((id) => !isVanished(power, state.tokens.find((t) => t.id === id)!))
    .filter((id) => power.curse[mover]?.tokenId !== id);
}

/** Warlock's Curse of Chains: spends CURSE_COST and aims the mover's single
 *  curse slot at the target for CURSE_TURNS of the victim's turn-starts —
 *  overwriting any previous mark (one curse per warlock; the old chains
 *  lift the instant the new ones bind). Does NOT end the turn
 *  (Re-flip/Bless/Pickpocket's contract) and touches no token positions —
 *  the whole effect lives in getLegalPowerMoves's per-token filter.
 *  Leaves the shield streak untouched, same as every turn-keeper. */
export function applyCurse(power: PowerState, targetTokenId: number, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CURSE_COST },
    curse: { ...power.curse, [mover]: { tokenId: targetTokenId, turnsLeft: CURSE_TURNS } },
  };
}

/** Curse bookkeeping for the START of a brand-new turn — the
 *  tickThrallForNewTurn convention exactly: call once per fresh flip dealt
 *  to state.currentPlayer (extra turns included, Re-flips not), BEFORE
 *  computing the turn's move list — an expiring curse frees the stone for
 *  THIS turn's moves. Decrements the curse AFFLICTING the current player
 *  (i.e. the one cast by their opponent — curse slots are keyed by
 *  caster); at 0 the chains lift. Returns the freed token id so the
 *  server can announce it (lastCurseExpired), or null. */
export function tickCurseForNewTurn(
  state: GameState,
  power: PowerState,
): { power: PowerState; expiredTokenId: number | null } {
  const caster = otherPlayerId(state.currentPlayer);
  const c = power.curse[caster];
  if (!c) return { power, expiredTokenId: null };
  const turnsLeft = c.turnsLeft - 1;
  if (turnsLeft > 0) {
    return {
      power: { ...power, curse: { ...power.curse, [caster]: { ...c, turnsLeft } } },
      expiredTokenId: null,
    };
  }
  return {
    power: { ...power, curse: { ...power.curse, [caster]: null } },
    expiredTokenId: c.tokenId,
  };
}

/** Warlock's Sacrifice: valid targets are enemy stones in shared water that
 *  aren't protected — walls are absolute now (2026-09-17), so the ritual
 *  LOST its Ward-and-Blessing pierce along with every other bespoke
 *  breaker (a real identity loss for this cast; flagged, not fixed here —
 *  the sim decides whether it needs a new lever). Empty when the warlock
 *  has no on-board stone to give (the ritual needs blood —
 *  findMostAdvancedToken's null, Blink Strike's shape) or can't afford the
 *  cast (baked in, Charged Shot's uniform-cost convention). */
export function getSacrificeTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < SACRIFICE_COST) return [];
  if (!findMostAdvancedToken(state, power, mover)) return [];
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

/** Warlock's Sacrifice: sends the mover's own MOST-ADVANCED on-board stone
 *  home and kills the target outright — a guaranteed kill at range on
 *  whatever unprotected stone the ritual reaches (2026-09-17: no longer a
 *  pierce, since the target pool already excludes every protection). The
 *  kill banks no capture charge (desecrate economy — see SACRIFICE_COST),
 *  and Blood Pact deliberately does NOT pay for the stone
 *  the warlock spends itself (see below). Ends the turn, breaks the shield
 *  streak. Returns the sacrificed stone's id so the server can announce
 *  both deaths.
 *
 *  THE RITUAL DEMANDS YOUR BEST, NOT YOUR WORST — and this is a balance
 *  decision before it is a flavor one. First implementation auto-selected
 *  the LEAST-advanced stone (Warpath's convention, chosen to keep the
 *  one-tap targeting UI). That made the "a body" half of the price
 *  routinely free: the rearmost stone is usually sitting on tile 0-4 with
 *  no run invested, so a guaranteed pierce-kill cost little more than the
 *  mana. Measured at 500-600 games/matchup, least-advanced vs
 *  most-advanced with everything else identical:
 *    archer   25.6/74.4 -> 36.2/63.8
 *    warrior  34.0/66.0 -> 44.2/55.8
 *    cleric   30.0/70.0 -> 48.6/51.4
 *    rogue    30.0/70.0 -> 34.4/65.6
 *    mirror   47.5/52.5 -> 49.4/50.6
 *  Every matchup moved toward parity and none moved away — the clean
 *  result a real root-cause fix gives, versus the compensating-lever
 *  shape this file's history is full of. Spending the lead runner makes
 *  the trade self-limiting: it is worth it to remove a deep enemy runner
 *  or something no other tool can touch, and never worth it as a routine
 *  attrition loop. Cross-check on the same runs: mage-vs-warlock sits
 *  61/39 mage-favored, consistent with Mage's known roster-wide edge
 *  rather than anything warlock-specific — do not "fix" that here. */
export function applySacrifice(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sacrificedTokenId: number } {
  const mine = findMostAdvancedToken(state, power, mover)!;
  const killed = [mine.id, targetTokenId];
  let tokens = state.tokens.map((t) => (killed.includes(t.id) ? { ...t, position: -1 } : t));
  let nextPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - SACRIFICE_COST },
  };
  // The full kill-path hygiene set: the target could be a thrall (a mercy
  // kill of the mover's own possessed stone — effectiveOwner made it an
  // enemy) or cursed; the sacrificed stone could itself be cursed. Wall
  // hygiene is a structural no-op (neither stone can carry one — the pool
  // excludes every protected target and a warlock's own stones are never
  // wall-eligible) but stays for uniform discipline.
  nextPower = clearWallsOnReserveTrip(nextPower, killed);
  nextPower = clearThrallIfCaptured(nextPower, killed);
  nextPower = clearCurseOnCapture(nextPower, killed);
  nextPower = clearHamstringOnCapture(nextPower, killed);
  nextPower = clearInspireOnCapture(nextPower, killed);
  // THE PACT DOES NOT PAY FOR SUICIDE. Blood Pact covers blood the ENEMY
  // spills, never blood the warlock spends itself — so the sacrificed
  // stone is excluded here (an enemy warlock's stone dying as the TARGET
  // in a mirror still pays its own owner, hence filtering by id rather
  // than skipping the call). Corpse Explosion's desecrate rule is the
  // precedent: an ability may deny its own caster the income its kills
  // would normally pay.
  //
  // This is not a flavor nicety, it is the ability's whole economy. First
  // balance run WITH the refund: sacrifice/g hit 14-95 and the warlock
  // took 76-89% off the entire field, because SACRIFICE_COST(2) minus the
  // refund(1) made a guaranteed pierce-kill cost ~1 mana. (The stone spent
  // was ALSO nearly free at the time — that was the other half of the same
  // blowout, fixed separately by switching the auto-selection to the
  // most-advanced stone; see this function's own doc.) The warlock mirror
  // stalemated 45-49% of games at the 1000-turn cap: both sides farmed
  // their own bodies forever and nobody raced. Without the refund the cast
  // costs the full bank AND a real runner, which is the trade the ability
  // was designed around.
  ({ tokens, power: nextPower } = applyDarkBargain(
    state.tokens,
    power,
    tokens,
    nextPower,
    killed.filter((id) => id !== mine.id),
    mover,
    "ranged",
  ));
  nextPower = breakShieldStreak(nextPower, mover); // an attack, not a placement
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sacrificedTokenId: mine.id };
}

/** Warlock's Fel Storm: the victim pool is every enemy stone in shared
 *  water — getRainOfArrowsTargets verbatim (the ultimate pool: every
 *  protection pierced, possession resolved). Empty pool = no one to drag
 *  = not castable (Benediction's misclick rule). ultimateReady gating
 *  stays at the dispatch layer, same as every active ultimate. */
export function getFelStormTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return getRainOfArrowsTargets(state, power, mover);
}

/** Warlock's Fel Storm: drags every victim back to the row's gate —
 *  most-advanced placed first at FEL_STORM_RETURN_POSITION, each later
 *  victim walking further down its own path (applyExhume's collision
 *  semantics against the working board, corpse explosion's sequential
 *  discipline) so the pack stacks 4, 3, 2, ... in preserved order. A
 *  THRALL whose walk lands below tile 4 crumble-dies instead (the
 *  chained-to-the-row rule — computeKnockbackLanding's precedent), a real
 *  death: thrall entry cleared, Blood Pact paid to its real owner, and it
 *  goes to that owner's reserve. Ordinary victims walking below 4 land in
 *  their OWN private lane — real tiles, no kill. Dragged stones keep
 *  their Bulwark/Blessing/curse (they never died; Exhume's
 *  rides-through-the-return precedent). No charge income for anyone —
 *  nothing was captured. Spends ultimateReady, ends the turn, breaks the
 *  shield streak. */
export function applyFelStorm(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; struckTokenIds: number[]; sentHomeIds: number[] } {
  const victims = getFelStormTargets(state, power, mover)
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .sort((a, b) => b.position - a.position);

  let tokens = state.tokens;
  const sentHomeIds: number[] = [];
  for (const victim of victims) {
    let landing = FEL_STORM_RETURN_POSITION;
    while (landing >= 0) {
      const contested = BOARD_LAYOUT[landing].isContested;
      const occupied = tokens.some(
        (t) => t.id !== victim.id && t.position === landing && (t.owner === victim.owner || contested),
      );
      if (!occupied) break;
      landing--;
    }
    // A thrall may not stand below the row (crumble-death), and the walk
    // running out entirely (-1) is staggerBackTile's same defensive
    // degenerate — both resolve as a send-home.
    if (landing < 4 && possessorOf(power, victim.id) !== null) landing = -1;
    if (landing === -1) sentHomeIds.push(victim.id);
    tokens = tokens.map((t) => (t.id === victim.id ? { ...t, position: landing } : t));
  }

  let nextPower: PowerState = {
    ...power,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  nextPower = clearThrallIfCaptured(nextPower, sentHomeIds);
  nextPower = clearWallsOnReserveTrip(nextPower, sentHomeIds);
  nextPower = clearCurseOnCapture(nextPower, sentHomeIds);
  nextPower = clearHamstringOnCapture(nextPower, sentHomeIds);
  nextPower = clearInspireOnCapture(nextPower, sentHomeIds);
  nextPower = breakShieldStreak(nextPower, mover); // an attack, not a placement
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(nextPower),
    struckTokenIds: victims.map((v) => v.id),
    sentHomeIds,
  };
}

// ============================================================================
// HUNTER (added 2026-07-26) — zone control: the class that STOPS enemies
// rather than moving them. Passive: WOLF COMPANION — the hunter's
// least-advanced stone guards the contested tile ahead of it, and any enemy
// landing there is knocked back WOLF_BITE_DISTANCE (resolveTurn's reactive
// layer). Actives: SNARE (SNARE_COST, keeps the turn) arms a trap on an
// empty contested TILE — the game's only non-stone board state, public to
// both seats — which throws the first enemy to land on it TRAP_KNOCKBACK
// tiles back; PIERCING SHOT (PIERCING_SHOT_COST, the full bank) looses an
// arrow down the row that kills the first unprotected enemy ahead of the
// hunter's lead stone, at any range — the first body stops the arrow, which
// is the ability's counterplay. Ultimate:
// WILD HUNT freezes the whole enemy row for WILD_HUNT_FREEZE_TURNS and the
// wolf takes the nearest quarry through every protection. Persistent
// footprint: PowerState.traps + PowerState.hamstrung.
// ============================================================================

/** Hunter's Snare: legal tiles are EMPTY contested squares (4-11) that
 *  aren't the middle shield and aren't already trapped by this hunter.
 *  Empty is required because a trap is a thing you walk INTO — arming one
 *  under a stone already standing there would either fire instantly or
 *  never, both bad. The shield tile is excluded on the same principle every
 *  other ability respects it: holy ground, no ambushes. Affordability baked
 *  in (Charged Shot's uniform-cost convention).
 *
 *  Note the enemy's OWN trap tile is still legal for this hunter in a
 *  mirror: two traps can share a square, and each springs for its own
 *  setter's opponent. Nothing needs disambiguating — resolveTurn checks the
 *  MOVER's foe's slot only. */
/** The stone a Blink would move: the mover's least-advanced on-board stone,
 *  or null if there is none or it is frozen. */
export function blinkStone(state: GameState, power: PowerState, mover: PlayerId): TokenState | null {
  const stone = findLeastAdvancedToken(state, power, mover);
  if (!stone || isHamstrung(power, stone.id)) return null;
  return stone;
}

/** Mage's Blink: legal destination tiles — empty, non-shield, contested,
 *  strictly ahead of the blinking stone, and not a square the enemy's trap
 *  or wolf covers (see BLINK_COST). Affordability baked in. */
export function getBlinkTiles(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < BLINK_COST) return [];
  const stone = blinkStone(state, power, mover);
  if (!stone) return [];
  const foe = otherPlayerId(mover);
  const wolfTile = wolfGuardTile(state, power, foe);
  const tiles: number[] = [];
  for (let tile = stone.position + 1; tile <= Math.min(stone.position + BLINK_RANGE, PATH_LENGTH_PER_PLAYER - 1); tile++) {
    if (!BOARD_LAYOUT[tile].isContested) continue;
    if (BOARD_LAYOUT[tile].type === "shield") continue;
    if (state.tokens.some((t) => t.position === tile)) continue;
    if (power.traps?.[foe] === tile) continue;
    if (wolfTile === tile) continue;
    tiles.push(tile);
  }
  return tiles;
}

/** Mage's Blink: spends BLINK_COST and moves the blink stone to `tile`.
 *  Nothing is captured, nothing reacts, the turn ends and the streak
 *  breaks (a blink never lands on a shield by construction). */
export function applyBlink(
  state: GameState,
  power: PowerState,
  tile: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; tokenId: number; from: number } {
  const stone = blinkStone(state, power, mover)!;
  const tokens = state.tokens.map((t) => (t.id === stone.id ? { ...t, position: tile } : t));
  let next: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - BLINK_COST },
  };
  next = breakShieldStreak(next, mover);
  return {
    state: {
      tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: null,
      extraTurn: false,
    },
    power: resetTurnFlags(next),
    tokenId: stone.id,
    from: stone.position,
  };
}

export function getSnareTiles(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < SNARE_COST) return [];
  const tiles: number[] = [];
  for (let tile = 0; tile < PATH_LENGTH_PER_PLAYER; tile++) {
    if (!BOARD_LAYOUT[tile].isContested) continue;
    if (BOARD_LAYOUT[tile].type === "shield") continue;
    if (power.traps?.[mover] === tile) continue;
    if (state.tokens.some((t) => t.position === tile)) continue;
    tiles.push(tile);
  }
  return tiles;
}

/** Hunter's Snare: spends SNARE_COST and arms the hunter's single trap on
 *  `tile`, lifting any trap they had elsewhere (one per hunter — a re-site
 *  costs full price, so there is nothing to farm). Does NOT end the turn
 *  (Curse/Bless/Pickpocket's contract) and moves no stone, so the shield
 *  streak is untouched — setting a trap is board development, not an
 *  attack. */
export function applySnare(power: PowerState, tile: number, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - SNARE_COST },
    traps: { ...power.traps, [mover]: tile },
  };
}

/** Which stone Piercing Shot would actually hit: walking FORWARD along the
 *  contested row from the hunter's most-advanced stone, the first occupied
 *  tile decides everything. If that stone is an unprotected enemy it dies;
 *  if it is protected, or is one of the hunter's own, the arrow stops
 *  there and the shot has no target at all. That "first body stops the
 *  arrow" rule is the ability's whole counterplay — a Ward, a Bulwark, a
 *  Vanish or a shield tile doesn't just save that stone, it body-blocks
 *  for everything behind it. Shared by the oracle and the apply so the two
 *  can never disagree. */
function piercingShotVictim(state: GameState, power: PowerState, mover: PlayerId): TokenState | null {
  const archer = findMostAdvancedToken(state, power, mover);
  if (!archer) return null;
  for (let tile = archer.position + 1; tile < PATH_LENGTH_PER_PLAYER; tile++) {
    if (!BOARD_LAYOUT[tile].isContested) break; // the arrow leaves the shared row
    const occupant = state.tokens.find((t) => t.position === tile);
    if (!occupant) continue;
    if (effectiveOwner(power, occupant) === mover) return null; // own stone blocks the lane
    if (isProtected(state, power, occupant)) return null; // armour stops the arrow
    return occupant;
  }
  return null;
}

/** Hunter's Piercing Shot: a single-entry pool (the arrow's path decides
 *  the target, not the player) or empty — the same "one candidate, no
 *  choice" collapse Revive and Exhume already use. Affordability baked in,
 *  Charged Shot's uniform-cost convention. */
export function getPiercingShotTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < PIERCING_SHOT_COST) return [];
  const victim = piercingShotVictim(state, power, mover);
  return victim ? [victim.id] : [];
}

/** Hunter's Piercing Shot: spends the full bank; the arrow kills the stone
 *  piercingShotVictim picked — always a real kill now (2026-09-17: a
 *  Blessed/walled victim is excluded by piercingShotVictim's own
 *  isProtected check, so it never reaches this function at all). Grants
 *  the standard capture charge. No stone of the hunter's moves: ends the
 *  turn and breaks the shield streak, Push's precedent exactly. */
export function applyPiercingShot(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; killedTokenId: number | null; woundedTokenId: number | null } {
  const victim = piercingShotVictim(state, power, mover);
  let next: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - PIERCING_SHOT_COST },
  };
  let tokens = state.tokens;
  let killedTokenId: number | null = null;
  if (victim) {
    tokens = tokens.map((t) => (t.id === victim.id ? { ...t, position: -1 } : t));
    next = clearWallsOnReserveTrip(next, [victim.id]);
    next = clearThrallIfCaptured(next, [victim.id]);
    next = clearCurseOnCapture(next, [victim.id]);
    next = clearHamstringOnCapture(next, [victim.id]);
    next = clearInspireOnCapture(next, [victim.id]);
    ({ tokens, power: next } = applyDarkBargain(state.tokens, power, tokens, next, [victim.id], mover, "ranged"));
    killedTokenId = victim.id;
    next = addCharge(next, mover);
  }
  next = breakShieldStreak(next, mover);
  return {
    state: {
      tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: null,
      extraTurn: false,
    },
    power: resetTurnFlags(next),
    killedTokenId,
    woundedTokenId: null,
  };
}

/** Freeze bookkeeping for the START of a brand-new turn — the
 *  tickThrallForNewTurn/tickCurseForNewTurn convention: call once per fresh
 *  flip dealt to state.currentPlayer, BEFORE the move list is computed, so
 *  the turn a freeze expires is a turn the stone actually moves. Ticks only
 *  the CURRENT player's OWN stones (the freeze is measured in the victim's
 *  turns). Returns the ids that thawed so the server can announce them. */
export function tickHamstringForNewTurn(
  state: GameState,
  power: PowerState,
): { power: PowerState; thawedTokenIds: number[] } {
  const mover = state.currentPlayer;
  const mine = Object.keys(power.hamstrung ?? {})
    .map(Number)
    .filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover);
  if (mine.length === 0) return { power, thawedTokenIds: [] };
  const hamstrung = { ...power.hamstrung };
  const thawedTokenIds: number[] = [];
  for (const id of mine) {
    const left = hamstrung[id] - 1;
    if (left <= 0) {
      delete hamstrung[id];
      thawedTokenIds.push(id);
    } else {
      hamstrung[id] = left;
    }
  }
  return { power: { ...power, hamstrung }, thawedTokenIds };
}

/** Hunter's Wild Hunt: the pool is every enemy stone in shared water —
 *  Rain of Arrows' ultimate pool (every protection pierced, possession
 *  resolved). Empty pool = nothing to hunt = not castable (Benediction's
 *  misclick rule). ultimateReady gating stays at the dispatch layer. */
export function getWildHuntTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return getRainOfArrowsTargets(state, power, mover);
}

/** Hunter's Wild Hunt: every trap in the world snaps shut at once. Every
 *  enemy stone in shared water is frozen for WILD_HUNT_FREEZE_TURNS of its
 *  owner's turn-starts, AND the wolf takes the nearest one — the
 *  least-advanced victim, the stone the wolf could actually run down —
 *  through shield tiles, Ward, Bulwark, Vanish and a Blessing alike, the
 *  ultimate convention. Unlike the teleport-capture ultimates the hunter's
 *  own stones do not move: the wolf hunts, the hunter stands. Grants 1
 *  charge on the kill (Blink Strike's economy). Spends the hunter's
 *  own armed trap too — the ability is every trap firing, including theirs.
 *  Ends the turn, breaks the shield streak. */
export function applyWildHunt(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; frozenTokenIds: number[]; killedTokenId: number | null } {
  const pool = getWildHuntTargets(state, power, mover)
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .sort((a, b) => a.position - b.position);
  const quarry = pool[0] ?? null;
  const frozen = pool.filter((t) => t.id !== quarry?.id);

  const tokens = state.tokens.map((t) => (quarry && t.id === quarry.id ? { ...t, position: -1 } : t));
  let next: PowerState = {
    ...power,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
    traps: { ...power.traps, [mover]: null },
  };
  if (frozen.length > 0) {
    const hamstrung = { ...next.hamstrung };
    for (const t of frozen) hamstrung[t.id] = WILD_HUNT_FREEZE_TURNS;
    next = { ...next, hamstrung };
  }
  if (quarry) {
    next = clearWallsOnReserveTrip(next, [quarry.id]);
    next = clearThrallIfCaptured(next, [quarry.id]);
    next = clearCurseOnCapture(next, [quarry.id]);
    next = clearHamstringOnCapture(next, [quarry.id]);
    next = clearInspireOnCapture(next, [quarry.id]);
    next = addCharge(next, mover);
  }
  next = breakShieldStreak(next, mover);
  return {
    state: {
      tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: null,
      extraTurn: false,
    },
    power: resetTurnFlags(next),
    frozenTokenIds: frozen.map((t) => t.id),
    killedTokenId: quarry?.id ?? null,
  };
}

// ============================================================================
// BARBARIAN (added 2026-07-27) — the comeback engine: the only class that
// gets FASTER the worse it is doing. Passive: RAGE — every stone in reserve
// adds a tile to every move, up to RAGE_MAX (rageFor, read by
// getLegalPowerMoves). Actives: RECKLESS SWING (RECKLESS_SWING_COST) kills
// an adjacent enemy through BULWARK and VANISH — the physical half of the
// defence roster, the counterpart to Warlock's Sacrifice — and throws the
// swinger RECKLESS_SELF_KNOCKBACK tiles back for its trouble; WHIRLWIND
// (WHIRLWIND_COST, the full bank) catches every enemy within
// WHIRLWIND_RADIUS of ANY of the barbarian's stones, capturing up to
// WHIRLWIND_CAP and shoving the rest. Ultimate: BLOODBATH (2026-09-18,
// Rework III) teleports the least-advanced stone onto a chosen enemy,
// capturing it and sweeping everything caught between — Warpath's exact
// mechanic, ported wholesale onto this slot after the Warrior's own
// retirement of it. No persistent PowerState of its own — Rage is derived
// from the board, which is what makes it impossible to hoard.
// ============================================================================

/** Which of the barbarian's stones would swing at this victim: the one
 *  standing directly behind it. At most one stone can occupy that tile, so
 *  the striker is determined by the board rather than chosen — which is
 *  what keeps Reckless Swing on the one-tap "tap an enemy" UI every other
 *  targeted ability uses. */
function recklessSwinger(state: GameState, power: PowerState, mover: PlayerId, victim: TokenState): TokenState | null {
  const behind = state.tokens.find(
    (t) => effectiveOwner(power, t) === mover && t.position === victim.position - 1 && t.position >= 0,
  );
  return behind ?? null;
}

/** Barbarian's Reckless Swing: valid targets are enemy stones in shared
 *  water with one of the barbarian's own stones directly behind them.
 *  Walls are absolute now (2026-09-17): the swing LOST its Bulwark/Vanish
 *  pierce along with every other bespoke breaker (the physical half of the
 *  old defence-piercing split — a real identity loss, flagged, not fixed
 *  here). A single isProtected check blocks it, same as every other
 *  non-ultimate strike. Affordability baked in. */
export function getRecklessSwingTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < RECKLESS_SWING_COST) return [];
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !isProtected(state, power, t))
    .filter((t) => recklessSwinger(state, power, mover, t) !== null)
    .map((t) => t.id);
}

/** Barbarian's Reckless Swing: the stone behind the victim kills it — a
 *  real kill every time now (2026-09-17: no more wound split, the target
 *  pool already excludes every protection) — and is thrown
 *  RECKLESS_SELF_KNOCKBACK tiles back along its own path for the effort,
 *  standard collision math, so a blocked recoil sends the swinger home
 *  too. Grants the usual capture charge. Ends the turn and breaks the
 *  shield streak (Push's precedent). Returns both halves so the server
 *  can announce the trade honestly. */
export function applyRecklessSwing(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): {
  state: GameState;
  power: PowerState;
  swingerTokenId: number;
  killedTokenId: number | null;
  woundedTokenId: number | null;
  swingerSentHome: boolean;
} {
  const victim = state.tokens.find((t) => t.id === targetTokenId)!;
  const swinger = recklessSwinger(state, power, mover, victim)!;
  let next: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - RECKLESS_SWING_COST },
  };
  let tokens = state.tokens;

  tokens = tokens.map((t) => (t.id === targetTokenId ? { ...t, position: -1 } : t));
  next = clearWallsOnReserveTrip(next, [targetTokenId]);
  next = clearThrallIfCaptured(next, [targetTokenId]);
  next = clearCurseOnCapture(next, [targetTokenId]);
  next = clearHamstringOnCapture(next, [targetTokenId]);
  next = clearInspireOnCapture(next, [targetTokenId]);
  ({ tokens, power: next } = applyDarkBargain(state.tokens, power, tokens, next, [targetTokenId], mover, "ranged"));
  const killedTokenId: number | null = targetTokenId;
  next = addCharge(next, mover); // the blow landed

  // The recoil, resolved against the post-kill board so the swinger can
  // fall back into the tile it just emptied.
  const working: GameState = { ...state, tokens };
  const current = tokens.find((t) => t.id === swinger.id)!;
  const landing = computeKnockbackLanding(working, next, current, RECKLESS_SELF_KNOCKBACK);
  tokens = tokens.map((t) => (t.id === swinger.id ? { ...t, position: landing } : t));
  const swingerSentHome = landing === -1;
  if (swingerSentHome) {
    next = clearThrallIfCaptured(next, [swinger.id]);
    next = clearCurseOnCapture(next, [swinger.id]);
    next = clearHamstringOnCapture(next, [swinger.id]);
    next = clearInspireOnCapture(next, [swinger.id]);
    next = clearWallsOnReserveTrip(next, [swinger.id]);
  }

  next = breakShieldStreak(next, mover);
  return {
    state: {
      tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: null,
      extraTurn: false,
    },
    power: resetTurnFlags(next),
    swingerTokenId: swinger.id,
    killedTokenId,
    woundedTokenId: null,
    swingerSentHome,
  };
}

/** Barbarian's Whirlwind: everything the spin would catch — enemy stones on
 *  the contested row within WHIRLWIND_RADIUS of ANY of the barbarian's own
 *  on-board stones, minus anything protected (isProtected: this is a wide
 *  swing, not a piercing one). Empty pool = not castable, Benediction's
 *  misclick rule. Affordability baked in. */
export function getWhirlwindTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < WHIRLWIND_COST) return [];
  const mine = state.tokens.filter(
    (t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return [];
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => mine.some((m) => Math.abs(m.position - t.position) <= WHIRLWIND_RADIUS))
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

/** Barbarian's Whirlwind: spends the full bank. The WHIRLWIND_CAP
 *  most-advanced victims are captured outright (deepest runners first —
 *  deterministic, and the ones worth taking); everyone else the spin
 *  reaches is knocked back 1 with standard collision math, so a blocked
 *  shove is a send-home. Grants exactly one charge if anything died at all,
 *  Charge's own sweep economy (one capturing action = one charge, however
 *  many it takes down). Ends the turn, breaks the shield streak. */
export function applyWhirlwind(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): {
  state: GameState;
  power: PowerState;
  capturedTokenIds: number[];
  knockedTokenIds: number[];
  sentHomeIds: number[];
  woundedTokenIds: number[];
} {
  const victims = getWhirlwindTargets(state, power, mover)
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .sort((a, b) => b.position - a.position);
  const toCapture = victims.slice(0, WHIRLWIND_CAP);
  const toShove = victims.slice(WHIRLWIND_CAP);

  let next: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - WHIRLWIND_COST },
  };
  let tokens = state.tokens;
  const capturedTokenIds: number[] = [];
  const woundedTokenIds: number[] = [];

  // No wound split any more (2026-09-17): getWhirlwindTargets already
  // excludes every protected stone, so every victim below is a real kill.
  for (const v of toCapture) {
    tokens = tokens.map((t) => (t.id === v.id ? { ...t, position: -1 } : t));
    capturedTokenIds.push(v.id);
  }
  if (capturedTokenIds.length > 0) {
    next = clearWallsOnReserveTrip(next, capturedTokenIds);
    next = clearThrallIfCaptured(next, capturedTokenIds);
    next = clearCurseOnCapture(next, capturedTokenIds);
    next = clearHamstringOnCapture(next, capturedTokenIds);
    next = clearInspireOnCapture(next, capturedTokenIds);
    ({ tokens, power: next } = applyDarkBargain(state.tokens, power, tokens, next, capturedTokenIds, mover, "ranged"));
  }

  // The shoves, resolved outward-in against the working board so a vacated
  // tile is free for the next victim — Corpse Explosion's discipline.
  const knockedTokenIds: number[] = [];
  const sentHomeIds: number[] = [];
  for (const v of toShove) {
    const working: GameState = { ...state, tokens };
    const current = tokens.find((t) => t.id === v.id)!;
    const landing = computeKnockbackLanding(working, next, current, 1);
    tokens = tokens.map((t) => (t.id === v.id ? { ...t, position: landing } : t));
    knockedTokenIds.push(v.id);
    if (landing === -1) {
      sentHomeIds.push(v.id);
      next = clearThrallIfCaptured(next, [v.id]);
      next = clearCurseOnCapture(next, [v.id]);
      next = clearHamstringOnCapture(next, [v.id]);
      next = clearInspireOnCapture(next, [v.id]);
      next = clearWallsOnReserveTrip(next, [v.id]);
      ({ tokens, power: next } = applyDarkBargain(state.tokens, power, tokens, next, [v.id], mover, "ranged"));
    }
  }

  if (capturedTokenIds.length > 0 || woundedTokenIds.length > 0) next = addCharge(next, mover);
  next = breakShieldStreak(next, mover);
  return {
    state: {
      tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: null,
      extraTurn: false,
    },
    power: resetTurnFlags(next),
    capturedTokenIds,
    knockedTokenIds,
    sentHomeIds,
    woundedTokenIds,
  };
}

/** Barbarian's Bloodbath ultimate (2026-09-18, Rework III): Warpath's exact
 *  target eligibility, ported wholesale after the Warrior's own retirement
 *  of it — same target eligibility as Blink Strike/Rain of Arrows. Empty
 *  if the mover has no on-board token to relocate at all. */
export function getBloodbathTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findLeastAdvancedToken(state, power, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Barbarian's Bloodbath: instantly relocates the mover's LEAST-advanced
 *  on-board token onto the target's tile, capturing it, AND sweeps every
 *  enemy on a contested tile strictly between where that token started and
 *  where it lands (either direction — a teleport, not a real move) —
 *  uncapped, unlike Whirlwind's own WHIRLWIND_CAP. Same bypass rules as
 *  every ultimate (shield + Ward + wall — everything) for every token it
 *  hits, primary or swept. Spends ultimateReady, not a charge; still
 *  grants exactly 1 charge back on a successful capture. Always ends the
 *  turn — no extra-turn interaction, and (unlike the OLD Bloodbath, see
 *  EXTENDED_CHARGE_RETIRED) leaves the shield streak alone, Warpath's own
 *  convention and every other ultimate's. killedTokenIds is
 *  [target, ...swept] and endedOn is the landing tile — the same wire
 *  shape Extended Charge used, so room-engine/the client/the sims needed
 *  no announcement-shape changes for this port, only a target parameter.
 *
 *  REWORK III SIM CHECK (2026-09-18, 1000 games/matchup): Barbarian's
 *  9-matchup average landed at 42.4% (archer 39.3 / mage 37.9 / warrior
 *  43.6 / necromancer 40.9 / cleric 55.9 / rogue 42.9 / warlock 39.0 /
 *  hunter 37.5 / bard 44.4) — down from 44.8% with the old Extended Charge
 *  mechanic, and further from the 47-53 target band, though every matchup
 *  stays safely inside the 35/65 bar (worst: hunter 37.5%). This section
 *  of the handoff was scoped as an identity port (bringing Warpath's
 *  mechanic to a class that lost none of its own kit), not a balance fix
 *  — Rage was the already-decided lever for Barbarian's numbers, per the
 *  handoff's own "no further tuning needed" call. Shipped as measured,
 *  not chased further; flagged here for the record rather than silently
 *  absorbed, same discipline as every other sim check in this file. */
export function applyBloodbath(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; killedTokenIds: number[]; endedOn: number } {
  const mine = findLeastAdvancedToken(state, power, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const from = mine.position;
  const to = target.position;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const sweepCaptures: number[] = [];
  for (let i = lo + 1; i < hi; i++) {
    if (!BOARD_LAYOUT[i].isContested) continue;
    // Effective ownership: the barbarian's own possessed token in the path
    // is an enemy combatant — swept like any other (Warpath's own rule).
    const foe = state.tokens.find(
      (t) =>
        t.position === i &&
        effectiveOwner(power, t) !== mover &&
        t.id !== mine.id &&
        t.id !== targetTokenId,
    );
    if (foe) sweepCaptures.push(foe.id);
  }

  const allCaptures = [targetTokenId, ...sweepCaptures];
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let nextPower: PowerState = clearWallsOnReserveTrip(
    {
      ...power,
      ultimateReady: { ...power.ultimateReady, [mover]: false },
    },
    allCaptures,
  );
  nextPower = clearThrallIfCaptured(nextPower, allCaptures);
  nextPower = clearCurseOnCapture(nextPower, allCaptures);
  nextPower = clearHamstringOnCapture(nextPower, allCaptures);
  nextPower = clearInspireOnCapture(nextPower, allCaptures);
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return {
    state: nextState,
    power: resetTurnFlags(nextPower),
    killedTokenIds: allCaptures,
    endedOn: to,
  };
}

// ============================================================================
// BARD (added 2026-07-27) — the buff engine. The user's brief was literally
// "I want the bard to be able to buff a lot", which supersedes the tempo kit
// originally planned (Rally / Discordant Note): the class is now built to
// have SEVERAL of its stones lit at once. Passive: ENCORE — a zero flip pays
// ENCORE_ZERO_FLIP_CHARGES instead of 1, the income that funds the whole
// thing (wired into grantZeroFlipCharge). Actives: INSPIRE (INSPIRE_COST,
// keeps the turn) lights one own stone for INSPIRE_TURNS, uncapped in how
// many may carry it; SONG OF HASTE (HASTE_COST, the full bank) cashes every
// lit stone at once, advancing each HASTE_TILES. Ultimate: CRESCENDO lights
// the whole army AND advances it CRESCENDO_TILES. Persistent footprint:
// PowerState.inspired.
//
// EVERY ADVANCE HERE IS BOUGHT MOVEMENT, NEVER AN EXTRA TURN. See
// HASTE_COST's doc for the two recorded blowouts that rule exists to avoid.
// ============================================================================

/** Bard's Inspire: valid targets are the bard's own on-board stones not
 *  already lit (re-lighting would be a full-price no-op — the
 *  legal-but-worthless trap getPickpocketTargets documents). Deliberately
 *  NO cap on how many may be inspired at once: the mana is the only limit,
 *  which is what "buff a lot" means. Affordability baked in. */
export function getInspireTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < INSPIRE_COST) return [];
  // INSPIRE_CAP: the pool empties while the count is met, Bless's exact
  // convention. Counts the mover's OWN lit stones only, so a bard mirror
  // keeps two independent ledgers.
  const lit = Object.keys(power.inspired ?? {}).filter(
    (id) => state.tokens.find((t) => t.id === Number(id))?.owner === mover,
  ).length;
  if (lit >= INSPIRE_CAP) return [];
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isInspired(power, t.id))
    .map((t) => t.id);
}

/** Bard's Inspire: spends INSPIRE_COST and lights one stone for
 *  INSPIRE_TURNS of the bard's own turn-starts. Does NOT end the turn
 *  (Re-flip / Bless / Curse / Snare's contract) and moves nothing, so the
 *  shield streak is untouched — singing is not an attack. */
export function applyInspire(power: PowerState, targetTokenId: number, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - INSPIRE_COST },
    inspired: { ...power.inspired, [targetTokenId]: INSPIRE_TURNS },
  };
}

/** Inspiration bookkeeping for the START of a brand-new turn — the
 *  tickCurseForNewTurn / tickHamstringForNewTurn convention: call once per
 *  fresh flip dealt to state.currentPlayer, BEFORE the move list is
 *  computed, so a stone whose song has just faded moves at its true speed.
 *  Ticks only the CURRENT player's own stones (the duration is measured in
 *  the bard's turns). Returns the ids that went quiet so the server can
 *  announce them. */
export function tickInspireForNewTurn(
  state: GameState,
  power: PowerState,
): { power: PowerState; fadedTokenIds: number[] } {
  // Inspirations don't expire (see INSPIRE_PERMANENT) — a lit stone stays
  // lit until it dies. The whole tick stays wired up so the alternative is
  // one constant away.
  if (INSPIRE_PERMANENT) return { power, fadedTokenIds: [] };
  const mover = state.currentPlayer;
  const mine = Object.keys(power.inspired ?? {})
    .map(Number)
    .filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover);
  if (mine.length === 0) return { power, fadedTokenIds: [] };
  const inspired = { ...power.inspired };
  const fadedTokenIds: number[] = [];
  for (const id of mine) {
    const left = inspired[id] - 1;
    if (left <= 0) {
      delete inspired[id];
      fadedTokenIds.push(id);
    } else {
      inspired[id] = left;
    }
  }
  return { power: { ...power, inspired }, fadedTokenIds };
}

/** Shared by Song of Haste and Crescendo: walk a set of the mover's stones
 *  forward `distance` tiles at once, deepest-first so a vacated tile is
 *  free for the stone behind it (Corpse Explosion's sequential discipline).
 *  Ordinary movement rules throughout — this is BOUGHT movement, not an
 *  ultimate's licence: a stone blocked by one of the mover's own simply
 *  doesn't move, an unprotected enemy on the landing tile is captured, and
 *  a protected one blocks — INCLUDING the exact-escape rule: a stone whose
 *  advance lands it precisely on the finish tile escapes, and one that
 *  would overshoot simply doesn't move.
 *
 *  ESCAPES ARE ALLOWED, corrected after the first balance run. They were
 *  forbidden at first on the theory that "a purchased advance may not end
 *  the game" — reading across from this file's extra-turn blowups. That
 *  read was wrong: those catastrophes were about extra ACTIONS per turn,
 *  and Song of Haste is one action that ends the turn like any other. The
 *  ban's actual effect was to make the ability unable to finish a job it
 *  had started, and since the bot correctly valued a wide march above a
 *  single move, a bard would sing every turn and NEVER escape anything —
 *  the bard mirror stalemated 51-65% of games at the turn cap. An ability
 *  that cannot win is not a safe ability, it is a broken one. */
function advanceStones(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  ids: number[],
  distance: number,
): { state: GameState; power: PowerState; movedIds: number[]; capturedIds: number[]; woundedIds: number[] } {
  const ordered = ids
    .map((id) => state.tokens.find((t) => t.id === id)!)
    .filter((t) => t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .sort((a, b) => b.position - a.position);

  let tokens = state.tokens;
  let next = power;
  const movedIds: number[] = [];
  const capturedIds: number[] = [];
  const woundedIds: number[] = [];

  for (const stone of ordered) {
    const from = tokens.find((t) => t.id === stone.id)!.position;
    const to = from + distance;
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      // The classic exact-escape rule: land precisely on the finish tile or
      // don't move at all.
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      tokens = tokens.map((t) => (t.id === stone.id ? { ...t, position: PATH_LENGTH_PER_PLAYER } : t));
      movedIds.push(stone.id);
      // A marched escape is still an escape — it pays (ESCAPE_CHARGES).
      for (let i = 0; i < ESCAPE_CHARGES; i++) next = addCharge(next, mover);
      continue;
    }
    const destTile = BOARD_LAYOUT[to];
    const occupants = tokens.filter(
      (t) => t.position === to && t.id !== stone.id && (destTile.isContested || t.owner === stone.owner),
    );
    const self = occupants.find((t) => effectiveOwner(next, t) === mover);
    if (self) continue; // own stone blocks, same as a normal move
    const enemy = occupants.find((t) => effectiveOwner(next, t) !== mover);
    if (enemy && isProtected(state, next, enemy)) continue; // armour blocks the advance
    if (enemy) {
      // No wound split any more (2026-09-17): a Blessed/walled enemy is
      // already caught by isProtected above, so this is always a real kill.
      const trampled = tokens;
      tokens = tokens.map((t) => (t.id === enemy.id ? { ...t, position: -1 } : t));
      next = clearWallsOnReserveTrip(next, [enemy.id]);
      next = clearThrallIfCaptured(next, [enemy.id]);
      next = clearCurseOnCapture(next, [enemy.id]);
      next = clearHamstringOnCapture(next, [enemy.id]);
      next = clearInspireOnCapture(next, [enemy.id]);
      ({ tokens, power: next } = applyDarkBargain(trampled, power, tokens, next, [enemy.id], mover, "landing"));
      next = addCharge(next, mover);
      capturedIds.push(enemy.id);
    }
    tokens = tokens.map((t) => (t.id === stone.id ? { ...t, position: to } : t));
    movedIds.push(stone.id);
  }
  return { state: { ...state, tokens }, power: next, movedIds, capturedIds, woundedIds };
}

/** Did this march just bring the mover's LAST stone home? A purchased
 *  advance can escape (see advanceStones), so both bard casts have to be
 *  able to declare a win — the same real-owner counting rule
 *  getLegalPowerMoves uses for causesWin. */
function marchCausesWin(tokens: TokenState[], mover: PlayerId): boolean {
  return tokens
    .filter((t) => t.owner === mover)
    .every((t) => t.position >= PATH_LENGTH_PER_PLAYER);
}

/** Every stone Song of Haste would move — the bard's lit stones. Empty
 *  (nothing inspired, or nothing that can move) means not castable, the
 *  Benediction misclick rule. Affordability baked in. */
export function getSongOfHasteTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] < HASTE_COST) return [];
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER - 1)
    .filter((t) => isInspired(power, t.id))
    .map((t) => t.id);
}

/** Bard's Song of Haste: spends the full bank and advances every lit stone
 *  HASTE_TILES at once, under ordinary movement rules (see advanceStones).
 *  The inspirations SURVIVE the song — it cashes their position, not the
 *  buff itself, so a wide board stays wide. Ends the turn and breaks the
 *  shield streak: stones moved, but not onto a shield by any rule this
 *  path honours. */
export function applySongOfHaste(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; movedIds: number[]; capturedIds: number[]; woundedIds: number[] } {
  const ids = getSongOfHasteTargets(state, power, mover);
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - HASTE_COST },
  };
  const r = advanceStones(state, spent, mover, ids, HASTE_TILES);
  const nextPower = breakShieldStreak(r.power, mover);
  return {
    state: {
      tokens: r.state.tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: marchCausesWin(r.state.tokens, mover) ? mover : null,
      extraTurn: false,
    },
    power: resetTurnFlags(nextPower),
    movedIds: r.movedIds,
    capturedIds: r.capturedIds,
    woundedIds: r.woundedIds,
  };
}

/** Every stone Crescendo would touch: the bard's whole on-board army,
 *  inspired or not. Empty = nothing to sing to = not castable. */
export function getCrescendoTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return state.tokens
    .filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .map((t) => t.id);
}

/** Bard's Crescendo: lights the ENTIRE on-board army for INSPIRE_TURNS and
 *  advances every one of them CRESCENDO_TILES immediately — the only way to
 *  inspire four stones without paying four mana, and the kit fired at once.
 *  Ordinary movement rules on the advance (advanceStones), so unlike its
 *  ultimate siblings this one does NOT pierce protection: the bard's magic
 *  is in the marching, not the sword. Spends ultimateReady, ends the turn,
 *  breaks the shield streak. */
export function applyCrescendo(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
): { state: GameState; power: PowerState; inspiredIds: number[]; movedIds: number[]; capturedIds: number[]; woundedIds: number[] } {
  const ids = getCrescendoTargets(state, power, mover);
  const inspired = { ...power.inspired };
  for (const id of ids) inspired[id] = INSPIRE_TURNS;
  const lit: PowerState = {
    ...power,
    inspired,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  const r = advanceStones(state, lit, mover, ids, CRESCENDO_TILES);
  const nextPower = breakShieldStreak(r.power, mover);
  return {
    state: {
      tokens: r.state.tokens,
      currentPlayer: otherPlayerId(mover),
      lastFlip: null,
      winner: marchCausesWin(r.state.tokens, mover) ? mover : null,
      extraTurn: false,
    },
    power: resetTurnFlags(nextPower),
    inspiredIds: ids,
    movedIds: r.movedIds,
    capturedIds: r.capturedIds,
    woundedIds: r.woundedIds,
  };
}
