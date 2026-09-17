// ============================================================================
// test-master-killer.ts — hand-constructed scenario checks for
// master-killer.ts. No formal test framework exists in this repo (see
// play-random-game.ts / batch-random-games.ts for the established
// script-based convention) — this follows the same pattern: plain
// assertions, clear PASS/FAIL summary, non-zero exit on any failure.
//
// Run: npx tsx test-master-killer.ts
// ============================================================================

import { BOARD_LAYOUT, PATH_LENGTH_PER_PLAYER, type GameState, type PlayerId, type TokenState } from "./rulebook.ts";
import {
  BLESS_COST,
  BLESSING_CAP,
  BULWARK_TURNS,
  CHARGE_CAP,
  ESCAPE_CHARGES,
  CHARGED_SHOT_COST,
  CHARGE_SWEEP_CAP,
  CHARGED_SHOT_DISTANCE,
  CORPSE_EXPLOSION_COST,
  CURSE_COST,
  CURSE_SLOW,
  CURSE_TURNS,
  EXHUME_RETURN_POSITION,
  FEL_STORM_RETURN_POSITION,
  BARD_CHARGE_CAP,
  BLOODBATH_END_POSITION,
  ENCORE_ZERO_FLIP_CHARGES,
  HASTE_COST,
  HASTE_TILES,
  INSPIRE_BONUS,
  INSPIRE_CAP,
  INSPIRE_COST,
  PIERCING_SHOT_COST,
  RAGE_MAX,
  RECKLESS_SELF_KNOCKBACK,
  RECKLESS_SWING_COST,
  WHIRLWIND_CAP,
  WHIRLWIND_COST,
  SACRIFICE_COST,
  SNARE_COST,
  TRAP_BOUNTY,
  TRAP_KNOCKBACK,
  WILD_HUNT_FREEZE_TURNS,
  VIGIL_COST,
  NECRO_CHARGE_CAP,
  PICKPOCKET_COST,
  PICKPOCKET_RETIRED,
  PICKPOCKET_STEAL,
  PUSH_DISTANCE,
  REFLIPS_PER_TURN,
  REFLIP_COST,
  REVIVE_COST,
  ROGUE_STEAL_ON_CAPTURE,
  SOUL_BOUNTY_CHARGES,
  THRALL_TURNS,
  ULTIMATE_STREAK,
  VANISH_COST,
  VANISH_TURNS,
  WALL_BLEED,
  WALL_BLEED_MIN,
  HOLD_THE_LINE_DISCOUNT,
  wallUpkeepFor,
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
  applySacrifice,
  applySnare,
  applyWildHunt,
  applyPickpocket,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyRevive,
  applyVanish,
  applyBackstab,
  BACKSTAB_COST,
  getBackstabTargets,
  applyWarpath,
  breakShieldStreak,
  canReflipAgain,
  canCastVigil,
  canHoldWall,
  effectiveOwner,
  applyVigil,
  getBenedictionTargets,
  getBlessTargets,
  getBlinkStrikeTargets,
  getBulwarkBlockedIds,
  getBulwarkTargets,
  getGrandHeistTargets,
  getChargedShotTargets,
  getCorpseExplosionTargets,
  getCurseTargets,
  getExhumeTargets,
  getFelStormTargets,
  getLegalPowerMoves,
  getBloodbathTargets,
  getCrescendoTargets,
  getInspireTargets,
  getSongOfHasteTargets,
  chargeCapFor,
  getPiercingShotTargets,
  getRecklessSwingTargets,
  getWhirlwindTargets,
  getSacrificeTargets,
  getSnareTiles,
  getWildHuntTargets,
  getPickpocketTargets,
  getPushTargets,
  getRainOfArrowsTargets,
  applyRainOfArrows,
  getReviveSpawnTile,
  getVanishTargets,
  getWarpathTargets,
  grantZeroFlipCharge,
  initialPowerState,
  isCursed,
  isHamstrung,
  isInspired,
  isProtected,
  isVanished,
  isWalled,
  isWarded,
  rageFor,
  ragedToken,
  resetTurnFlags,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickCurseForNewTurn,
  tickHamstringForNewTurn,
  tickDarkBargainForNewTurn,
  tickWallUpkeepForNewTurn,
  tickVanishForNewTurn,
  DARK_BARGAIN_RETREAT,
  DARK_BARGAIN_LANDING_ONLY,
  BLOOD_PACT_CHARGES,
  tickThrallForNewTurn,
  wolfGuardTile,
  type PlayerClass,
  type PowerState,
} from "./master-killer.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** All 8 tokens parked in reserve (-1) by default; pass overrides by id. */
function tokens(overrides: Record<number, number>): TokenState[] {
  const list: TokenState[] = [];
  for (let i = 0; i < 4; i++) list.push({ id: i, owner: "p1", position: overrides[i] ?? -1 });
  for (let i = 4; i < 8; i++) list.push({ id: i, owner: "p2", position: overrides[i] ?? -1 });
  return list;
}

function state(current: PlayerId, overrides: Record<number, number>): GameState {
  return { tokens: tokens(overrides), currentPlayer: current, lastFlip: null, winner: null, extraTurn: false };
}

function power(classes: Partial<Record<PlayerId, PlayerClass>>, charges: Partial<Record<PlayerId, number>> = {}): PowerState {
  const base = initialPowerState();
  return {
    ...base,
    classes: { p1: classes.p1 ?? "archer", p2: classes.p2 ?? "archer" },
    charges: { p1: charges.p1 ?? 0, p2: charges.p2 ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// Assertion plumbing
// ---------------------------------------------------------------------------

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 0. Escape pays (2026-09-16): bringing a stone home banks ESCAPE_CHARGES
// ---------------------------------------------------------------------------
{
  // p1 archer stone 0 on tile 13 with a flip of 1 lands exactly on the finish
  // (14) and escapes (to = 15); stone 1 stays behind so it is not the win.
  const s = state("p1", { 0: 13, 1: 5 });
  const pw = power({ p1: "archer", p2: "mage" });
  const esc = getLegalPowerMoves(s, pw, 1).find((mv) => mv.tokenId === 0)!;
  check("Escape pays: the exact-landing escape is legal", esc !== undefined && esc.to === 15, JSON.stringify(esc));
  const r = applyPowerMove(s, pw, esc, "p1");
  check("Escape pays: the stone is home", r.state.tokens.find((t) => t.id === 0)!.position === 15);
  check("Escape pays: the mover banks ESCAPE_CHARGES", r.power.charges.p1 === ESCAPE_CHARGES, `p1=${r.power.charges.p1}`);
  check("Escape pays: the opponent banks nothing", r.power.charges.p2 === 0);
  const rCap = applyPowerMove(s, power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP }), esc, "p1");
  check("Escape pays: clamps at CHARGE_CAP", rCap.power.charges.p1 === CHARGE_CAP);
  // A plain advance that does not escape pays nothing.
  const sMid = state("p1", { 0: 5, 1: 9 });
  const mv = getLegalPowerMoves(sMid, power({ p1: "archer", p2: "mage" }), 1).find((m) => m.tokenId === 0)!; // 5 -> 6, not a shield
  check("Escape pays: an ordinary quiet move still pays nothing", applyPowerMove(sMid, power({ p1: "archer", p2: "mage" }), mv, "p1").power.charges.p1 === 0);
  // A Bard march that escapes a stone pays the same.
  const sBard = state("p1", { 0: 14 - HASTE_TILES, 1: 3 });
  let pwBard = power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST + HASTE_COST });
  pwBard = applyInspire(pwBard, 0, "p1");
  const rBard = applySongOfHaste(sBard, pwBard, "p1");
  check("Escape pays: a marched escape banks it too", rBard.state.tokens.find((t) => t.id === 0)!.position === 15 && rBard.power.charges.p1 === ESCAPE_CHARGES, `p1=${rBard.power.charges.p1} pos=${rBard.state.tokens.find((t) => t.id === 0)!.position}`);
}

// ---------------------------------------------------------------------------
// 1. Archer Snipe fires, and respects shield/ward protection
// ---------------------------------------------------------------------------
{
  // p1 archer token at 6 flips a 2 -> lands on contested tile 8; enemy sits
  // at 9 (to+1), unprotected — should be sniped for free.
  const s = state("p1", { 0: 6, 4: 9 });
  const pw = power({ p1: "archer" });
  const moves = getLegalPowerMoves(s, pw, 2);
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Snipe: fires on unprotected target one tile ahead", !!m && m.bonusCaptures.includes(4), JSON.stringify(m));

  // Same setup, but the target sits on the shield tile (7 -> +1 = 8, so use
  // a landing of 6 -> target at 7, the middle shield) — shield blocks it.
  const s2 = state("p1", { 0: 5, 4: 7 });
  const pw2 = power({ p1: "archer" });
  const moves2 = getLegalPowerMoves(s2, pw2, 1);
  const m2 = moves2.find((mv) => mv.tokenId === 0 && mv.to === 6);
  check("Snipe: does not fire through a shield tile", !!m2 && m2.bonusCaptures.length === 0, JSON.stringify(m2));

  // Warded target: mage p2 token at 9, p2 charges at cap.
  const s3 = state("p1", { 0: 6, 4: 9 });
  const pw3 = power({ p1: "archer", p2: "mage" }, { p2: CHARGE_CAP });
  const moves3 = getLegalPowerMoves(s3, pw3, 2);
  const m3 = moves3.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Snipe: does not fire through a warded target", !!m3 && m3.bonusCaptures.length === 0, JSON.stringify(m3));

  // Regression: Snipe must not leak into either player's private lane
  // (tiles 0-3 / 12-14) — the SAME index there is a different physical
  // tile per owner, which is what makes "home base" safe at all. p1's
  // archer enters ITS OWN lane at tile 0; p2 has a token at tile 1 in
  // P2's OWN private lane — a completely different square, not "one tile
  // ahead" of anything. Found via playtest confusion over enemy tokens
  // getting captured on home base.
  const s4 = state("p1", { 4: 1 });
  const pw4 = power({ p1: "archer" });
  const moves4 = getLegalPowerMoves(s4, pw4, 1); // token 0: from -1 -> to 0
  const m4 = moves4.find((mv) => mv.tokenId === 0 && mv.to === 0);
  check(
    "Snipe: does not leak into the enemy's own private lane (home base)",
    !!m4 && m4.bonusCaptures.length === 0,
    JSON.stringify(m4),
  );

  // Sanity: the legitimate private-lane/contested BOUNDARY case still
  // works — archer's own last private tile (3) looking one ahead into the
  // genuinely contested first shared tile (4) is a real, physical
  // adjacency and should still snipe.
  const s5 = state("p1", { 0: 2, 4: 4 });
  const pw5 = power({ p1: "archer" });
  const moves5 = getLegalPowerMoves(s5, pw5, 1); // token 0: from 2 -> to 3
  const m5 = moves5.find((mv) => mv.tokenId === 0 && mv.to === 3);
  check(
    "Snipe: still fires across the private-lane/contested boundary",
    !!m5 && m5.bonusCaptures.includes(4),
    JSON.stringify(m5),
  );
}

// ---------------------------------------------------------------------------
// 2. Push: normal knockback, own-token collision, off-the-front — all send
//    to reserve on collision/underflow, otherwise a clean -PUSH_DISTANCE.
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 4: 6 }); // enemy p2 token on contested tile 6
  const pw = power({ p1: "archer" }, { p1: 1 });
  const targets = getPushTargets(s, pw, "p1");
  check("Push: unprotected enemy on a contested tile is a valid target", targets.includes(4));

  const r = applyPush(s, pw, 4, "p1");
  const moved = r.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: knocks back exactly PUSH_DISTANCE with a clear landing",
    moved.position === 6 - PUSH_DISTANCE,
    `landed at ${moved.position}`,
  );
  check("Push: spends exactly one charge", r.power.charges.p1 === 0);

  // Collision case: p2's own token already sits at the landing tile.
  const sCollide = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE });
  const rCollide = applyPush(sCollide, pw, 4, "p1");
  const movedCollide = rCollide.state.tokens.find((t) => t.id === 4)!;
  check("Push: collision with target's own token sends it to reserve", movedCollide.position === -1);

  // Underflow case: starting exactly on tile 0, ANY push distance goes negative.
  const sUnder = state("p1", { 4: 0 });
  const rUnder = applyPush(sUnder, pw, 4, "p1");
  const movedUnder = rUnder.state.tokens.find((t) => t.id === 4)!;
  check("Push: pushing below tile 0 sends it to reserve", movedUnder.position === -1);
}

// ---------------------------------------------------------------------------
// 3. Ward blocks a would-be capture (only at the full charge cap)
// ---------------------------------------------------------------------------
{
  const s = state("p2", { 0: 6, 4: 4 }); // p1 sits on contested 6; p2 could try to land there
  // No class pierces Ward any more (Ward Breaker retired 2026-09-17 — see
  // the dedicated section just below this one); this test just picks an
  // arbitrary non-mage attacker to keep the fixture simple.
  const pwWarded = power({ p1: "mage", p2: "archer" }, { p1: CHARGE_CAP });
  const movesBlocked = getLegalPowerMoves(s, pwWarded, 2); // p2 token at 4, flip 2 -> to 6
  const blocked = movesBlocked.find((mv) => mv.tokenId === 4 && mv.to === 6);
  check("Ward: blocks capture for a non-Warrior at full charge cap", blocked === undefined, JSON.stringify(movesBlocked));

  // Below the cap: no ward, capture proceeds normally.
  const pwNotWarded = power({ p1: "mage", p2: "archer" }, { p1: CHARGE_CAP - 1 });
  const movesOpen = getLegalPowerMoves(s, pwNotWarded, 2);
  const open = movesOpen.find((mv) => mv.tokenId === 4 && mv.to === 6);
  check("Ward: does NOT block below the full charge cap", !!open && open.captures.includes(0), JSON.stringify(open));
}

// ---------------------------------------------------------------------------
// 4. Re-flip: spends REFLIP_COST per use (2 since 2026-09-16), counts uses, and is capped
//    at REFLIPS_PER_TURN per turn (see canReflipAgain — the shared gate the
//    server's validation, the bot, and the client button all consult)
// ---------------------------------------------------------------------------
{
  const pw = power({ p1: "mage" }, { p1: CHARGE_CAP });
  const after = applyReflip(pw, "p1");
  check("Re-flip: spends exactly REFLIP_COST", after.charges.p1 === CHARGE_CAP - REFLIP_COST, `got ${after.charges.p1}`);
  check("Re-flip: not offered below REFLIP_COST", !canReflipAgain(power({ p1: "mage" }, { p1: REFLIP_COST - 1 }), "p1") && canReflipAgain(power({ p1: "mage" }, { p1: REFLIP_COST }), "p1"));
  check("Re-flip: increments the per-turn use counter", after.reflipsUsedThisTurn === 1);
  check("Re-flip: does not touch the other player's charges", after.charges.p2 === pw.charges.p2);

  // REFLIPS_PER_TURN is 1 (2026-09-13): no second re-flip, charges or not.
  check("Re-flip: a SECOND re-flip is NOT offered (once a turn)", !canReflipAgain(after, "p1"));
  const afterSecond = applyReflip(after, "p1"); // the pure fn still spends if forced; the gate above is what the engine honors
  check("Re-flip: the pure apply still counts a forced second use", afterSecond.reflipsUsedThisTurn === 2);

  // Ward tension: spending below the full bank drops Ward that instant —
  // the whole built-in cost of double-re-flipping (isWarded gates on
  // charges === CHARGE_CAP). Checked here, next to the ability that pays it.
  const sWard = state("p1", { 0: 5, 4: 8 });
  const pwMageFull = power({ p2: "mage" }, { p2: CHARGE_CAP });
  check(
    "Re-flip: sanity — Mage's most-advanced token is warded at the full bank",
    isWarded(sWard, pwMageFull, sWard.tokens.find((t) => t.id === 4)!),
  );
  const pwMageSpent = applyReflip(pwMageFull, "p2");
  check(
    "Re-flip: spending below the full bank drops Ward (the double-re-flip tradeoff)",
    !isWarded(sWard, pwMageSpent, sWard.tokens.find((t) => t.id === 4)!),
  );

  // Denied with no charge left: one banked charge, one re-flip, done.
  const pwOne = power({ p1: "mage" }, { p1: 1 });
  const afterOne = applyReflip(pwOne, "p1");
  check("Re-flip: denied a second use when the bank is empty (1 spent, 0 left)", !canReflipAgain(afterOne, "p1"));

  // Denied a third time even with a charge available: the REFLIPS_PER_TURN
  // cap is a hard per-turn ceiling, not a charge-affordability check — a
  // re-rolled zero can refund a charge mid-turn (grantZeroFlipCharge in the
  // reflip path), and without the cap that refund loop would allow
  // unbounded re-flips in a single turn.
  const refunded: PowerState = { ...afterSecond, charges: { ...afterSecond.charges, p1: 1 } };
  check("Re-flip: denied a third use this turn even with a refunded charge banked", !canReflipAgain(refunded, "p1"));
  check(`Re-flip: sanity — the cap under test is REFLIPS_PER_TURN (${REFLIPS_PER_TURN})`, REFLIPS_PER_TURN === 1);

  // A fresh turn resets the counter (resetTurnFlags is what every
  // turn-ending resolve calls).
  check("Re-flip: a fresh turn resets the use counter", resetTurnFlags(afterSecond).reflipsUsedThisTurn === 0);
}

// ---------------------------------------------------------------------------
// 5. Warrior's Hold the Line (passive, replaces Ward Breaker 2026-09-17):
//    a discount on wallUpkeepFor for a wall the Warrior himself holds,
//    floored at WALL_BLEED_MIN — a discount, never free. Ward Breaker
//    itself is fully retired: a Warrior no longer pierces Ward, or anything
//    else below an ultimate — breaksWard stays on the wire but is always
//    false now (see PowerMove's doc).
// ---------------------------------------------------------------------------
{
  const pwWarrior = power({ p1: "warrior" });
  const pwOther = power({ p1: "cleric" });
  check(
    "Hold the Line: a Warrior's own wall is charged wallUpkeepFor at the discounted rate",
    wallUpkeepFor(pwWarrior, "p1") === Math.max(WALL_BLEED_MIN, WALL_BLEED - HOLD_THE_LINE_DISCOUNT),
  );
  check(
    "Hold the Line: every other class pays the full WALL_BLEED, no discount at all",
    wallUpkeepFor(pwOther, "p1") === WALL_BLEED,
  );
  check(
    "Hold the Line: the discount can never push the price below WALL_BLEED_MIN",
    Math.max(WALL_BLEED_MIN, WALL_BLEED - HOLD_THE_LINE_DISCOUNT) >= WALL_BLEED_MIN,
  );

  // REGRESSION (Ward Breaker's retirement): a Warrior landing on a Warded
  // enemy is now blocked exactly like every other class — no pierce left.
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "warrior", p2: "mage" }, { p2: CHARGE_CAP });
  const moves = getLegalPowerMoves(s, pw, 2); // 4 -> 6
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
  check(
    "Ward Breaker RETIRED: a Warrior's landing on a Warded enemy is no longer legal",
    m === undefined,
    JSON.stringify(moves),
  );
}

// ---------------------------------------------------------------------------
// 6. Charge: sweeps intermediate captures, stops at shield tiles and any
//    other protected stone (RETIRED 2026-09-17: the sweep used to pierce
//    Ward same as Ward Breaker; walls being absolute swept that pierce
//    away too — one isProtected check now, same as the landing tile),
//    refuses when its own token blocks the lane
// ---------------------------------------------------------------------------
{
  // p1 warrior at 4, flip 4 -> to 8. Intermediate contested tiles 5,6,7.
  // Put an unprotected p2 enemy at 6.
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "warrior" }, { p1: 1 });
  const moves = getLegalPowerMoves(s, pw, 4);
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Charge: available with a clear lane", !!m && m.chargeAvailable === true, JSON.stringify(m));
  check("Charge: sweeps the intermediate unprotected enemy", !!m && m.chargeSweepCaptures.includes(4), JSON.stringify(m));

  const r = applyCharge(s, pw, m!, "p1");
  // Charge costs 1, but THIS particular move also captures via the sweep —
  // which earns a charge back through the normal capture economy (same as
  // any other capturing move). Net: spend 1, earn 1, ends at 1, not 0.
  check("Charge: nets back to the same charge count when its sweep captures", r.power.charges.p1 === 1, `got ${r.power.charges.p1}`);
  const swept = r.state.tokens.find((t) => t.id === 4)!;
  check("Charge: the swept enemy is sent to reserve", swept.position === -1);

  // Isolate the pure spend: a Charge move with an empty lane (no sweep, no
  // landing capture) should end at exactly charges-1, no offsetting earn.
  const sBare = state("p1", { 0: 4 }); // no enemies anywhere
  const pwBare = power({ p1: "warrior" }, { p1: 1 });
  const movesBare = getLegalPowerMoves(sBare, pwBare, 4);
  const mBare = movesBare.find((mv) => mv.tokenId === 0 && mv.to === 8 && mv.chargeAvailable);
  const rBare = applyCharge(sBare, pwBare, mBare!, "p1");
  check("Charge: a non-capturing Charge is a pure 1-charge spend", rBare.power.charges.p1 === 0, `got ${rBare.power.charges.p1}`);

  // Shield at intermediate tile 7 protects even from Charge.
  const sShield = state("p1", { 0: 4, 4: 7 }); // 7 is a shield tile
  const movesShield = getLegalPowerMoves(sShield, pw, 4); // 4 -> 8
  const mShield = movesShield.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: does not sweep an enemy standing on a shield tile",
    !!mShield && !mShield.chargeSweepCaptures.includes(4),
    JSON.stringify(mShield),
  );

  // RETIRED 2026-09-17: a warded intermediate enemy is NOT swept any more
  // — Ward Breaker's old pierce ("Warriors pierce Ward, mid-lane or not")
  // retired with it, and one isProtected check now governs the sweep, same
  // as the landing tile.
  const sWard = state("p1", { 0: 4, 4: 6 });
  const pwWard = power({ p1: "warrior", p2: "mage" }, { p1: 1, p2: CHARGE_CAP });
  const movesWard = getLegalPowerMoves(sWard, pwWard, 4);
  const mWard = movesWard.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: does NOT sweep a warded intermediate enemy any more",
    !!mWard && !mWard.chargeSweepCaptures.includes(4),
    JSON.stringify(mWard),
  );

  // CHARGE_SWEEP_CAP: two unprotected enemies sit in the lane, but only 1
  // extra capture is recorded — matching Snipe's own bonus-capture ceiling
  // so no class's single move can out-capture the others by more than one.
  const sTwo = state("p1", { 0: 4, 4: 6, 5: 9 }); // p1 warrior 4 -> 11; p2 enemies at 6 and 9
  const movesTwo = getLegalPowerMoves(sTwo, pw, 7);
  const mTwo = movesTwo.find((mv) => mv.tokenId === 0 && mv.to === 11);
  check(
    "Charge: sweep captures are capped at CHARGE_SWEEP_CAP even with 2 sweepable enemies in the lane",
    !!mTwo && mTwo.chargeSweepCaptures.length === CHARGE_SWEEP_CAP,
    JSON.stringify(mTwo),
  );
  check(
    "Charge: the lane is still fully scanned for laneClear despite the capture cap",
    !!mTwo && mTwo.chargeAvailable === true,
    JSON.stringify(mTwo),
  );

  // Own token blocking the lane makes Charge unavailable (plain move still legal).
  const sBlocked = state("p1", { 0: 4, 1: 6 }); // own token 1 sits mid-lane
  const movesBlocked = getLegalPowerMoves(sBlocked, pw, 4);
  const mBlocked = movesBlocked.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: unavailable when own token blocks the lane",
    !!mBlocked && mBlocked.chargeAvailable === false,
    JSON.stringify(mBlocked),
  );

  // from === -1 (reserve entry) never offers Charge.
  const sReserve = state("p1", {});
  const movesReserve = getLegalPowerMoves(sReserve, pw, 3);
  const mReserve = movesReserve.find((mv) => mv.tokenId === 0);
  check(
    "Charge: never available on a reserve-entry move",
    !!mReserve && mReserve.chargeAvailable === false,
    JSON.stringify(mReserve),
  );
}

// ---------------------------------------------------------------------------
// 7. Push: cross-owner collisions (regression for a live playtest bug where
//    a pushed enemy could land on top of the pusher's own token)
// ---------------------------------------------------------------------------
{
  // Pusher's own token sits at the computed landing tile, in the CONTESTED
  // zone (positions 4-11 are the same physical tile for both players) — this
  // must send the target to reserve, not stack two owners on one tile.
  const s = state("p1", { 0: 5, 4: 6 }); // p1 token at 5, p2 target at 6
  const pw = power({ p1: "archer" }, { p1: 1 });
  const r = applyPush(s, pw, 4, "p1"); // rawTo = 6 - PUSH_DISTANCE(1) = 5
  const moved = r.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: colliding with the PUSHER's own token in the contested zone sends it to reserve",
    moved.position === -1,
    `landed at ${moved.position}`,
  );
  // No two tokens should ever end up sharing a tile.
  const occupied = r.state.tokens.filter((t) => t.position >= 0).map((t) => t.position);
  check(
    "Push: never leaves two tokens sharing one tile",
    new Set(occupied).size === occupied.length,
    JSON.stringify(r.state.tokens),
  );

  // Same numeric index, but OUTSIDE the contested zone (each player's private
  // lane is a physically separate tile despite the shared index) — must NOT
  // be treated as a collision.
  const sPrivate = state("p1", { 0: 3, 4: 4 }); // p1 token at ITS OWN index 3; p2 target at 4
  const rPrivate = applyPush(sPrivate, pw, 4, "p1"); // rawTo = 4 - 1 = 3 (p2's own private lane)
  const movedPrivate = rPrivate.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: a same-index private-lane token (different owner) is NOT a collision",
    movedPrivate.position === 3,
    `landed at ${movedPrivate.position}`,
  );
}

// ---------------------------------------------------------------------------
// 8. Ward: excludes escaped tokens (regression for a live playtest bug where
//    a warded token would keep glowing after escaping, and multiple escaped
//    tokens would all read as warded simultaneously)
// ---------------------------------------------------------------------------
{
  // p1 mage at full charge: one token escaped (15), one still on the board.
  // The on-board token should be the one warded — not the escaped one.
  const s = state("p1", { 0: PATH_LENGTH_PER_PLAYER, 1: 6 });
  const pw = power({ p1: "mage" }, { p1: CHARGE_CAP });
  const escaped = s.tokens.find((t) => t.id === 0)!;
  const onBoard = s.tokens.find((t) => t.id === 1)!;
  check("Ward: an escaped token is never warded", !isWarded(s, pw, escaped));
  check("Ward: an on-board token wards even after a teammate has escaped", isWarded(s, pw, onBoard));

  // Two escaped tokens (tied at position 15) — neither should ward.
  const s2 = state("p1", { 0: PATH_LENGTH_PER_PLAYER, 1: PATH_LENGTH_PER_PLAYER });
  const e1 = s2.tokens.find((t) => t.id === 0)!;
  const e2 = s2.tokens.find((t) => t.id === 1)!;
  check("Ward: two escaped tokens never both ward", !isWarded(s2, pw, e1) && !isWarded(s2, pw, e2));

  // All of the mage's tokens off the board (escaped/reserve) — nothing to ward.
  const s3 = state("p1", { 0: PATH_LENGTH_PER_PLAYER, 1: -1, 2: -1, 3: -1 });
  const anyToken = s3.tokens.find((t) => t.id === 0)!;
  check("Ward: no on-board tokens means nothing is warded", !isWarded(s3, pw, anyToken));
}

// ---------------------------------------------------------------------------
// 9. Push vs Ward (RETIRED pierce, 2026-09-17): walls are absolute now, and
//    that swept Ward's old distance-tier pierce away with them — a Warded
//    token is excluded from getPushTargets outright, the same isProtected
//    check every other pool uses. No special cost, no bigger knockback:
//    Ward simply blocks Push like it blocks a normal capture.
// ---------------------------------------------------------------------------
{
  // p2 mage's only on-board token (id4) is trivially most-advanced -> warded.
  const s = state("p1", { 4: 6 });
  const pw = power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP });
  check("Push: sanity — id4 is genuinely warded", isWarded(s, pw, s.tokens.find((t) => t.id === 4)!));
  check(
    "Push: a warded target is NOT a legal Push target at all, at any bank",
    !getPushTargets(s, pw, "p1").includes(4),
  );

  // The instant Ward hands off (a second on-board mage stone outranks it),
  // the formerly-warded token is a completely ordinary Push target again —
  // no lingering distance/cost tier, no residue from ever having been warded.
  const sHandoff = state("p1", { 4: 6, 5: 9 }); // id5 now most-advanced -> warded; id4 unwarded
  const pwHandoff = power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP });
  check("Push: sanity — Ward handed off to the more-advanced stone", isWarded(sHandoff, pwHandoff, sHandoff.tokens.find((t) => t.id === 5)!));
  check(
    "Push: the now-unwarded token is a legal target, knocked back the ordinary PUSH_DISTANCE",
    getPushTargets(sHandoff, pwHandoff, "p1").includes(4),
  );
  const r = applyPush(sHandoff, pwHandoff, 4, "p1");
  const moved = r.state.tokens.find((t) => t.id === 4)!;
  check("Push: ordinary knockback is PUSH_DISTANCE, no Ward-tier distance left to apply", moved.position === 6 - PUSH_DISTANCE);
  check("Push: the still-warded stone (id5) stays out of the pool", !getPushTargets(sHandoff, pwHandoff, "p1").includes(5));
}

// ---------------------------------------------------------------------------
// 10. Push refunds a charge when (and only when) it sends the target home —
//     that outcome is functionally a capture, so it earns the same refund
//     under the shared charge economy; a partial shove does not.
// ---------------------------------------------------------------------------
{
  // Sends home via collision -> refunded: net cost is 0, not 1.
  const sHome = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE }); // p2's own token sits at the landing tile
  const pw = power({ p1: "archer" }, { p1: 1 });
  const rHome = applyPush(sHome, pw, 4, "p1");
  const movedHome = rHome.state.tokens.find((t) => t.id === 4)!;
  check("Push refund: sanity — this push does send the target home", movedHome.position === -1);
  check(
    "Push refund: sending the target home refunds the charge (net cost 0)",
    rHome.power.charges.p1 === 1,
    `left with ${rHome.power.charges.p1} charges`,
  );

  // A clean, non-collision shove leaves the target on the board -> no refund.
  const sPartial = state("p1", { 4: 6 }); // alone — nothing to collide with
  const rPartial = applyPush(sPartial, pw, 4, "p1");
  const movedPartial = rPartial.state.tokens.find((t) => t.id === 4)!;
  check("Push refund: sanity — this push does NOT send the target home", movedPartial.position !== -1);
  check(
    "Push refund: a partial shove is a pure 1-charge spend, no refund",
    rPartial.power.charges.p1 === 0,
    `left with ${rPartial.power.charges.p1} charges`,
  );

  // Underflow (pushed off tile 0) also counts as sent-home -> also refunds.
  const sUnderflow = state("p1", { 4: 0 });
  const rUnderflow = applyPush(sUnderflow, pw, 4, "p1");
  check(
    "Push refund: underflow off tile 0 also refunds (it's sent-home too)",
    rUnderflow.power.charges.p1 === 1,
    `left with ${rUnderflow.power.charges.p1} charges`,
  );

  // The refund still respects CHARGE_CAP — starting already at the cap
  // minus the spend, refunding shouldn't be able to overshoot it.
  const pwAtCap = power({ p1: "archer" }, { p1: CHARGE_CAP });
  const rAtCap = applyPush(sHome, pwAtCap, 4, "p1");
  check(
    "Push refund: never overshoots CHARGE_CAP",
    rAtCap.power.charges.p1 === CHARGE_CAP,
    `left with ${rAtCap.power.charges.p1} charges`,
  );
}

// ---------------------------------------------------------------------------
// 11. Push always ends the turn (regression guard — see applyPush's history
//     note: granting an extra turn here was tried and reverted after it
//     blew archer-vs-mage/archer-vs-warrior out to ~95/5 and ~92/8).
// ---------------------------------------------------------------------------
{
  const pw = power({ p1: "archer" }, { p1: 1 });

  const sPartial = state("p1", { 4: 6 });
  const rPartial = applyPush(sPartial, pw, 4, "p1");
  check("Push: ends the turn after a partial shove", rPartial.state.currentPlayer === "p2");
  check("Push: extraTurn flag is false after a partial shove", rPartial.state.extraTurn === false);

  const sHome = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE });
  const rHome = applyPush(sHome, pw, 4, "p1");
  check("Push: ends the turn even when sending the target home", rHome.state.currentPlayer === "p2");
  check("Push: extraTurn flag is false even when sending the target home", rHome.state.extraTurn === false);
}

// ---------------------------------------------------------------------------
// 12. Ultimates: 3 consecutive shield landings in one unbroken turn-chain
//     bank ultimateReady for EVERY class (2026-09-16: the Archer's Rain of
//     Arrows used to fire on the third landing itself; it is now banked and
//     aimed like the other nine — see applyRainOfArrows).
// ---------------------------------------------------------------------------
{
  const seed = (n: number) => (pw: PowerState) => ({ ...pw, shieldStreak: { ...pw.shieldStreak, p1: n } });

  // The 3rd consecutive landing banks the flag — not the 2nd, not the 4th.
  const pwArcher2 = seed(2)(power({ p1: "archer" }));
  const s1 = state("p1", { 0: 6, 4: 9 }); // token0 6->7 (shield); enemy4 alone at 9 (contested)
  const m1 = getLegalPowerMoves(s1, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Ultimate: move to a shield tile is legal and available for this fixture", !!m1);
  const r1 = applyPowerMove(s1, pwArcher2, m1, "p1", () => 0);
  check("Ultimate: the Archer banks ultimateReady on the 3rd consecutive shield landing", r1.power.ultimateReady.p1 === true);
  check("Ultimate: nothing fires on the landing itself any more", r1.rainOfArrows === null && r1.state.tokens.find((t) => t.id === 4)!.position === 9);
  check("Ultimate: streak resets to 0 once it banks", r1.power.shieldStreak.p1 === 0);
  check("Ultimate: the landing still only grants the ordinary shield charge", r1.power.charges.p1 === 1, `got ${r1.power.charges.p1}`);

  // 1st and 2nd landings accumulate without banking.
  const pwArcher0 = power({ p1: "archer" });
  const r0 = applyPowerMove(s1, pwArcher0, m1, "p1", () => 0);
  check("Ultimate: 1st landing accumulates without banking", r0.power.ultimateReady.p1 === false && r0.power.shieldStreak.p1 === 1);
  const pwArcher1 = seed(1)(power({ p1: "archer" }));
  const rMid = applyPowerMove(s1, pwArcher1, m1, "p1", () => 0);
  check("Ultimate: 2nd landing accumulates without banking", rMid.power.ultimateReady.p1 === false && rMid.power.shieldStreak.p1 === 2);

  // The cast: aimed at one enemy in shared water, through everything.
  const ready: PowerState = { ...power({ p1: "archer", p2: "mage" }, { p1: 0, p2: CHARGE_CAP }), ultimateReady: { p1: true, p2: false } };
  const sCast = state("p1", { 0: 5, 4: 7, 5: 9, 6: 2 }); // enemy4 ON shield tile 7, enemy5 at 9 (warded: most advanced), enemy6 in its own lane
  const pool = getRainOfArrowsTargets(sCast, ready, "p1");
  check("Rain of Arrows: pool is every enemy in shared water, protections ignored", JSON.stringify(pool) === JSON.stringify([4, 5]), JSON.stringify(pool));
  check("Rain of Arrows: sanity — the candidate at 9 really is warded", isWarded(sCast, ready, sCast.tokens.find((t) => t.id === 5)!));
  const rW = applyRainOfArrows(sCast, ready, 5, "p1");
  check("Rain of Arrows: kills through Ward", rW.state.tokens.find((t) => t.id === 5)!.position === -1);
  const rS = applyRainOfArrows(sCast, ready, 4, "p1");
  check("Rain of Arrows: kills through a shield tile", rS.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Rain of Arrows: the archer's own stones are untouched", rS.state.tokens.find((t) => t.id === 0)!.position === 5);
  check("Rain of Arrows: spends ultimateReady", rS.power.ultimateReady.p1 === false);
  check("Rain of Arrows: grants one charge like any capturing action", rS.power.charges.p1 === 1, `got ${rS.power.charges.p1}`);
  check("Rain of Arrows: ends the turn", rS.state.currentPlayer === "p2" && rS.state.extraTurn === false);
  check("Rain of Arrows: breaks a live shield streak", applyRainOfArrows(sCast, { ...ready, shieldStreak: { p1: 2, p2: 0 } }, 4, "p1").power.shieldStreak.p1 === 0);
  const rB = applyRainOfArrows(sCast, { ...power({ p1: "archer", p2: "warrior" }), ultimateReady: { p1: true, p2: false }, walls: { 4: "bulwark" } }, 4, "p1");
  check("Rain of Arrows: kills through a wall and clears it", rB.state.tokens.find((t) => t.id === 4)!.position === -1 && rB.power.walls[4] === undefined);
  const rBl = applyRainOfArrows(sCast, { ...power({ p1: "archer", p2: "cleric" }), ultimateReady: { p1: true, p2: false }, walls: { 4: "blessing" } }, 4, "p1");
  check("Rain of Arrows: kills a blessed stone outright and clears its wall", rBl.state.tokens.find((t) => t.id === 4)!.position === -1 && rBl.power.walls[4] === undefined);
  // An ultimate: the Warlock's Dark Bargain does not answer it.
  const sWl = state("p1", { 0: 5, 4: 8, 6: 3 });
  const rWl = applyRainOfArrows(sWl, { ...power({ p1: "archer", p2: "warlock" }), ultimateReady: { p1: true, p2: false } }, 4, "p1");
  check("Rain of Arrows: bypasses Dark Bargain", rWl.state.tokens.find((t) => t.id === 4)!.position === -1 && rWl.state.tokens.find((t) => t.id === 6)!.position === 3);

  // Streak resets to 0 on any resolving move that doesn't land on a shield.
  const sPlain = state("p1", { 0: 4 });
  const mPlain = getLegalPowerMoves(sPlain, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 5)!;
  check("Ultimate: sanity — this move does not land on a shield", !mPlain.landsOnShield);
  const rPlain = applyPowerMove(sPlain, pwArcher2, mPlain, "p1");
  check("Ultimate: streak resets to 0 on any non-shield-landing move", rPlain.power.shieldStreak.p1 === 0);

  // Streak resets via Push (never lands the mover on a shield).
  const sPush = state("p1", { 4: 6 });
  const rPush = applyPush(sPush, seed(2)(power({ p1: "archer" }, { p1: 1 })), 4, "p1");
  check("Ultimate: streak resets to 0 via Push", rPush.power.shieldStreak.p1 === 0);

  // Re-flip is turn-neutral and doesn't touch the streak either way.
  const afterReflip = applyReflip({ ...pwArcher2, charges: { p1: REFLIP_COST, p2: 0 } }, "p1");
  check("Ultimate: Re-flip leaves the streak untouched", afterReflip.shieldStreak.p1 === 2);

  // Mage/Warrior complete the combo the same way.
  const pwMage2 = seed(2)(power({ p1: "mage" }));
  const mMage = getLegalPowerMoves(s1, pwMage2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rMage = applyPowerMove(s1, pwMage2, mMage, "p1", () => 0);
  check("Ultimate: Mage completing the combo banks ultimateReady", rMage.power.ultimateReady.p1 === true && rMage.power.shieldStreak.p1 === 0);
  const pwWarrior2 = seed(2)(power({ p1: "warrior" }));
  const mWarrior = getLegalPowerMoves(s1, pwWarrior2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rWarrior = applyPowerMove(s1, pwWarrior2, mWarrior, "p1", () => 0);
  check("Ultimate: Warrior completing the combo banks ultimateReady", rWarrior.power.ultimateReady.p1 === true && rWarrior.power.shieldStreak.p1 === 0);

  // breakShieldStreak: no-op at 0 (same reference back), resets a nonzero
  // streak to exactly 0, and works for any class (no gate anymore).
  const pwZero = power({ p1: "archer" });
  check("Ultimate: breakShieldStreak no-ops when already 0", breakShieldStreak(pwZero, "p1") === pwZero);
  const brokenArcher = breakShieldStreak(pwArcher2, "p1");
  check("Ultimate: breakShieldStreak resets a nonzero streak to 0", brokenArcher.shieldStreak.p1 === 0);
  const brokenWarrior = breakShieldStreak(seed(2)(power({ p1: "warrior" })), "p1");
  check("Ultimate: breakShieldStreak works for non-Archer classes too", brokenWarrior.shieldStreak.p1 === 0);

  check("Ultimate: ULTIMATE_STREAK is set to the expected combo length", ULTIMATE_STREAK === 3);
}

// ---------------------------------------------------------------------------
// 13. Ultimates: Mage's Blink Strike & Warrior's Warpath — the active
//     payoffs spent from a banked ultimateReady flag (see section 12 for how
//     that flag gets set).
// ---------------------------------------------------------------------------
{
  const readyPower = (cls: "mage" | "warrior"): PowerState => {
    const base = power({ p1: cls });
    return { ...base, ultimateReady: { ...base.ultimateReady, p1: true } };
  };

  // --- Blink Strike (Mage) -------------------------------------------------

  // Basic: relocates the mover's on-board token onto the target's tile,
  // capturing it and bypassing the target's shield-tile protection — and
  // the turn still ends even though the destination is a shield tile
  // (deliberately no extra-turn interaction).
  const sBlink = state("p1", { 0: 5, 4: 7 }); // mover token0 at 5; target enemy4 ON shield tile 7
  const pwBlink = readyPower("mage");
  check(
    "Blink Strike: target eligibility matches Rain of Arrows' rule (reused)",
    JSON.stringify(getBlinkStrikeTargets(sBlink, pwBlink, "p1")) === JSON.stringify(getRainOfArrowsTargets(sBlink, pwBlink, "p1")),
  );
  const rBlink = applyBlinkStrike(sBlink, pwBlink, 4, "p1");
  check("Blink Strike: relocates the mover's token onto the target's tile", rBlink.state.tokens.find((t) => t.id === 0)!.position === 7);
  check("Blink Strike: bypasses shield-tile protection, capturing the target", rBlink.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Blink Strike: sweptTokenIds is always empty", rBlink.sweptTokenIds.length === 0);
  check("Blink Strike: clears ultimateReady on use", rBlink.power.ultimateReady.p1 === false);
  check("Blink Strike: grants a charge on the capture", rBlink.power.charges.p1 === 1, `got ${rBlink.power.charges.p1}`);
  check(
    "Blink Strike: always ends the turn, even landing on a shield tile",
    rBlink.state.currentPlayer === "p2" && rBlink.state.extraTurn === false,
  );

  // Picks the MOST advanced on-board token when the mover has more than one.
  const sBlinkPick = state("p1", { 0: 3, 1: 9, 4: 10 }); // token1 (9) is more advanced than token0 (3)
  const rBlinkPick = applyBlinkStrike(sBlinkPick, readyPower("mage"), 4, "p1");
  check(
    "Blink Strike: relocates the MOST advanced on-board token, not just any",
    rBlinkPick.state.tokens.find((t) => t.id === 1)!.position === 10 && rBlinkPick.state.tokens.find((t) => t.id === 0)!.position === 3,
  );

  // Bypasses Ward.
  const sBlinkWard = state("p1", { 0: 5, 4: 9 });
  const pwBlinkWard: PowerState = { ...readyPower("mage"), classes: { p1: "mage", p2: "mage" }, charges: { p1: 0, p2: CHARGE_CAP } };
  check("Blink Strike: sanity — the target really is warded", isWarded(sBlinkWard, pwBlinkWard, sBlinkWard.tokens.find((t) => t.id === 4)!));
  const rBlinkWard = applyBlinkStrike(sBlinkWard, pwBlinkWard, 4, "p1");
  check("Blink Strike: captures a warded target", rBlinkWard.state.tokens.find((t) => t.id === 4)!.position === -1);

  // No on-board token to relocate -> no legal targets at all.
  const sBlinkNone = state("p1", { 4: 9 }); // p1 has zero on-board tokens
  check(
    "Blink Strike: no targets when the mover has no on-board token",
    getBlinkStrikeTargets(sBlinkNone, readyPower("mage"), "p1").length === 0,
  );

  // --- Warpath (Warrior) ----------------------------------------------------

  // Basic + sweep: the mover's on-board token teleports onto the target,
  // capturing it AND sweeping an unprotected enemy caught strictly between
  // start and destination — grants exactly 1 charge regardless.
  const sWarSweep = state("p1", { 0: 4, 4: 6, 5: 9 }); // mover token0 at 4; enemy4 at 6 (between); target enemy5 at 9
  const rWarSweep = applyWarpath(sWarSweep, readyPower("warrior"), 5, "p1");
  check("Warpath: relocates the mover's token onto the target's tile", rWarSweep.state.tokens.find((t) => t.id === 0)!.position === 9);
  check("Warpath: captures the primary target", rWarSweep.state.tokens.find((t) => t.id === 5)!.position === -1);
  check("Warpath: sweeps an unprotected enemy caught in between", rWarSweep.state.tokens.find((t) => t.id === 4)!.position === -1);
  check(
    "Warpath: reports the swept token in sweptTokenIds",
    rWarSweep.sweptTokenIds.length === 1 && rWarSweep.sweptTokenIds[0] === 4,
    JSON.stringify(rWarSweep.sweptTokenIds),
  );
  check("Warpath: grants exactly 1 charge regardless of sweep size", rWarSweep.power.charges.p1 === 1, `got ${rWarSweep.power.charges.p1}`);
  check("Warpath: clears ultimateReady on use", rWarSweep.power.ultimateReady.p1 === false);
  check("Warpath: always ends the turn", rWarSweep.state.currentPlayer === "p2" && rWarSweep.state.extraTurn === false);

  // Uncapped sweep: more enemies caught in between than CHARGE_SWEEP_CAP
  // would allow for an ordinary Charge — Warpath takes all of them.
  const sWarUncapped = state("p1", { 0: 4, 4: 5, 5: 6, 6: 8, 7: 10 }); // enemies at 5,6,8 between mover(4) and target(10)
  const rWarUncapped = applyWarpath(sWarUncapped, readyPower("warrior"), 7, "p1");
  check(
    `Warpath: sweep is uncapped (CHARGE_SWEEP_CAP is ${CHARGE_SWEEP_CAP}, this sweeps more)`,
    rWarUncapped.sweptTokenIds.length === 3,
    JSON.stringify(rWarUncapped.sweptTokenIds),
  );

  // Bypasses shield-tile protection AND Ward for a SWEPT token (not just the
  // primary target). Teleporting
  // BACKWARD (target behind the mover) puts the swept token closer to the
  // mover's start — i.e. at a HIGHER raw position than the target — which is
  // exactly what it takes for it to be p2's most-advanced on-board token
  // (and thus Warded) while the target itself isn't.
  const sWarWard = state("p1", { 0: 10, 4: 7, 5: 4 }); // mover token0 at 10; enemy4 ON shield tile 7 (between, p2's most-advanced -> warded); target enemy5 at 4
  const pwWarWard: PowerState = { ...readyPower("warrior"), classes: { p1: "warrior", p2: "mage" }, charges: { p1: 0, p2: CHARGE_CAP } };
  check("Warpath: sanity — the swept token really is warded", isWarded(sWarWard, pwWarWard, sWarWard.tokens.find((t) => t.id === 4)!));
  check(
    "Warpath: sanity — the primary target is NOT warded (it's not p2's most-advanced token)",
    !isWarded(sWarWard, pwWarWard, sWarWard.tokens.find((t) => t.id === 5)!),
  );
  const rWarWard = applyWarpath(sWarWard, pwWarWard, 5, "p1");
  check("Warpath: sweeps a warded token sitting on a shield tile", rWarWard.state.tokens.find((t) => t.id === 4)!.position === -1);
  // REGRESSION (safety removal): breaking a Ward along the way grants the
  // landing token nothing anymore — p2 can capture it right back (a fresh
  // p2 token entering at tile 4, where the Warpath landed p1's token0).
  const movesAfterWard = getLegalPowerMoves(rWarWard.state, rWarWard.power, 5); // p2's turn; reserve entry lands at 4
  const mRecapture = movesAfterWard.find((mv) => mv.to === 4 && mv.captures.includes(0));
  check(
    "Warpath: a Ward broken along the way grants NO protection to the landing token",
    !!mRecapture,
    JSON.stringify(movesAfterWard),
  );

  // Direction-agnostic: teleporting BACKWARD (target behind the mover) still
  // sweeps whatever's caught strictly between, same as forward.
  const sWarBackward = state("p1", { 0: 9, 4: 6, 5: 4 }); // mover token0 at 9; enemy4 at 6 (between); target enemy5 at 4
  const rWarBackward = applyWarpath(sWarBackward, readyPower("warrior"), 5, "p1");
  check(
    "Warpath: works backward (target behind the mover), sweeping what's between",
    rWarBackward.state.tokens.find((t) => t.id === 4)!.position === -1,
  );

  // Picks the LEAST advanced on-board token when the mover has more than one.
  const sWarPick = state("p1", { 0: 4, 1: 9, 4: 6 }); // token0 (4) is less advanced than token1 (9)
  const rWarPick = applyWarpath(sWarPick, readyPower("warrior"), 4, "p1");
  check(
    "Warpath: relocates the LEAST advanced on-board token, not just any",
    rWarPick.state.tokens.find((t) => t.id === 0)!.position === 6 && rWarPick.state.tokens.find((t) => t.id === 1)!.position === 9,
  );

  // Target eligibility mirrors Blink Strike's (same underlying rule).
  const sWarTargets = state("p1", { 0: 4, 4: 9 });
  check(
    "Warpath: target eligibility matches Blink Strike's / Rain of Arrows' rule (reused)",
    JSON.stringify(getWarpathTargets(sWarTargets, readyPower("warrior"), "p1")) ===
      JSON.stringify(getBlinkStrikeTargets(sWarTargets, readyPower("mage"), "p1")),
  );

  // No on-board token to relocate -> no legal targets at all.
  const sWarNone = state("p1", { 4: 9 }); // p1 has zero on-board tokens
  check(
    "Warpath: no targets when the mover has no on-board token",
    getWarpathTargets(sWarNone, readyPower("warrior"), "p1").length === 0,
  );
}

// ---------------------------------------------------------------------------
// 14. Warrior's Bulwark: a second charge-spend active. Unlike every other
//     power action, the mover taps ONE OF THEIR OWN on-board tokens.
//     RAISES A WALL (2026-09-17, the wall rework) — full immunity to
//     EVERYTHING below an ultimate (normal capture/Snipe, a Charge sweep,
//     AND Push, folded into isProtected/isWalled). No countdown, no saves:
//     a wall stays up until either an ultimate pierces it (and clears it
//     off the captured token, see clearWallsOnReserveTrip) or its owner
//     can't pay wallUpkeepFor it on their own next turn (section 14b).
// ---------------------------------------------------------------------------
{
  // --- Legal targeting -------------------------------------------------
  {
    // p1 warrior: token0 on-board, token1 in reserve, token2 escaped.
    const s = state("p1", { 0: 4, 2: PATH_LENGTH_PER_PLAYER, 4: 6 });
    const pw = power({ p1: "warrior" }, { p1: 2 });
    const targets = getBulwarkTargets(s, pw, "p1");
    check("Bulwark: an on-board own token is a legal target", targets.includes(0), JSON.stringify(targets));
    check("Bulwark: a reserve own token is not a legal target", !targets.includes(1), JSON.stringify(targets));
    check("Bulwark: an escaped own token is not a legal target", !targets.includes(2), JSON.stringify(targets));
    check("Bulwark: an enemy token is never a legal target", !targets.includes(4), JSON.stringify(targets));

    const pwWalled: PowerState = { ...pw, walls: { 0: "bulwark" } };
    check(
      "Bulwark: an already-walled token is excluded from re-targeting",
      !getBulwarkTargets(s, pwWalled, "p1").includes(0),
    );
  }

  // --- Charge economy ----------------------------------------------------
  // Mirrors Push/Charge/Re-flip's own convention: applyBulwark doesn't
  // self-guard on charges >= 1 (neither do they) — that gate lives at the
  // referee.ts/api/ws.ts dispatch layer, same trust model as every other
  // power action's pure apply* function.
  {
    const s = state("p1", { 0: 4 });
    const pw = power({ p1: "warrior" }, { p1: 2 });
    const r = applyBulwark(s, pw, 0, "p1");
    check("Bulwark: spends exactly one charge", r.power.charges.p1 === 1, `got ${r.power.charges.p1}`);
    check(
      "Bulwark: raises a 'bulwark' wall on the target, no countdown attached",
      r.power.walls[0] === "bulwark",
      `got ${JSON.stringify(r.power.walls)}`,
    );
    check("Bulwark: ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
  }

  // --- Blocks a normal capturing move -------------------------------------
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "archer", p2: "warrior" }), walls: { 4: "bulwark" } };
    const moves = getLegalPowerMoves(s, pw, 2); // token0: 4 -> 6
    const blocked = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check("Bulwark: blocks a normal capturing move onto the walled token", blocked === undefined, JSON.stringify(moves));

    // Sanity: the exact same setup captures fine without a wall.
    const pwNo = power({ p1: "archer", p2: "warrior" });
    const movesNo = getLegalPowerMoves(s, pwNo, 2);
    const openMove = movesNo.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check(
      "Bulwark: sanity — the same move captures normally without a wall",
      !!openMove && openMove.captures.includes(4),
    );
  }

  // --- Blocks a Charge sweep -----------------------------------------------
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "warrior" }, { p1: 1 }), walls: { 4: "bulwark" } };
    const moves = getLegalPowerMoves(s, pw, 4); // token0: 4 -> 8, enemy4 mid-lane at 6
    const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 8);
    check("Bulwark: Charge is still available (lane clear)", !!m && m.chargeAvailable === true, JSON.stringify(m));
    check(
      "Bulwark: blocks the Charge sweep capture of the walled token",
      !!m && !m.chargeSweepCaptures.includes(4),
      JSON.stringify(m),
    );
  }

  // --- Push: no interaction at all with a walled target ---------------------
  // (2026-09-17: walls are absolute — Push used to still land a soft, non-
  // home shove on a Bulwarked token; that partial carve-out is retired along
  // with the countdown. isProtected excludes it from getPushTargets outright.)
  {
    const sSoft = state("p1", { 4: 8 }); // p2's only on-board token, alone -> no collision even so
    const pw: PowerState = { ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }), walls: { 4: "bulwark" } };
    check("Bulwark: NOT a legal Push target at all, even a clean non-collision shove", !getPushTargets(sSoft, pw, "p1").includes(4));

    const pwNoWall = power({ p1: "archer", p2: "warrior" }, { p1: 1 });
    check(
      "Bulwark: sanity — the identical push IS legal without a wall",
      getPushTargets(sSoft, pwNoWall, "p1").includes(4),
    );
  }

  // --- Blink Strike pierces Bulwark (2026-07-17; still true post-rework) ---
  {
    const s = state("p1", { 0: 5, 4: 8 });
    const base = power({ p1: "mage" });
    const pw: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true }, walls: { 4: "bulwark" } };
    const targets = getBlinkStrikeTargets(s, pw, "p1");
    check("Bulwark: a walled token IS a legal Blink Strike target (ultimates pierce)", targets.includes(4), JSON.stringify(targets));

    const r = applyBlinkStrike(s, pw, 4, "p1");
    check("Bulwark: Blink Strike captures the walled token", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    // Leak regression (same bug class as the old Rain of Arrows fix): the
    // captured token's wall must not survive the trip to reserve.
    check(
      "Bulwark: Blink Strike clears the captured token's wall",
      r.power.walls[4] === undefined,
      JSON.stringify(r.power.walls),
    );
  }

  // --- Warpath pierces Bulwark too (primary target AND swept tokens) -------
  {
    const sTarget = state("p1", { 0: 4, 4: 9 });
    const baseW = power({ p1: "warrior" });
    const pwTarget: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, walls: { 4: "bulwark" } };
    check(
      "Bulwark: a walled token IS a legal Warpath primary target (ultimates pierce)",
      getWarpathTargets(sTarget, pwTarget, "p1").includes(4),
    );

    // Sweep victim walled (the primary target itself is unprotected) — the
    // sweep takes it anyway, and its wall clears with it.
    const sSweep = state("p1", { 0: 4, 4: 6, 5: 9 }); // mover token0 at 4; enemy4 at 6 (between, walled); target enemy5 at 9
    const pwSweep: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, walls: { 4: "bulwark" } };
    const r = applyWarpath(sSweep, pwSweep, 5, "p1");
    check("Bulwark: a walled token in Warpath's path IS swept", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Bulwark: the swept walled id appears in sweptTokenIds", r.sweptTokenIds.includes(4));
    check("Bulwark: the primary target is still captured", r.state.tokens.find((t) => t.id === 5)!.position === -1);
    check(
      "Bulwark: Warpath clears the swept token's wall",
      r.power.walls[4] === undefined,
      JSON.stringify(r.power.walls),
    );
  }

  // --- Rain of Arrows pierces Bulwark (always has; cast form since 2026-09-16)
  {
    const s = state("p1", { 0: 6, 4: 9 }); // enemy4 at 9, walled
    const seeded: PowerState = { ...power({ p1: "archer" }), ultimateReady: { p1: true, p2: false }, walls: { 4: "bulwark" } };
    check("Bulwark: a walled stone is still in Rain of Arrows' pool", getRainOfArrowsTargets(s, seeded, "p1").includes(4));
    const r = applyRainOfArrows(s, seeded, 4, "p1");
    check("Bulwark: Rain of Arrows bypasses Bulwark (same rule as every ultimate now)", r.state.tokens.find((t) => t.id === 4)!.position === -1);
  }

  // --- getBulwarkBlockedIds: announcement-only now (2026-09-17) -------------
  // A wall no longer expires or gets consumed by blocking something — it
  // falls only when its owner can't pay wallUpkeepFor it (section 14b) — so
  // this function is a pure read, computed by diffing the real move lists
  // against the same lists with every wall/Vanish switched off. It still
  // exists purely to tell the client "that would have connected."
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "warrior", p2: "warrior" }), walls: { 4: "bulwark" } };
    const blocked = getBulwarkBlockedIds(s, pw, 2); // token0: 4 -> 6, would capture 4
    check("Bulwark: getBulwarkBlockedIds reports the token this flip would have captured", blocked.includes(4), JSON.stringify(blocked));
    check(
      "Bulwark: getBulwarkBlockedIds is a pure read — the wall itself is untouched",
      getBulwarkBlockedIds(s, pw, 2) !== undefined && pw.walls[4] === "bulwark",
    );

    // tickBulwarkForNewTurn/tickBulwarkForReflip are now pure pass-throughs
    // over the same read (kept for room-engine/sim call-site compat) —
    // neither one mutates the wall either.
    const combo = tickBulwarkForNewTurn(s, pw, 2);
    check("Bulwark: tickBulwarkForNewTurn reports the same blocked id", combo.blockedIds.includes(4));
    check("Bulwark: tickBulwarkForNewTurn's returned power still has the wall up", combo.power.walls[4] === "bulwark");
    const comboReflip = tickBulwarkForReflip(s, pw, 2);
    check("Bulwark: tickBulwarkForReflip reports the same, and is equally a no-op on the wall", comboReflip.blockedIds.includes(4) && comboReflip.power.walls[4] === "bulwark");

    // Charge-sweep-only threat: doesn't count as "blocked" unless the mover
    // can actually afford to spend a charge on Charge this turn.
    const sSweepOnly = state("p1", { 0: 4, 4: 6 }); // token0: 4 -> 8 (flip 4); enemy4 mid-lane at 6 only
    const pwSweepNoCharge: PowerState = {
      ...power({ p1: "warrior", p2: "warrior" }, { p1: 0 }),
      walls: { 4: "bulwark" },
    };
    check(
      "Bulwark: a Charge-sweep-only threat is NOT 'blocked' when the mover has 0 charges",
      !getBulwarkBlockedIds(sSweepOnly, pwSweepNoCharge, 4).includes(4),
    );
    const pwSweepWithCharge: PowerState = {
      ...power({ p1: "warrior", p2: "warrior" }, { p1: 1 }),
      walls: { 4: "bulwark" },
    };
    check(
      "Bulwark: a Charge-sweep threat DOES count as blocked once the mover can afford Charge",
      getBulwarkBlockedIds(sSweepOnly, pwSweepWithCharge, 4).includes(4),
    );

    // Push immunity is a STATIC property (isProtected excludes the target
    // from the pool outright) — never a "block" getBulwarkBlockedIds needs
    // to report, at any charge level.
    const sPushOnly = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE }); // p2 token4 walled; own-token collision at the landing tile
    const pwPushWithCharge: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      walls: { 4: "bulwark" },
    };
    check(
      "Bulwark: Push immunity keeps the target out of the pool",
      !getPushTargets(sPushOnly, pwPushWithCharge, "p1").includes(4),
    );
    check(
      "Bulwark: Push immunity is static — never something getBulwarkBlockedIds reports",
      !getBulwarkBlockedIds(sPushOnly, pwPushWithCharge, 1).includes(4),
    );
  }
}

// ---------------------------------------------------------------------------
// 14b. The wall system's upkeep tick (WALL_BLEED, 2026-09-17) + Vanish's
//      own countdown tick + the Barbarian's canHoldWall guardrail. Every
//      wall costs its owner wallUpkeepFor it on their own next turn-start,
//      front (most-advanced) stone first — "the front holds longest" — and
//      an unaffordable one DROPS (unprotecting that stone THIS turn, not a
//      save-consuming block). wallGrace waives exactly one wall's payment
//      first, same front-first order, before any charge is spent.
// ---------------------------------------------------------------------------
{
  // --- Pays when affordable, wall stays up ----------------------------------
  {
    const s = state("p1", { 0: 5 });
    const pw: PowerState = { ...power({ p1: "warrior" }, { p1: CHARGE_CAP }), walls: { 0: "bulwark" } };
    const r = tickWallUpkeepForNewTurn(s, pw);
    check("Wall upkeep: pays wallUpkeepFor exactly", r.paid === wallUpkeepFor(pw, "p1"), `paid ${r.paid}`);
    check("Wall upkeep: charges a real cost", r.power.charges.p1 === CHARGE_CAP - wallUpkeepFor(pw, "p1"));
    check("Wall upkeep: the wall survives", r.power.walls[0] === "bulwark");
    check("Wall upkeep: nothing dropped", r.droppedTokenIds.length === 0, JSON.stringify(r.droppedTokenIds));
  }

  // --- Drops when unaffordable, unprotecting the stone this turn -----------
  {
    const s = state("p1", { 0: 5 });
    const poor = Math.max(0, wallUpkeepFor(power({ p1: "warrior" }), "p1") - 1);
    const pw: PowerState = { ...power({ p1: "warrior" }, { p1: poor }), walls: { 0: "bulwark" } };
    const r = tickWallUpkeepForNewTurn(s, pw);
    check("Wall upkeep: pays nothing when it can't afford the bill", r.paid === 0, `paid ${r.paid}`);
    check("Wall upkeep: drops the unaffordable wall", r.power.walls[0] === undefined, JSON.stringify(r.power.walls));
    check("Wall upkeep: reports the dropped id", r.droppedTokenIds.includes(0), JSON.stringify(r.droppedTokenIds));
    check("Wall upkeep: an unaffordable spend is never partial — the bank is untouched", r.power.charges.p1 === poor);
  }

  // --- Most-advanced-first: funds run out, the FRONT wall survives ----------
  {
    const cost = wallUpkeepFor(power({ p1: "warrior" }), "p1");
    const s = state("p1", { 0: 9, 1: 5 }); // id0 more advanced than id1
    const pw: PowerState = { ...power({ p1: "warrior" }, { p1: cost }), walls: { 0: "bulwark", 1: "bulwark" } };
    const r = tickWallUpkeepForNewTurn(s, pw);
    check("Wall upkeep: the front (most-advanced) wall is paid first and survives", r.power.walls[0] === "bulwark");
    check("Wall upkeep: the rear wall drops once the bank runs dry", r.power.walls[1] === undefined);
    check("Wall upkeep: only the rear id is reported dropped", r.droppedTokenIds.length === 1 && r.droppedTokenIds[0] === 1, JSON.stringify(r.droppedTokenIds));
  }

  // --- wallGrace waives exactly one wall's payment, front-first ------------
  {
    const cost = wallUpkeepFor(power({ p1: "warrior" }), "p1");
    const s = state("p1", { 0: 9, 1: 5 });
    const base = power({ p1: "warrior" }, { p1: cost }); // just enough for ONE paid wall
    const pw: PowerState = { ...base, walls: { 0: "bulwark", 1: "bulwark" }, wallGrace: { ...base.wallGrace, p1: 1 } };
    const r = tickWallUpkeepForNewTurn(s, pw);
    // Only ONE wall's worth is actually charged (the rear one) — the front
    // is waived by grace, not paid, so total paid equals a single cost,
    // not two.
    check("Wall upkeep: grace waives the front wall's payment", r.power.walls[0] === "bulwark" && r.paid === cost, `paid ${r.paid}, cost ${cost}`);
    check("Wall upkeep: the rear wall is paid for out of the now-untouched bank", r.power.walls[1] === "bulwark");
    check("Wall upkeep: nothing dropped — grace plus the bank covered both", r.droppedTokenIds.length === 0);
    check("Wall upkeep: the spent grace turn is consumed", r.power.wallGrace.p1 === 0);
  }

  // --- Only the mover's OWN walls tick; an empty wall list is a no-op ------
  {
    const s = state("p1", { 0: 5, 4: 6 });
    const pw: PowerState = { ...power({ p1: "warrior", p2: "warrior" }, { p1: 0 }), walls: { 4: "bulwark" } };
    const r = tickWallUpkeepForNewTurn(s, pw);
    check("Wall upkeep: the OTHER player's wall is untouched on this player's tick", r.power.walls[4] === "bulwark" && r.paid === 0 && r.droppedTokenIds.length === 0);

    const pwEmpty = power({ p1: "warrior" });
    const rEmpty = tickWallUpkeepForNewTurn(s, pwEmpty);
    check("Wall upkeep: a mover with no walls is an exact no-op (same power reference)", rEmpty.power === pwEmpty && rEmpty.paid === 0);
  }

  // --- Vanish's own tick: fixed countdown, no upkeep, no grace --------------
  {
    const s = state("p1", { 0: 5 });
    const pw: PowerState = { ...power({ p1: "rogue" }, { p1: 0 }), vanished: { 0: 2 } };
    const r1 = tickVanishForNewTurn(s, pw);
    check("Vanish tick: decrements by exactly 1, no charge cost at all", r1.power.vanished[0] === 1 && r1.power.charges.p1 === 0);
    check("Vanish tick: not yet expired", r1.expiredTokenIds.length === 0);
    const r2 = tickVanishForNewTurn(s, r1.power);
    check("Vanish tick: expires (clears) at 0, reported in expiredTokenIds", r2.power.vanished[0] === undefined && r2.expiredTokenIds.includes(0));

    const sFar = state("p1", { 0: 5, 4: 6 });
    const pwOther: PowerState = { ...power({ p1: "rogue", p2: "rogue" }), vanished: { 4: 2 } };
    const rOther = tickVanishForNewTurn(sFar, pwOther);
    check("Vanish tick: the OTHER player's vanished stone is untouched on this player's tick", rOther.power.vanished[4] === 2);
  }

  // --- Barbarian canHoldWall: the glass cannon can NEVER hold a wall --------
  {
    const s = state("p1", { 0: 5, 1: 8 });
    const token0 = s.tokens.find((t) => t.id === 0)!;
    const pwBarb = power({ p1: "barbarian" }, { p1: CHARGE_CAP });
    check("Barbarian: canHoldWall is false for a barbarian's own token", !canHoldWall(pwBarb, token0));
    const pwWarrior = power({ p1: "warrior" }, { p1: CHARGE_CAP });
    check("Barbarian: sanity — canHoldWall is true for every other class", canHoldWall(pwWarrior, token0));

    // Defensive guardrail, not just a unit check on the predicate: every
    // wall-granting pool (Bulwark's shown here; Bless/Benediction share the
    // same guard) must exclude a barbarian's own stone even if some future
    // ability tried to hand him one.
    check(
      "Barbarian: getBulwarkTargets excludes his own token outright",
      !getBulwarkTargets(s, pwBarb, "p1").includes(0),
    );
    check(
      "Barbarian: getBlessTargets excludes his own token outright too (same shared guard)",
      !getBlessTargets(s, pwBarb, "p1").includes(0),
    );

    // A shield TILE still protects him — canHoldWall is about the PAID kind
    // of protection specifically, not every form of it.
    const sShield = state("p1", { 0: 7, 4: 4 }); // tile 7 is a shield tile; enemy in flip reach
    const pwBarbShield = power({ p1: "barbarian", p2: "archer" }, { p1: 0, p2: CHARGE_CAP });
    check(
      "Barbarian: a shield tile still protects him even though he can never hold a wall",
      isProtected(sShield, pwBarbShield, sShield.tokens.find((t) => t.id === 0)!),
    );
  }
}

// ---------------------------------------------------------------------------
// 15. Archer's Charged Shot: spends BOTH banked charges at once for a flat,
//     fixed knockback — same target-pool shape as Push (contested zone,
//     shield/Bulwark protections), but using
//     CHARGED_SHOT_DISTANCE's own collision math, gated on
//     charges === CHARGE_CAP right inside getChargedShotTargets itself, and
//     (unlike the original design) fully blocked by Ward with no
//     PUSH_WARD_COST-style affordability escape hatch — see the dedicated
//     Ward block below for that coverage.
// ---------------------------------------------------------------------------
{
  // --- Legality: gated on charges >= CHARGED_SHOT_COST -------------------
  {
    const s = state("p1", { 4: 8 }); // enemy alone on a contested tile
    const pwBelow = power({ p1: "archer" }, { p1: CHARGED_SHOT_COST - 1 });
    check(
      "Charged Shot: no targets offered below its cost",
      getChargedShotTargets(s, pwBelow, "p1").length === 0,
      JSON.stringify(getChargedShotTargets(s, pwBelow, "p1")),
    );
    const pwAt = power({ p1: "archer" }, { p1: CHARGE_CAP });
    check(
      "Charged Shot: targets ARE offered at exactly the full charge cap",
      getChargedShotTargets(s, pwAt, "p1").includes(4),
    );
  }

  // --- Legality: target must be in the contested zone, same as Push -------
  {
    const pw = power({ p1: "archer" }, { p1: CHARGE_CAP });
    // Enemy sitting in ITS OWN private lane (index 1) is never a valid
    // target — same "contested zone only" rule getPushTargets enforces.
    const sPrivate = state("p1", { 4: 1 });
    check(
      "Charged Shot: a target outside the contested zone is never legal",
      getChargedShotTargets(sPrivate, pw, "p1").length === 0,
    );
    const sContested = state("p1", { 4: 6 });
    check(
      "Charged Shot: a target inside the contested zone is legal",
      getChargedShotTargets(sContested, pw, "p1").includes(4),
    );
  }

  // --- Legality: respects shield tiles, same as Push ----------------------
  {
    const pw = power({ p1: "archer" }, { p1: CHARGE_CAP });
    const sShield = state("p1", { 4: 7 }); // tile 7 is a shield tile
    check(
      "Charged Shot: a target on a shield tile is not a legal target",
      !getChargedShotTargets(sShield, pw, "p1").includes(4),
    );
  }

  // --- Legality: a wall blocks a Charged Shot target OUTRIGHT (2026-09-17:
  //     walls are absolute — this used to be conditional on THIS distance's
  //     own collision math sending the target home; that soft/hard split
  //     is retired, see the dedicated "Walls are absolute" block below for
  //     the full soft-and-hard coverage). ------------------------------
  {
    const posHome = 9;
    const landingHome = posHome - CHARGED_SHOT_DISTANCE;
    check("Charged Shot: sanity — this fixture's landing tile is a valid placement", landingHome >= 0);
    const sHome = state("p1", { 4: posHome, 5: landingHome });
    const pwHome: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      walls: { 4: "bulwark" },
    };
    check(
      "Charged Shot: a walled target is NOT legal, even where this distance would send it home",
      !getChargedShotTargets(sHome, pwHome, "p1").includes(4),
    );

    // Sanity: the identical send-home shot IS legal without a wall.
    const pwHomeNoWall = power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP });
    check(
      "Charged Shot: sanity — the identical send-home shot IS legal without a wall",
      getChargedShotTargets(sHome, pwHomeNoWall, "p1").includes(4),
    );
  }

  // --- Landing/collision math at CHARGED_SHOT_DISTANCE ---------------------
  {
    const pw = power({ p1: "archer" }, { p1: CHARGE_CAP });
    const s = state("p1", { 4: 9 });
    const r = applyChargedShot(s, pw, 4, "p1");
    const moved = r.state.tokens.find((t) => t.id === 4)!;
    check(
      "Charged Shot: knocks back exactly CHARGED_SHOT_DISTANCE with a clear landing",
      moved.position === 9 - CHARGED_SHOT_DISTANCE,
      `landed at ${moved.position}`,
    );

    // Collision case: p2's own token already sits at the landing tile.
    const sCollide = state("p1", { 4: 9, 5: 9 - CHARGED_SHOT_DISTANCE });
    const rCollide = applyChargedShot(sCollide, pw, 4, "p1");
    const movedCollide = rCollide.state.tokens.find((t) => t.id === 4)!;
    check("Charged Shot: collision with the target's own token sends it to reserve", movedCollide.position === -1);

    // Boundary: starting from the contested zone's lowest tile (4), the
    // landing math still matches CHARGED_SHOT_DISTANCE exactly, whether that
    // lands on-board or underflows to a send-home — same shared
    // computeKnockbackLanding math Push's own underflow tests exercise.
    const sBoundary = state("p1", { 4: 4 });
    const rBoundary = applyChargedShot(sBoundary, pw, 4, "p1");
    const movedBoundary = rBoundary.state.tokens.find((t) => t.id === 4)!;
    const expectedBoundary = 4 - CHARGED_SHOT_DISTANCE < 0 ? -1 : 4 - CHARGED_SHOT_DISTANCE;
    check(
      "Charged Shot: landing math at the contested-zone floor matches CHARGED_SHOT_DISTANCE exactly",
      movedBoundary.position === expectedBoundary,
      `landed at ${movedBoundary.position}, expected ${expectedBoundary}`,
    );
  }

  // --- Charge cost + refund on send-home -----------------------------------
  {
    const pwFull = power({ p1: "archer" }, { p1: CHARGE_CAP });

    // Sends home via collision -> refunded: net cost is CHARGE_CAP - 1, not
    // CHARGE_CAP — same flat +1 refund mechanism normal Push already gets.
    const posHome = 9;
    const sHome = state("p1", { 4: posHome, 5: posHome - CHARGED_SHOT_DISTANCE });
    const rHome = applyChargedShot(sHome, pwFull, 4, "p1");
    const movedHome = rHome.state.tokens.find((t) => t.id === 4)!;
    check("Charged Shot refund: sanity — this shot does send the target home", movedHome.position === -1);
    check(
      "Charged Shot refund: sending the target home refunds 1 charge (net cost CHARGE_CAP - 1, not CHARGE_CAP)",
      rHome.power.charges.p1 === CHARGE_CAP - 1,
      `left with ${rHome.power.charges.p1} charges`,
    );
    check("Charged Shot refund: never overshoots CHARGE_CAP", rHome.power.charges.p1 <= CHARGE_CAP);

    // A clean, non-collision shove leaves the target on the board -> spends
    // exactly BOTH charges, no refund at all.
    const sPartial = state("p1", { 4: 11 }); // alone — nothing to collide with
    const rPartial = applyChargedShot(sPartial, pwFull, 4, "p1");
    const movedPartial = rPartial.state.tokens.find((t) => t.id === 4)!;
    check("Charged Shot refund: sanity — this shot does NOT send the target home", movedPartial.position !== -1);
    check(
      "Charged Shot: spends exactly CHARGED_SHOT_COST when no refund applies",
      rPartial.power.charges.p1 === CHARGE_CAP - CHARGED_SHOT_COST,
      `left with ${rPartial.power.charges.p1} charges`,
    );
  }

  // --- Ends the turn, same regression shape as Push's own guard -----------
  {
    const pw = power({ p1: "archer" }, { p1: CHARGE_CAP });
    const sPartial = state("p1", { 4: 11 });
    const rPartial = applyChargedShot(sPartial, pw, 4, "p1");
    check("Charged Shot: ends the turn after a partial shove", rPartial.state.currentPlayer === "p2");
    check("Charged Shot: extraTurn flag is false after a partial shove", rPartial.state.extraTurn === false);
  }

  // --- Charged Shot vs Ward (RETIRED pierce, 2026-09-17): walls are
  //     absolute now, and Ward's old distance-tier pierce retired with
  //     them — a Warded target is excluded from getChargedShotTargets
  //     outright, the same isProtected check every other pool uses. ------
  {
    // p2 mage's only on-board token (id4) is trivially most-advanced -> warded.
    const posWard = 8;
    const sWard = state("p1", { 4: posWard });
    const pwWard = power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP });
    check(
      "Charged Shot vs Ward: sanity — the target really is warded",
      isWarded(sWard, pwWard, sWard.tokens.find((t) => t.id === 4)!),
    );
    check(
      "Charged Shot: a Warded target is NOT a legal target at all",
      !getChargedShotTargets(sWard, pwWard, "p1").includes(4),
    );

    // An UNwarded enemy (mage's charges below cap) is a completely ordinary
    // target, knocked back CHARGED_SHOT_DISTANCE — the only tier left.
    const pwUnwarded = power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP - 1 });
    check(
      "Charged Shot: an unwarded enemy (charges below cap) is a legal target",
      getChargedShotTargets(sWard, pwUnwarded, "p1").includes(4),
    );
    const rUnwarded = applyChargedShot(sWard, pwUnwarded, 4, "p1");
    const movedUnwarded = rUnwarded.state.tokens.find((t) => t.id === 4)!;
    check(
      "Charged Shot vs an unwarded target: knocks back CHARGED_SHOT_DISTANCE, the only tier left",
      movedUnwarded.position === posWard - CHARGED_SHOT_DISTANCE,
      `landed at ${movedUnwarded.position}, expected ${posWard - CHARGED_SHOT_DISTANCE}`,
    );
  }

  // --- Walls are absolute against Charged Shot too — no soft-shove
  //     exception left (unlike the old reveal-time save accounting, a wall
  //     never melts from being targeted: it simply isn't in the pool). ----
  {
    const posHome = 9;
    const sChargedShotOnly = state("p1", { 4: posHome, 5: posHome - CHARGED_SHOT_DISTANCE });
    const pwAtCap: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      walls: { 4: "bulwark" },
    };
    check(
      "Walls: a walled target is out of Charged Shot's pool even with a clean (non-collision) landing",
      !getChargedShotTargets(sChargedShotOnly, pwAtCap, "p1").includes(4),
    );
    const sSoft = state("p1", { 4: posHome });
    const pwSoft: PowerState = { ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }), walls: { 4: "bulwark" } };
    check(
      "Walls: a walled target is out of the pool for a soft shove too — no partial exception",
      !getChargedShotTargets(sSoft, pwSoft, "p1").includes(4),
    );
  }

  // --- REGRESSION (2026-07-17, still true under the wall rework): an
  //     ultimate-ready threat never counts as a wall BLOCK — ultimates
  //     pierce a wall, so nothing was blocked and getBulwarkBlockedIds
  //     (announcement-only now) must not report it. ------------------------
  {
    // p2's walled token at 9 is out of reach of any normal capture/Push
    // (p1's only token is far behind at 4 with a flip of 1 -> to 5), but a
    // ready Blink Strike could take it — that must NOT read as "blocked."
    const sUltThreat = state("p1", { 0: 4, 4: 9 });
    const baseUlt = power({ p1: "mage", p2: "warrior" });
    const pwUltReady: PowerState = {
      ...baseUlt,
      ultimateReady: { ...baseUlt.ultimateReady, p1: true },
      walls: { 4: "bulwark" },
    };
    check(
      "Walls: a ready ultimate's reach never counts as a block (it pierces instead)",
      !getBulwarkBlockedIds(sUltThreat, pwUltReady, 1).includes(4),
      JSON.stringify(getBulwarkBlockedIds(sUltThreat, pwUltReady, 1)),
    );
  }
}

// ---------------------------------------------------------------------------
// Necromancer (Revive rework): Soul Harvest bounty / corpse / Revive /
// thrall possession / Exhume
// ---------------------------------------------------------------------------
{
  // --- Soul Harvest: a qualifying kill pays the BOUNTY and leaves a corpse -
  {
    const s = state("p1", { 0: 6, 4: 8 });
    const pw = power({ p1: "necromancer", p2: "archer" });
    const m = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 0 && mv.to === 8);
    check("Bounty: landing-capture setup is legal", !!m && m.captures.includes(4), JSON.stringify(m));
    if (m) {
      const r = applyPowerMove(s, pw, m, "p1");
      check("Bounty: a kill from an empty bank pays the full SOUL_BOUNTY_CHARGES", r.power.charges.p1 === SOUL_BOUNTY_CHARGES, `p1=${r.power.charges.p1}`);
      check("Bounty: corpse marker set on the death tile", r.power.corpse.p1?.tokenId === 4 && r.power.corpse.p1?.tile === 8, JSON.stringify(r.power.corpse.p1));
      check("Bounty: the grave is dug on the same tile", r.power.grave.p1 === 8, `grave=${r.power.grave.p1}`);
      check("Bounty: the victim banks nothing (death-income is gone)", r.power.charges.p2 === 0, `p2=${r.power.charges.p2}`);
      check("Bounty: the killed token goes home", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    }

    // Clamp at the soul cap, and the freshest kill overwrites the corpse.
    const pwClamp: PowerState = { ...pw, charges: { p1: 2, p2: 0 }, corpse: { p1: { tokenId: 5, tile: 9 }, p2: null }, grave: { p1: 9, p2: null } };
    if (m) {
      const r = applyPowerMove(s, pwClamp, m, "p1");
      check("Bounty: clamped at NECRO_CHARGE_CAP", r.power.charges.p1 === NECRO_CHARGE_CAP, `p1=${r.power.charges.p1}`);
      check("Bounty: a newer kill overwrites the corpse", r.power.corpse.p1?.tokenId === 4 && r.power.corpse.p1?.tile === 8, JSON.stringify(r.power.corpse.p1));
      check("Bounty: a newer kill moves the grave", r.power.grave.p1 === 8, `grave=${r.power.grave.p1}`);
    }

    // Control: a non-necromancer capturer keeps the classic 1-charge economy
    // and never tracks a corpse.
    const pwCtl = power({ p1: "archer", p2: "warrior" });
    const mCtl = getLegalPowerMoves(s, pwCtl, 2).find((mv) => mv.tokenId === 0 && mv.to === 8);
    if (mCtl) {
      const r = applyPowerMove(s, pwCtl, mCtl, "p1");
      check("Bounty: non-necromancer capturer earns the classic single charge", r.power.charges.p1 === 1, `p1=${r.power.charges.p1}`);
      check("Bounty: non-necromancer capturer tracks no corpse", r.power.corpse.p1 === null);
    }
  }

  // --- Soul gem: generic income can never fill the pip above CHARGE_CAP ---
  {
    const pwTwo = power({ p1: "necromancer" }, { p1: CHARGE_CAP });
    check("Soul gem: a zero-flip charge stops at CHARGE_CAP", grantZeroFlipCharge(pwTwo, "p1").charges.p1 === CHARGE_CAP);

    // Non-capturing shield landing at two charges: still two.
    const s = state("p1", { 0: 4 });
    const m = getLegalPowerMoves(s, pwTwo, 3).find((mv) => mv.tokenId === 0 && mv.to === 7);
    check("Soul gem: shield-landing setup is legal", !!m && m.landsOnShield, JSON.stringify(m));
    if (m) {
      const r = applyPowerMove(s, pwTwo, m, "p1");
      check("Soul gem: a shield landing cannot fill the soul pip", r.power.charges.p1 === CHARGE_CAP, `p1=${r.power.charges.p1}`);
    }
    // Below the generic cap the same income still flows normally.
    const pwOne = power({ p1: "necromancer" }, { p1: 1 });
    if (m) {
      const r = applyPowerMove(s, pwOne, m, "p1");
      check("Soul gem: generic income below two still flows", r.power.charges.p1 === 2, `p1=${r.power.charges.p1}`);
    }
  }

  // --- Mirror reclaim: killing YOUR OWN possessed body is not a soul ------
  {
    // p2 (necromancer) possesses p1's token 0; p1 (also necromancer)
    // captures it back. Effective ownership makes the capture legal; real
    // ownership makes it a reclaim: classic charge, no corpse, no bounty.
    const s = state("p1", { 0: 8, 1: 6 });
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "necromancer" }),
      thrall: { p1: null, p2: { tokenId: 0, turnsLeft: 2 } },
    };
    check("Reclaim: possessed own token reads as the enemy's", effectiveOwner(pw, s.tokens.find((t) => t.id === 0)!) === "p2");
    const m = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 1 && mv.to === 8);
    check("Reclaim: capturing your own possessed body is legal", !!m && m.captures.includes(0), JSON.stringify(m));
    if (m) {
      const r = applyPowerMove(s, pw, m, "p1");
      check("Reclaim: pays the classic single charge, not the bounty", r.power.charges.p1 === 1, `p1=${r.power.charges.p1}`);
      check("Reclaim: leaves no corpse", r.power.corpse.p1 === null);
      check("Reclaim: the enemy's thrall entry falls", r.power.thrall.p2 === null);
      check("Reclaim: the body returns to ITS OWNER'S reserve", r.state.tokens.find((t) => t.id === 0)!.position === -1);
    }
  }

  // --- Revive legality: getReviveSpawnTile's full matrix ------------------
  {
    const s = state("p1", { 0: 5 });
    const ready: PowerState = {
      ...power({ p1: "necromancer" }, { p1: REVIVE_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
    };
    check("Revive: castable with corpse + full soul bank", getReviveSpawnTile(s, ready, "p1") === 8);
    check("Revive: refused below the full soul bank", getReviveSpawnTile(s, { ...ready, charges: { p1: 2, p2: 0 } }, "p1") === null);
    check("Revive: refused with no corpse", getReviveSpawnTile(s, { ...ready, corpse: { p1: null, p2: null } }, "p1") === null);
    check(
      "Revive: refused while a thrall is already up",
      getReviveSpawnTile(s, { ...ready, thrall: { p1: { tokenId: 5, turnsLeft: 1 }, p2: null } }, "p1") === null,
    );
    // The denial counterplay: the victim re-entered the corpse token, the
    // soul is reclaimed — the stale marker dead-letters.
    const sDenied = state("p1", { 0: 5, 4: 1 });
    check("Revive: refused once the corpse token re-enters", getReviveSpawnTile(sDenied, ready, "p1") === null);

    // Spawn walk: corpse tile occupied -> nearest free tile BEHIND it.
    const sBehind = state("p1", { 0: 8, 5: 7 });
    check("Revive: spawn walks backward past occupied tiles", getReviveSpawnTile(sBehind, ready, "p1") === 6, `got ${getReviveSpawnTile(sBehind, ready, "p1")}`);
    // Fully packed behind: falls forward. 7 tokens cover 4-10; 11 is free.
    const sPacked = state("p1", { 0: 4, 1: 5, 2: 6, 3: 7, 5: 8, 6: 9, 7: 10 });
    check("Revive: spawn falls forward when everything behind is packed", getReviveSpawnTile(sPacked, ready, "p1") === 11, `got ${getReviveSpawnTile(sPacked, ready, "p1")}`);
  }

  // --- Revive apply: non-turn-ending placement, possession begins ---------
  {
    const s: GameState = { ...state("p1", { 0: 5 }), lastFlip: 3 };
    const pw: PowerState = {
      ...power({ p1: "necromancer" }, { p1: REVIVE_COST }),
      shieldStreak: { p1: 1, p2: 0 },
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
      grave: { p1: 8, p2: null },
    };
    const r = applyRevive(s, pw, "p1");
    check("Revive: the corpse rises where it died", r.state.tokens.find((t) => t.id === 4)!.position === 8);
    check("Revive: leaves the grave open for Corpse Explosion", r.power.grave.p1 === 8, `grave=${r.power.grave.p1}`);
    check("Revive: reports what rose and where", r.raisedTokenId === 4 && r.raisedTo === 8);
    check("Revive: spends the whole soul bank", r.power.charges.p1 === 0, `p1=${r.power.charges.p1}`);
    check("Revive: consumes the corpse", r.power.corpse.p1 === null);
    check("Revive: possession begins at full duration", r.power.thrall.p1?.tokenId === 4 && r.power.thrall.p1?.turnsLeft === THRALL_TURNS);
    check("Revive: does not end the turn", r.state.currentPlayer === "p1");
    check("Revive: the same flip carries on", r.state.lastFlip === 3);
    check("Revive: a placement is not a landing — streak untouched", r.power.shieldStreak.p1 === 1);
  }

  // --- Soul Claim: a funded corpse locks its body out of re-entry --------
  {
    // p2's token 4 is p1's marked corpse with the bank full: p2 cannot
    // re-enter it, but their OTHER reserve tokens enter freely.
    const claimed: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }, { p1: REVIVE_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
    };
    const s = state("p2", { 0: 9 });
    const entries = getLegalPowerMoves(s, claimed, 2);
    check("Soul Claim: the marked body cannot rise on its own", entries.every((mv) => mv.tokenId !== 4));
    check("Soul Claim: unmarked reserve tokens still enter", entries.some((mv) => mv.tokenId === 5 && mv.from === -1));
    // The claim holds even while a thrall occupies the slot (the chain's
    // next corpse stays claimed)...
    const claimedMidChain: PowerState = {
      ...claimed,
      thrall: { p1: { tokenId: 6, turnsLeft: 1 }, p2: null },
    };
    const sMid = state("p2", { 0: 9, 6: 5 });
    check(
      "Soul Claim: holds while a thrall occupies the slot",
      getLegalPowerMoves(sMid, claimedMidChain, 2).every((mv) => mv.tokenId !== 4),
    );
    // ...and lapses the moment the bank can't fund the cast.
    const lapsed: PowerState = { ...claimed, charges: { p1: REVIVE_COST - 1, p2: 0 } };
    check(
      "Soul Claim: lapses when the bank can't fund the cast",
      getLegalPowerMoves(s, lapsed, 2).some((mv) => mv.tokenId === 4 && mv.from === -1),
    );
    // A non-necromancer foe never locks anything.
    const wrongClass: PowerState = { ...claimed, classes: { p1: "warrior", p2: "archer" } };
    check(
      "Soul Claim: only a necromancer's mark locks",
      getLegalPowerMoves(s, wrongClass, 2).some((mv) => mv.tokenId === 4 && mv.from === -1),
    );
  }

  // --- RETIRED 2026-09-17: "the dead feel no magic," the thrall's old Ward
  //     pierce, is gone along with Ward Breaker and the Blessed Blade —
  //     walls are absolute and Ward stopped being pierceable by anything
  //     below an ultimate. A thrall is now blocked by Ward exactly like a
  //     living stone. ------------------------------------------------------
  {
    // p2 is a mage at full cap; their most-advanced FREE token is warded.
    // p1's thrall stands one tile behind it: the thrall's landing is no
    // longer legal, same as it would be for a living stone.
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "mage" }, { p2: CHARGE_CAP }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p1", { 0: 5, 4: 7, 5: 9 });
    check("Ward pierce RETIRED: the target is genuinely warded", isWarded(s, pw, s.tokens.find((t) => t.id === 5)!));
    const pierce = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 9);
    check("Ward pierce RETIRED: the thrall's landing is no longer legal", pierce === undefined, JSON.stringify(pierce));
    const living = getLegalPowerMoves(s, pw, 4).find((mv) => mv.tokenId === 0 && mv.to === 9);
    check("Ward pierce RETIRED: the necromancer's LIVING stones stay blocked too", living === undefined, JSON.stringify(living));
  }

  // --- Corpse Explosion: the 2-soul GRAVE spend (2026-09-16 split) -------
  {
    // Grave (and the body it came from) on tile 8; enemy 5 stands ON the
    // grave, 6 one tile out, 7 far.
    const ready: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }, { p1: CORPSE_EXPLOSION_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
      grave: { p1: 8, p2: null },
    };
    const s = state("p1", { 5: 8, 6: 9, 7: 11 });
    check("Explosion: strikes the unprotected enemy standing on the grave", getCorpseExplosionTargets(s, ready, "p1").includes(5));
    check(
      "Explosion: reaches only CORPSE_EXPLOSION_RADIUS from the grave",
      !getCorpseExplosionTargets(s, ready, "p1").includes(6) && !getCorpseExplosionTargets(s, ready, "p1").includes(7),
    );
    check("Explosion: refused without a grave", getCorpseExplosionTargets(s, { ...ready, grave: { p1: null, p2: null } }, "p1").length === 0);
    check(
      "Explosion: refused below its cost",
      getCorpseExplosionTargets(s, { ...ready, charges: { p1: CORPSE_EXPLOSION_COST - 1, p2: 0 } }, "p1").length === 0,
    );
    // The grave outlives the body: Revive's consumption of the corpse, and
    // the victim re-entering its token, both leave the mine armed.
    const raised: PowerState = { ...ready, corpse: { p1: null, p2: null } };
    check("Explosion: castable after Revive took the body", getCorpseExplosionTargets(s, raised, "p1").includes(5));
    const sDenied = state("p1", { 4: 1, 5: 8 });
    check("Explosion: still castable once the corpse token re-enters", getCorpseExplosionTargets(sDenied, ready, "p1").includes(5));
    check("Explosion: empty pool when nothing stands on the grave", getCorpseExplosionTargets(state("p1", { 5: 9 }), ready, "p1").length === 0);
    // Unlike Revive, an ACTIVE thrall doesn't block the blast (different slot).
    const midThrall: PowerState = { ...ready, thrall: { p1: { tokenId: 7, turnsLeft: 1 }, p2: null } };
    check("Explosion: castable while a thrall serves", getCorpseExplosionTargets(state("p1", { 5: 8, 7: 5 }), midThrall, "p1").includes(5));
    const ownThrall: PowerState = { ...ready, thrall: { p1: { tokenId: 7, turnsLeft: 1 }, p2: null } };
    check("Explosion: the caster's own thrall is family, never a victim", !getCorpseExplosionTargets(state("p1", { 7: 8 }), ownThrall, "p1").includes(7));
    // Protections all hold: shield tile 7, Ward, Bulwark.
    const graveAt7: PowerState = { ...ready, corpse: { p1: { tokenId: 4, tile: 7 }, p2: null }, grave: { p1: 7, p2: null } };
    check("Explosion: a shield tile shelters its occupant", !getCorpseExplosionTargets(state("p1", { 5: 7 }), graveAt7, "p1").includes(5));
    const pwWard: PowerState = {
      ...power({ p1: "necromancer", p2: "mage" }, { p1: CORPSE_EXPLOSION_COST, p2: CHARGE_CAP }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
      grave: { p1: 8, p2: null },
    };
    check("Explosion: Ward turns the blast", !getCorpseExplosionTargets(state("p1", { 5: 8 }), pwWard, "p1").includes(5));
    const pwBul: PowerState = { ...ready, walls: { 5: "bulwark" } };
    check("Explosion: a wall turns the blast", !getCorpseExplosionTargets(state("p1", { 5: 8 }), pwBul, "p1").includes(5));

    // Apply: lethal (2026-09-13) — the victim goes home, flat cost, desecration.
    const sApply = state("p1", { 5: 8, 6: 9 }); // 5 stands on the grave; 6 one tile out is safe at radius 0
    const rA = applyCorpseExplosion(sApply, ready, "p1");
    check("Explosion: the stone on the grave is sent home", rA.state.tokens.find((t) => t.id === 5)!.position === -1);
    check("Explosion: a stone outside the radius is untouched", rA.state.tokens.find((t) => t.id === 6)!.position === 9 && rA.sentHomeIds.length === 1);
    check("Explosion: the kill is reported", rA.sentHomeIds.includes(5) && rA.struckTokenIds.includes(5));
    check("Explosion: spends its flat cost", rA.power.charges.p1 === 0, `p1=${rA.power.charges.p1}`);
    check("Explosion: consumes the grave", rA.power.grave.p1 === null);
    check("Explosion: desecration — a blown grave raises nothing", rA.power.corpse.p1 === null);
    check("Explosion: ends the turn", rA.state.currentPlayer === "p2");
    check("Explosion: reports the epicenter", rA.tile === 8);
    check("Explosion: desecration — no corpse or grave minted by the blast", rA.power.corpse.p1 === null && rA.power.grave.p1 === null);
    check("Explosion: blast kills pay no bounty", rA.power.charges.p1 === 0, `p1=${rA.power.charges.p1}`);
    // After Revive emptied the corpse, the grave-only blast still works and
    // still leaves nothing behind.
    const rR = applyCorpseExplosion(sApply, raised, "p1");
    check("Explosion: grave-only blast kills the stone on it", rR.state.tokens.find((t) => t.id === 5)!.position === -1 && rR.power.grave.p1 === null);
    check("Explosion: the blast breaks a live shield streak", applyCorpseExplosion(sApply, { ...ready, shieldStreak: { p1: 2, p2: 0 } }, "p1").power.shieldStreak.p1 === 0);
    // Mirror: the ENEMY's thrall (my own body) blasted home dies for real.
    const mirrorPw: PowerState = {
      ...power({ p1: "necromancer", p2: "necromancer" }, { p1: CORPSE_EXPLOSION_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
      grave: { p1: 8, p2: null },
      thrall: { p1: null, p2: { tokenId: 0, turnsLeft: 2 } },
    };
    const sMirror = state("p1", { 0: 8 }); // my body 0, possessed by p2, stands on my grave
    const rM = applyCorpseExplosion(sMirror, mirrorPw, "p1");
    check("Explosion: an enemy thrall blasted home dies for real", rM.state.tokens.find((t) => t.id === 0)!.position === -1 && rM.power.thrall.p2 === null);
  }

  // --- Thrall movement: the necromancer's fifth stone, chained to the row -
  {
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p1", { 0: 4, 4: 8, 5: 10 });
    const moves = getLegalPowerMoves(s, pw, 2);
    const tm = moves.find((mv) => mv.tokenId === 4);
    check("Thrall: moves on the necromancer's flip", !!tm && tm.from === 8 && tm.to === 10, JSON.stringify(tm));
    check("Thrall: captures like any stone", !!tm && tm.captures.includes(5), JSON.stringify(tm));
    if (tm) {
      const r = applyPowerMove(s, pw, tm, "p1");
      check("Thrall: its kill pays the full bounty (chain necromancy)", r.power.charges.p1 === Math.min(NECRO_CHARGE_CAP, pw.charges.p1 + SOUL_BOUNTY_CHARGES), `p1=${r.power.charges.p1}`);
      check("Thrall: its kill leaves the next corpse", r.power.corpse.p1?.tokenId === 5 && r.power.corpse.p1?.tile === 10, JSON.stringify(r.power.corpse.p1));
      check("Thrall: moving doesn't cost duration", r.power.thrall.p1?.turnsLeft === 2);
    }
    // Row-chained: any move past tile 11 simply doesn't exist for it.
    check("Thrall: cannot pass tile 11", getLegalPowerMoves(s, pw, 4).every((mv) => mv.tokenId !== 4));
    const sEdge = state("p1", { 0: 4, 4: 10 });
    check("Thrall: tile 11 itself is reachable", getLegalPowerMoves(sEdge, pw, 1).some((mv) => mv.tokenId === 4 && mv.to === 11));
    check("Thrall: never offered an escape", getLegalPowerMoves(sEdge, pw, 4).every((mv) => mv.tokenId !== 4));

    // A thrall shield landing is a real landing: extra turn, streak link,
    // generic charge (still soul-gem-capped at two).
    const sShield = state("p1", { 0: 4, 4: 5 });
    const sm = getLegalPowerMoves(sShield, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 7);
    check("Thrall: shield landing offered", !!sm && sm.landsOnShield, JSON.stringify(sm));
    if (sm) {
      const r = applyPowerMove(sShield, pw, sm, "p1");
      check("Thrall: shield landing grants the extra turn", r.state.extraTurn && r.state.currentPlayer === "p1");
      check("Thrall: shield landing advances the streak", r.power.shieldStreak.p1 === 1);
      check("Thrall: shield landing banks a generic charge", r.power.charges.p1 === 1, `p1=${r.power.charges.p1}`);
    }
  }

  // --- The victim's side: can't command it, CAN cut it down ---------------
  {
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p2", { 0: 4, 4: 8, 5: 6, 6: -1 });
    const moves = getLegalPowerMoves(s, pw, 2);
    check("Victim: cannot move their possessed stone", moves.every((mv) => mv.tokenId !== 4));
    check("Victim: other reserve tokens still enter normally", moves.some((mv) => mv.tokenId === 6 && mv.from === -1));
    const mercy = moves.find((mv) => mv.tokenId === 5 && mv.to === 8);
    check("Victim: mercy kill on their own possessed stone is legal", !!mercy && mercy.captures.includes(4), JSON.stringify(mercy));
    if (mercy) {
      const r = applyPowerMove(s, pw, mercy, "p2");
      check("Victim: mercy kill earns the standard capture charge", r.power.charges.p2 === 1, `p2=${r.power.charges.p2}`);
      check("Victim: the possession entry falls with the thrall", r.power.thrall.p1 === null);
      check("Victim: the body comes home to their reserve", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    }
  }

  // --- Protections vs a thrall: Ward and Bulwark refuse, Push crumbles ----
  {
    // Ward: the victim mage's possessed token is never warded, and doesn't
    // consume their most-advanced slot — their best FREE token wards.
    const pwWard: PowerState = {
      ...power({ p1: "necromancer", p2: "mage" }, { p2: CHARGE_CAP }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const sWard = state("p1", { 4: 9, 5: 6 });
    check("Ward: never guards a possessed token", !isWarded(sWard, pwWard, sWard.tokens.find((t) => t.id === 4)!));
    check("Ward: falls to the best FREE token instead", isWarded(sWard, pwWard, sWard.tokens.find((t) => t.id === 5)!));

    // Bulwark: the victim warrior can't shield the enemy's weapon.
    const pwBul: PowerState = {
      ...power({ p1: "necromancer", p2: "warrior" }, { p2: 1 }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const sBul = state("p2", { 4: 9, 5: 6 });
    const bulTargets = getBulwarkTargets(sBul, pwBul, "p2");
    check("Bulwark: a possessed token is not a valid target", !bulTargets.includes(4) && bulTargets.includes(5));

    // Push: the victim archer CAN push their own possessed stone — and a
    // knockback below tile 4 crumbles it (the row is holy ground; the
    // victim's private lane doubly so).
    const pwPush: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }, { p2: 1 }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const sPush = state("p2", { 4: 4, 0: 9 });
    check("Push: the victim's own possessed stone is a target", getPushTargets(sPush, pwPush, "p2").includes(4));
    const rPush = applyPush(sPush, pwPush, 4, "p2");
    check("Push: a below-row knockback crumbles the thrall", rPush.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Push: the crumble clears the possession", rPush.power.thrall.p1 === null);
    check("Push: the crumble is a send-home — the pusher's refund applies", rPush.power.charges.p2 === 1, `p2=${rPush.power.charges.p2}`);

    // Snipe: a thrall one tile past the landing is a legitimate victim.
    const pwSnipe: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const sSnipe = state("p2", { 5: 6, 4: 9 });
    const snipeMove = getLegalPowerMoves(sSnipe, pwSnipe, 2).find((mv) => mv.tokenId === 5 && mv.to === 8);
    check("Snipe: fires on the victim's own possessed stone", !!snipeMove && snipeMove.bonusCaptures.includes(4), JSON.stringify(snipeMove));
    if (snipeMove) {
      const r = applyPowerMove(sSnipe, pwSnipe, snipeMove, "p2");
      check("Snipe: the sniped thrall's possession falls", r.power.thrall.p1 === null);
    }
  }

  // --- Thrall lifecycle: the tick, the crumble, the fairness terminus -----
  {
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p1", { 4: 8 });
    const t1 = tickThrallForNewTurn(s, pw);
    check("Tick: first tick spends a turn, thrall lives on", t1.power.thrall.p1?.turnsLeft === 1 && t1.expiredTokenId === null);
    check("Tick: a living thrall stays on its tile", t1.state.tokens.find((t) => t.id === 4)!.position === 8);
    const t2 = tickThrallForNewTurn(t1.state, t1.power);
    check("Tick: final tick crumbles the thrall", t2.expiredTokenId === 4 && t2.power.thrall.p1 === null);
    check("Tick: the crumble ends at the victim's reserve (fairness invariant)", t2.state.tokens.find((t) => t.id === 4)!.position === -1);

    // The OPPONENT's turns never tick the necromancer's thrall.
    const sFoe = state("p2", { 4: 8 });
    const tFoe = tickThrallForNewTurn(sFoe, pw);
    check("Tick: only the possessor's own turns burn duration", tFoe.power.thrall.p1?.turnsLeft === 2);
    const bare = power({ p1: "necromancer" });
    const tBare = tickThrallForNewTurn(sFoe, bare);
    check("Tick: no-op without a thrall returns the same references", tBare.power === bare && tBare.state === sFoe);
  }

  // --- Win counting stays real-owner: a possessed stone blocks its owner --
  {
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p2", { 4: 8, 5: PATH_LENGTH_PER_PLAYER, 6: PATH_LENGTH_PER_PLAYER, 7: 13 });
    const esc = getLegalPowerMoves(s, pw, 1).find((mv) => mv.tokenId === 7 && mv.to === PATH_LENGTH_PER_PLAYER);
    check("Win: escape still offered while a stone is possessed", !!esc, JSON.stringify(esc));
    check("Win: but it cannot win — the possessed stone counts as unescaped", !!esc && esc.causesWin === false);
  }

  // --- Exhume: target pool and apply ------------------------------------
  {
    const s = state("p1", { 1: PATH_LENGTH_PER_PLAYER, 4: PATH_LENGTH_PER_PLAYER, 5: 8 });
    const pw: PowerState = { ...power({ p1: "necromancer", p2: "warrior" }), ultimateReady: { p1: true, p2: false } };
    const targets = getExhumeTargets(s, pw, "p1");
    check("Exhume: escaped enemy is a target", targets.includes(4), JSON.stringify(targets));
    check("Exhume: on-board enemy is not", !targets.includes(5));
    check("Exhume: own escaped token is not", !targets.includes(1));
    check("Exhume: empty pool when nothing has escaped", getExhumeTargets(state("p1", { 4: 8 }), pw, "p1").length === 0);

    const r = applyExhume(s, pw, 4, "p1");
    check("Exhume: token dragged back to the return tile", r.state.tokens.find((t) => t.id === 4)!.position === EXHUME_RETURN_POSITION);
    check("Exhume: reports the landing tile", r.returnedTo === EXHUME_RETURN_POSITION);
    check("Exhume: spends ultimateReady", r.power.ultimateReady.p1 === false);
    check("Exhume: ends the turn", r.state.currentPlayer === "p2");

    // Occupancy walk: return tile held by the CASTER (contested = blocks)
    // and the next by the victim's own token — lands two tiles back.
    const s2 = state("p1", { 0: EXHUME_RETURN_POSITION, 4: PATH_LENGTH_PER_PLAYER, 5: EXHUME_RETURN_POSITION - 1 });
    const r2 = applyExhume(s2, pw, 4, "p1");
    check("Exhume: walks back past occupied tiles", r2.returnedTo === EXHUME_RETURN_POSITION - 2, `landed ${r2.returnedTo}`);

    // A Bulwark cast before the token escaped must not ride back with it.
    const pwB: PowerState = { ...pw, walls: { 4: "bulwark" } };
    const r3 = applyExhume(s, pwB, 4, "p1");
    check(
      "Exhume: strips a stale wall on the way back",
      r3.power.walls[4] === undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleric: Bless (raises a wall) / Vigil (banks upkeep grace) target pools
// and casts — replaces the old Bless/Heal pair under the wall rework.
// ---------------------------------------------------------------------------
{
  // Bless pool: own on-board stones with no live wall, full bank only.
  const s = state("p1", { 0: 5, 1: 2, 4: 8 });
  const pwBroke = power({ p1: "cleric" }, { p1: BLESS_COST - 1 });
  check("Bless: empty pool below the full bank", getBlessTargets(s, pwBroke, "p1").length === 0);

  const pw = power({ p1: "cleric" }, { p1: BLESS_COST });
  const pool = getBlessTargets(s, pw, "p1");
  check("Bless: own on-board stones eligible (contested and private lane alike)", pool.includes(0) && pool.includes(1));
  check("Bless: reserve and enemy stones excluded", !pool.includes(2) && !pool.includes(4));

  const pwWalled: PowerState = { ...pw, walls: { 0: "blessing" } };
  const pool2 = getBlessTargets(s, pwWalled, "p1");
  check("Bless: an already-walled stone is excluded from re-targeting", !pool2.includes(0));

  // A stone possessed AGAINST the cleric is not theirs to bless.
  const pwPoss: PowerState = {
    ...power({ p1: "cleric", p2: "necromancer" }, { p1: BLESS_COST }),
    thrall: { p1: null, p2: { tokenId: 0, turnsLeft: 2 } },
  };
  check("Bless: a stone possessed against the cleric is excluded", !getBlessTargets(s, pwPoss, "p1").includes(0));

  // The cast: spends the mana, raises a "blessing" wall, KEEPS the turn
  // (Revive's contract — no streak interaction, no board movement).
  const pwStreak: PowerState = { ...pw, shieldStreak: { p1: 2, p2: 0 } };
  const r = applyBless(s, pwStreak, 0, "p1");
  check("Bless: spends BLESS_COST", r.power.charges.p1 === 0);
  check("Bless: raises a 'blessing' wall on the target", r.power.walls[0] === "blessing");
  check("Bless: keeps the turn (Revive's contract)", r.state.currentPlayer === "p1");
  check("Bless: leaves the shield streak alone", r.power.shieldStreak.p1 === 2);
  check("Bless: moves no tokens", r.state.tokens.find((t) => t.id === 0)!.position === 5);

  // Vigil (replaces Heal): needs at least one live wall, VIGIL_COST
  // affordability baked in; ENDS the turn (unlike Bless — the tempo price
  // VIGIL_COST's doc records) and grants a turn of wallGrace, not a target.
  check("Vigil: not castable with zero walls up, even with mana", !canCastVigil(s, power({ p1: "cleric" }, { p1: VIGIL_COST }), "p1"));
  const pwV: PowerState = { ...power({ p1: "cleric" }, { p1: VIGIL_COST }), walls: { 0: "blessing" } };
  check("Vigil: castable once a wall is up and it's affordable", canCastVigil(s, pwV, "p1"));
  const pwVBroke: PowerState = { ...pwV, charges: { p1: 0, p2: 0 } };
  check("Vigil: not castable unaffordable, even with a wall up", !canCastVigil(s, pwVBroke, "p1"));

  const rv = applyVigil(s, pwV, "p1");
  check("Vigil: spends VIGIL_COST", rv.power.charges.p1 === 0);
  check("Vigil: banks one turn of wallGrace", rv.power.wallGrace.p1 === 1);
  check("Vigil: the wall itself is untouched by the cast", rv.power.walls[0] === "blessing");
  check("Vigil: ends the turn (the tempo price Bless doesn't pay)", rv.state.currentPlayer === "p2");
}

// ---------------------------------------------------------------------------
// Cleric: a blessed (walled) stone is uncapturable below an ultimate
// (RETIRED 2026-09-17: the wound split — a blessed victim surviving a
// landing/Snipe/sweep/Push/Charged Shot/blast hit as "wounded," with the
// blessed blade piercing Ward and Larceny/the soul bounty skipping a wound
// — is gone entirely. A Blessing is a WALL now: isProtected excludes it
// from every one of those pools outright, the same absolute immunity
// section 14 already established for Bulwark. This section is the
// Cleric-flavored confirmation, not a re-litigation of section 14's
// general coverage.)
// ---------------------------------------------------------------------------
{
  // Landing capture: no longer even a legal move.
  const s = state("p2", { 0: 8, 4: 6 });
  const pw: PowerState = { ...power({ p1: "cleric", p2: "archer" }), walls: { 0: "blessing" } };
  const moves = getLegalPowerMoves(s, pw, 2);
  const m = moves.find((mv) => mv.tokenId === 4 && mv.to === 8);
  check("Walls: a blessed enemy is no longer a legal landing-capture target at all", m === undefined, JSON.stringify(moves));

  // Snipe: excluded from the bonus-capture pool the same way.
  const sSnipe = state("p2", { 0: 9, 4: 6 });
  const mSnipe = getLegalPowerMoves(sSnipe, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  check("Walls: a blessed stone is never a Snipe bonus capture", !mSnipe.bonusCaptures.includes(0));

  // Charge sweep: excluded from the sweep pool too.
  const sSweep = state("p2", { 0: 5, 4: 4 });
  const pwSweep: PowerState = { ...power({ p1: "cleric", p2: "warrior" }, { p2: 1 }), walls: { 0: "blessing" } };
  const mSweep = getLegalPowerMoves(sSweep, pwSweep, 2).find((mv) => mv.tokenId === 4 && mv.to === 6)!;
  check("Walls: a blessed enemy is never swept by Charge", !mSweep.chargeSweepCaptures.includes(0));

  // Necromancer landing on a blessed stone: no move at all, so trivially no
  // bounty and no corpse — the old "wound denies income" test collapses to
  // this single legality check now.
  const pwNecro: PowerState = { ...power({ p1: "cleric", p2: "necromancer" }), walls: { 0: "blessing" } };
  const mNecro = getLegalPowerMoves(s, pwNecro, 2).find((mv) => mv.tokenId === 4 && mv.to === 8);
  check("Walls: a necromancer can't even attempt the landing — no bounty, no corpse, ever", mNecro === undefined);

  // Push / Charged Shot: excluded from their target pools outright — no
  // "soft shove still lands" carve-out left (see section 14's own coverage
  // for the general case; this just confirms Blessing shares it).
  const sPush = state("p1", { 0: 6, 4: 9 });
  const pwPush: PowerState = { ...power({ p1: "archer", p2: "cleric" }, { p1: 1 }), walls: { 4: "blessing" } };
  check("Walls: a blessed stone is not a legal Push target at all", !getPushTargets(sPush, pwPush, "p1").includes(4));
  const pwShot: PowerState = { ...power({ p1: "archer", p2: "cleric" }, { p1: CHARGE_CAP }), walls: { 4: "blessing" } };
  check("Walls: a blessed stone is not a legal Charged Shot target at all", !getChargedShotTargets(sPush, pwShot, "p1").includes(4));

  // Corpse Explosion: excluded from the blast radius's victim pool.
  const pwBlast: PowerState = {
    ...power({ p1: "necromancer", p2: "cleric" }, { p1: CORPSE_EXPLOSION_COST }),
    corpse: { p1: { tokenId: 6, tile: 6 }, p2: null },
    grave: { p1: 6, p2: null },
    walls: { 4: "blessing" },
  };
  check("Walls: a blessed stone is excluded from Corpse Explosion's blast pool", !getCorpseExplosionTargets(state("p1", { 4: 6 }), pwBlast, "p1").includes(4));

  // Larceny: with nothing to capture, the Rogue's drain never fires either
  // — the old "a wound pays no Larceny" case collapses to "no move exists."
  const sLarc = state("p1", { 0: 4, 4: 6 });
  const pwLarc: PowerState = { ...power({ p1: "rogue", p2: "cleric" }, { p2: 2 }), walls: { 4: "blessing" } };
  const mLarc = getLegalPowerMoves(sLarc, pwLarc, 2).find((mv) => mv.tokenId === 0 && mv.to === 6);
  check("Walls: Larceny's own target is unreachable too — no move, no drain", mLarc === undefined);
}

// ---------------------------------------------------------------------------
// Cleric: ultimates still pierce the wall (Rain of Arrows / Blink Strike /
// Warpath) — unchanged in spirit from the old "ultimates pierce the
// blessing," renamed for the wall vocabulary.
// ---------------------------------------------------------------------------
{
  // Rain of Arrows (banked cast) kills a blessed stone for real.
  const s = state("p2", { 0: 9, 4: 6 });
  const pw: PowerState = {
    ...power({ p1: "cleric", p2: "archer" }),
    ultimateReady: { p1: false, p2: true },
    walls: { 0: "blessing" },
  };
  check("Pierce: setup — the blessed stone is in the pool", getRainOfArrowsTargets(s, pw, "p2").includes(0));
  const r = applyRainOfArrows(s, pw, 0, "p2");
  check("Pierce: Rain of Arrows kills a blessed stone outright", r.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Pierce: the dead stone's wall clears", r.power.walls[0] === undefined);
  check("Pierce: the ultimate is spent", r.power.ultimateReady.p2 === false);

  // Blink Strike: same pierce.
  const s2 = state("p2", { 0: 9, 4: 6 });
  const pw2: PowerState = {
    ...power({ p1: "cleric", p2: "mage" }),
    ultimateReady: { p1: false, p2: true },
    walls: { 0: "blessing" },
  };
  check("Pierce: Blink Strike lists the blessed stone", getBlinkStrikeTargets(s2, pw2, "p2").includes(0));
  const r2 = applyBlinkStrike(s2, pw2, 0, "p2");
  check("Pierce: Blink Strike kills through the blessing", r2.state.tokens.find((t) => t.id === 0)!.position === -1 && r2.power.walls[0] === undefined);

  // Warpath: primary AND swept blessed stones both die.
  const s3 = state("p2", { 0: 9, 1: 7 + 1, 4: 5, 5: 11 });
  const pw3: PowerState = {
    ...power({ p1: "cleric", p2: "warrior" }),
    ultimateReady: { p1: false, p2: true },
    walls: { 0: "blessing", 1: "blessing" },
  };
  const r3 = applyWarpath(s3, pw3, 0, "p2");
  check("Pierce: Warpath primary blessed target dies", r3.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Pierce: Warpath swept blessed target dies too", r3.state.tokens.find((t) => t.id === 1)!.position === -1 && r3.sweptTokenIds.includes(1));
  check("Pierce: both walls clear", r3.power.walls[0] === undefined && r3.power.walls[1] === undefined);
}

// ---------------------------------------------------------------------------
// Cleric: Sanctified Ground (a shield landing banks wallGrace) + Benediction
// (walls the whole army with a grace turn) — reworked 2026-09-17: the old
// "mend a wounded stone back to blessed" version retired with the wound
// split; both now grant the SAME wallGrace field Vigil spends from.
// ---------------------------------------------------------------------------
{
  // Cleric lands on the shield tile: banks a turn of wallGrace.
  const s = state("p1", { 0: 6, 1: 4, 2: 5 });
  const pw: PowerState = { ...power({ p1: "cleric" }), walls: { 1: "blessing", 2: "blessing" } };
  const m = getLegalPowerMoves(s, pw, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Sanctified Ground: setup — shield landing", m.landsOnShield);
  const r = applyPowerMove(s, pw, m, "p1");
  check("Sanctified Ground: a shield landing banks one turn of wallGrace", r.power.wallGrace.p1 === 1);
  check("Sanctified Ground: the walls themselves are untouched by the landing", r.power.walls[1] === "blessing" && r.power.walls[2] === "blessing");
  check("Sanctified Ground: shield landing still grants charge + extra turn", r.power.charges.p1 === 1 && r.state.currentPlayer === "p1");

  // A NON-cleric shield landing grants no grace at all.
  const pwN: PowerState = { ...power({ p1: "archer", p2: "cleric" }) };
  const sN = state("p1", { 0: 6, 5: 9 });
  const mN = getLegalPowerMoves(sN, pwN, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rN = applyPowerMove(sN, pwN, mN, "p1");
  check("Sanctified Ground: non-cleric landings grant no grace", rN.power.wallGrace.p1 === 0);

  // Benediction: pool = every own on-board stone not already walled
  // (canHoldWall too); the cast walls them all, spends the flag, ends the
  // turn, leaves the shield streak alone, and banks a turn of grace.
  const sB = state("p1", { 0: 5, 1: 2, 2: 8 });
  const pwB: PowerState = {
    ...power({ p1: "cleric" }),
    ultimateReady: { p1: true, p2: false },
    shieldStreak: { p1: 2, p2: 0 },
    walls: { 0: "blessing" },
  };
  const poolB = getBenedictionTargets(sB, pwB, "p1");
  check("Benediction: pool is the unwalled on-board army", poolB.includes(1) && poolB.includes(2) && !poolB.includes(0) && !poolB.includes(3));
  const rB = applyBenediction(sB, pwB, "p1");
  check("Benediction: walls the army", rB.power.walls[1] === "blessing" && rB.power.walls[2] === "blessing" && rB.power.walls[0] === "blessing");
  check("Benediction: spends the flag, ends the turn", rB.power.ultimateReady.p1 === false && rB.state.currentPlayer === "p2");
  check("Benediction: leaves the shield streak alone (ultimate rule)", rB.power.shieldStreak.p1 === 2);
  check("Benediction: reports who it walled", rB.blessedTokenIds.length === 2);
  check("Benediction: banks a turn of wallGrace for the whole army", rB.power.wallGrace.p1 === 1);

  // All-walled army: empty pool = not castable.
  const pwAll: PowerState = { ...pwB, walls: { 0: "blessing", 1: "blessing", 2: "blessing" } };
  const sAll = state("p1", { 0: 5, 1: 2, 2: 8 });
  check("Benediction: empty pool when nothing would change", getBenedictionTargets(sAll, pwAll, "p1").length === 0);
}

// ---------------------------------------------------------------------------
// Cleric: BLESSING_CAP — the light shelters a bounded few at a time (the
// bleed is the REAL cap now; BLESSING_CAP is the pool-side backstop)
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 0: 5, 1: 6, 2: 8, 3: 2 });
  const atCap: Record<number, "bulwark" | "blessing"> = {};
  for (let id = 0; id < BLESSING_CAP; id++) atCap[id] = "blessing";
  const pwAtCap: PowerState = { ...power({ p1: "cleric" }, { p1: BLESS_COST }), walls: { ...atCap } };
  check("Cap: Bless pool empties at BLESSING_CAP live blessings", getBlessTargets(s, pwAtCap, "p1").length === 0);
  const pwOneDown: PowerState = { ...pwAtCap, walls: Object.fromEntries(Object.entries(atCap).filter(([id]) => Number(id) !== 0)) };
  check("Cap: dropping a wall frees a slot", getBlessTargets(s, pwOneDown, "p1").length > 0);
  // Benediction, the ultimate, exceeds the cap freely — its pool is every
  // on-board stone not already walled.
  const pwUlt: PowerState = { ...pwAtCap, ultimateReady: { p1: true, p2: false } };
  check("Cap: Benediction ignores the cap (ultimate)", getBenedictionTargets(s, pwUlt, "p1").length === 4 - BLESSING_CAP);
  // A cleric MIRROR: the foe's blessings never count against mine.
  const sM = state("p1", { 0: 5, 5: 9, 6: 10, 7: 8 });
  const foeCap: Record<number, "bulwark" | "blessing"> = {};
  for (let id = 4; id < 4 + BLESSING_CAP; id++) foeCap[id] = "blessing";
  const pwM: PowerState = { ...power({ p1: "cleric", p2: "cleric" }, { p1: BLESS_COST }), walls: foeCap };
  check("Cap: mirror — only my own blessings count", getBlessTargets(sM, pwM, "p1").includes(0));
}

// ---------------------------------------------------------------------------
// Cleric: a wall clears on escape — Exhume drags back an unprotected stone
// (RETIRED 2026-09-17: "blessing rides through escape and Exhume" — the
// new escape-clears-wall fix (resolveTurn's escape branch) means a wall
// never survives its own owner reaching home in the first place, so by the
// time Exhume drags the token back it has nothing left to strip)
// ---------------------------------------------------------------------------
{
  // A blessed stone that escapes has its wall cleared on the way home —
  // same reserve-trip-shaped hygiene every other send-home path gets.
  const sEscape = state("p1", { 0: 13 });
  const pwEscape: PowerState = { ...power({ p1: "cleric" }), walls: { 0: "blessing" } };
  const mEscape = getLegalPowerMoves(sEscape, pwEscape, 1).find((mv) => mv.tokenId === 0 && mv.to === PATH_LENGTH_PER_PLAYER)!;
  const rEscape = applyPowerMove(sEscape, pwEscape, mEscape, "p1");
  check("Walls: an escaping stone's own wall clears on the way home", rEscape.power.walls[0] === undefined);

  // Exhume then drags that (now unwalled) stone back — no free protection
  // rides along with it.
  const s = state("p2", { 0: PATH_LENGTH_PER_PLAYER });
  const pw: PowerState = {
    ...power({ p1: "cleric", p2: "necromancer" }),
    ultimateReady: { p1: false, p2: true },
  };
  const r = applyExhume(s, pw, 0, "p2");
  check("Exhume: an escaped-and-dragged-back stone has no wall to strip", r.power.walls[0] === undefined);
  check("Exhume: dragged to the return tile", r.state.tokens.find((t) => t.id === 0)!.position === EXHUME_RETURN_POSITION);
}

// ---------------------------------------------------------------------------
// Rogue: Larceny — every REAL kill also drains the foe's bank; a target
// that's protected (walled, per the Cleric section above) is unreachable
// in the first place, so there's no "wound" case left to pay nothing —
// and only a Rogue's own captures trigger the drain at all
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "rogue", p2: "archer" }, { p2: 2 });
  const moves = getLegalPowerMoves(s, pw, 2);
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 6)!;
  check("Larceny: sanity — this move really captures", m.captures.includes(4));
  const r = applyPowerMove(s, pw, m, "p1");
  check(
    `Larceny: a real kill drains ROGUE_STEAL_ON_CAPTURE (${ROGUE_STEAL_ON_CAPTURE}) from the foe`,
    r.power.charges.p2 === 2 - ROGUE_STEAL_ON_CAPTURE,
    `got ${r.power.charges.p2}`,
  );

  // A non-Rogue capturing the exact same shape must not drain the foe.
  const pwArcher = power({ p1: "archer", p2: "archer" }, { p2: 2 });
  const movesArcher = getLegalPowerMoves(s, pwArcher, 2);
  const mArcher = movesArcher.find((mv) => mv.tokenId === 0 && mv.to === 6)!;
  const rArcher = applyPowerMove(s, pwArcher, mArcher, "p1");
  check("Larceny: does not fire for a non-Rogue mover", rArcher.power.charges.p2 === 2, `got ${rArcher.power.charges.p2}`);

  // Floors at 0 — draining a foe already at 0 charges must not go negative.
  const pwZero = power({ p1: "rogue", p2: "archer" }, { p2: 0 });
  const movesZero = getLegalPowerMoves(s, pwZero, 2);
  const mZero = movesZero.find((mv) => mv.tokenId === 0 && mv.to === 6)!;
  const rZero = applyPowerMove(s, pwZero, mZero, "p1");
  check("Larceny: floors at 0, never goes negative", rZero.power.charges.p2 === 0);
}

// ---------------------------------------------------------------------------
// Rogue: Pickpocket — drains a target's bank WITHOUT capturing it; since
// nothing is actually striking the stone, no protection (shield tile, Ward,
// Bulwark) applies to its target pool at all
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "rogue", p2: "mage" }, { p1: 1, p2: 2 });
  const targets = getPickpocketTargets(s, pw, "p1");
  check("Pickpocket: RETIRED — the oracle offers no targets even when everything lines up", targets.length === 0 && PICKPOCKET_RETIRED, JSON.stringify(targets));

  const pwBroke = power({ p1: "rogue", p2: "mage" }, { p1: 0, p2: 2 });
  check("Pickpocket: no targets when the mover can't afford it", getPickpocketTargets(s, pwBroke, "p1").length === 0);

  // The foe needs something worth stealing — a 0-charge foe is excluded
  // outright (no legal-but-worthless target, PUSH_WARD_DISTANCE=0's own
  // precedent for this discipline).
  const pwFoeBroke = power({ p1: "rogue", p2: "mage" }, { p1: 1, p2: 0 });
  check("Pickpocket: no targets when the foe has nothing to steal", getPickpocketTargets(s, pwFoeBroke, "p1").length === 0);

  const sPrivate = state("p1", { 0: 4, 4: 1 }); // p2's own private lane
  check(
    "Pickpocket: an enemy outside the contested zone is never a legal target",
    getPickpocketTargets(sPrivate, pw, "p1").length === 0,
  );

  const sShield = state("p1", { 0: 4, 4: 7 }); // tile 7 is a shield tile
  check("Pickpocket: retired — still nothing offered on a shield tile", getPickpocketTargets(sShield, pw, "p1").length === 0);

  const pwWarded = power({ p1: "rogue", p2: "mage" }, { p1: 1, p2: CHARGE_CAP });
  check(
    "Pickpocket: retired — nothing offered against a Warded enemy",
    getPickpocketTargets(s, pwWarded, "p1").length === 0,
  );

  const pwWalled: PowerState = {
    ...power({ p1: "rogue", p2: "warrior" }, { p1: 1, p2: 2 }),
    walls: { 4: "bulwark" },
  };
  check(
    "Pickpocket: retired — nothing offered against a walled enemy",
    getPickpocketTargets(s, pwWalled, "p1").length === 0,
  );

  const r = applyPickpocket(pw, "p1");
  check(`Pickpocket: mover spends PICKPOCKET_COST (${PICKPOCKET_COST})`, r.charges.p1 === 1 - PICKPOCKET_COST, `got ${r.charges.p1}`);
  check(
    `Pickpocket: foe loses PICKPOCKET_STEAL (${PICKPOCKET_STEAL}), no refund to the mover`,
    r.charges.p2 === 2 - PICKPOCKET_STEAL,
    `got ${r.charges.p2}`,
  );

  // Floors at 0 defensively — applyPickpocket doesn't self-guard on
  // affordability, same convention as every other pure apply* here.
  const pwThin = power({ p1: "rogue", p2: "mage" }, { p1: 1, p2: 0 });
  const rThin = applyPickpocket(pwThin, "p1");
  check("Pickpocket: floors the foe's charges at 0", rThin.charges.p2 === 0);
}

// ---------------------------------------------------------------------------
// Rogue: Vanish — added 2026-07-22, replacing Backstab's slot entirely (the
// shield-breaker rework lasted about as long as it took to sim it: a 23-42%
// win rate everywhere, since the class lost its offensive equalizer and
// gained too little back). RETIRED sharing Bulwark's map 2026-09-17: Vanish
// now lives in its OWN PowerState.vanished map — a fixed VANISH_TURNS dodge,
// no upkeep, no grace, no ultimate-adjacent countdown quirks — while a wall
// is a PAID, unbounded-duration thing that bleeds. Both fold into the same
// isProtected check every pool uses, so the underlying protection (blocks a
// plain capture, a Charge sweep, and now Push too — see below) is uniform
// with section 14's Bulwark coverage; this section checks Vanish's own
// target pool, its apply-path economy, and one integration proof.
// ---------------------------------------------------------------------------
{
  // --- Legal targeting (mirrors getBulwarkTargets' own tests) -----------
  {
    const s = state("p1", { 0: 4, 2: PATH_LENGTH_PER_PLAYER, 4: 6 });
    const pw = power({ p1: "rogue" }, { p1: VANISH_COST });
    const targets = getVanishTargets(s, pw, "p1");
    check("Vanish: an on-board own token is a legal target", targets.includes(0), JSON.stringify(targets));
    check("Vanish: a reserve own token is not a legal target", !targets.includes(1), JSON.stringify(targets));
    check("Vanish: an escaped own token is not a legal target", !targets.includes(2), JSON.stringify(targets));
    check("Vanish: an enemy token is never a legal target", !targets.includes(4), JSON.stringify(targets));

    const pwVanished: PowerState = { ...pw, vanished: { 0: 2 } };
    check(
      "Vanish: an already-vanished token is excluded from re-targeting",
      !getVanishTargets(s, pwVanished, "p1").includes(0),
    );
  }

  // --- Apply: economy + flagging (mirrors applyBulwark's own tests) -----
  {
    const s = state("p1", { 0: 4 });
    const pw = power({ p1: "rogue" }, { p1: CHARGE_CAP });
    const r = applyVanish(s, pw, 0, "p1");
    check(
      `Vanish: spends exactly VANISH_COST (${VANISH_COST})`,
      r.power.charges.p1 === CHARGE_CAP - VANISH_COST,
      `got ${r.power.charges.p1}`,
    );
    check(
      "Vanish: flags the target with VANISH_TURNS remaining, in its OWN map",
      r.power.vanished[0] === VANISH_TURNS,
      `got ${JSON.stringify(r.power.vanished)}`,
    );
    check("Vanish: never touches the walls map at all", r.power.walls[0] === undefined);
    check("Vanish: no board movement at all", r.state.tokens.find((t) => t.id === 0)!.position === 4);
    check("Vanish: ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
    check("Vanish: breaks a live shield streak (never lands the mover on one)", (() => {
      const base = power({ p1: "rogue" }, { p1: CHARGE_CAP });
      const pwStreak: PowerState = { ...base, shieldStreak: { ...base.shieldStreak, p1: 2 } };
      return applyVanish(s, pwStreak, 0, "p1").power.shieldStreak.p1 === 0;
    })());
  }

  // --- Integration proof: a Vanished stone actually blocks a capture,
  //     via isProtected/isVanished, its own map read. ---
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "archer", p2: "rogue" }), vanished: { 4: 3 } };
    const moves = getLegalPowerMoves(s, pw, 2); // token0: 4 -> 6
    const blocked = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check("Vanish: a Vanished stone blocks a normal capturing move onto it", blocked === undefined, JSON.stringify(moves));
  }

  // --- Vanish blocks Push, same as every other protection now (2026-09-17:
  //     walls went absolute too, so the old "Vanish gets full immunity,
  //     Bulwark only blocks the send-home half" contrast is retired — BOTH
  //     are full Push immunity now, via the same isProtected check). ---
  {
    const s = state("p1", { 0: 4, 4: 6 }); // p1 archer at 4, p2's stone at contested 6
    const base = power({ p1: "archer", p2: "rogue" }, { p1: CHARGE_CAP });
    const pwVanished: PowerState = { ...base, vanished: { 4: VANISH_TURNS } };
    check(
      "Vanish blocks Push: a Vanished Rogue stone is NOT a legal Push target",
      !getPushTargets(s, pwVanished, "p1").includes(4),
      JSON.stringify(getPushTargets(s, pwVanished, "p1")),
    );
    check(
      "Vanish blocks Push: sanity — the identical stone IS a Push target without Vanish",
      getPushTargets(s, base, "p1").includes(4),
      JSON.stringify(getPushTargets(s, base, "p1")),
    );
    // A Warrior's plain Bulwark on the same tile is now EQUALLY absolute —
    // no more soft-push carve-out to distinguish it from Vanish.
    const pwWarrior: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      walls: { 4: "bulwark" },
    };
    check(
      "Vanish blocks Push: a Warrior's Bulwark on the same tile is equally absolute now (no soft-push carve-out left)",
      !getPushTargets(s, pwWarrior, "p1").includes(4),
      JSON.stringify(getPushTargets(s, pwWarrior, "p1")),
    );
  }
}


// ---------------------------------------------------------------------------
// Rogue: Backstab — a guaranteed hit at range. RETIRED its Ward pierce
// 2026-09-17 (walls are absolute now, and Ward stopped being pierceable by
// anything below an ultimate too): getBackstabTargets is a single
// isProtected check, same as every other non-ultimate strike — no more
// "pierces Ward by simple omission," no more wound split (a real kill
// every time it fires at all).
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "rogue", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP });
  const targets = getBackstabTargets(s, pw, "p1");
  check(
    "Backstab: RETIRED pierce — a Warded enemy is NOT a legal target any more",
    !targets.includes(4),
    JSON.stringify(targets),
  );

  const pwBelow = power({ p1: "rogue", p2: "mage" }, { p1: BACKSTAB_COST - 1 });
  check("Backstab: no targets below its cost", getBackstabTargets(s, pwBelow, "p1").length === 0);

  const sShield = state("p1", { 0: 4, 4: 7 });
  check("Backstab: a target on a shield tile is not a legal target", !getBackstabTargets(sShield, pw, "p1").includes(4));

  const pwWalled: PowerState = {
    ...power({ p1: "rogue", p2: "warrior" }, { p1: CHARGE_CAP }),
    walls: { 4: "bulwark" },
  };
  check(
    "Backstab: a walled enemy is NOT a legal target (only ultimates pierce a wall)",
    !getBackstabTargets(s, pwWalled, "p1").includes(4),
  );
  const pwVanished: PowerState = {
    ...power({ p1: "rogue", p2: "rogue" }, { p1: CHARGE_CAP }),
    vanished: { 4: 2 },
  };
  check("Backstab: a Vanished enemy (rogue mirror) is NOT a legal target", !getBackstabTargets(s, pwVanished, "p1").includes(4));

  const sPrivate = state("p1", { 0: 4, 4: 1 });
  check("Backstab: a target outside the contested zone is never legal", getBackstabTargets(sPrivate, pw, "p1").length === 0);

  // --- Apply: a real kill (the only outcome left — no wound tier) ---
  {
    const sKill = state("p1", { 0: 4, 4: 6 });
    const pwKill = power({ p1: "rogue", p2: "archer" }, { p1: CHARGE_CAP, p2: 1 });
    const r = applyBackstab(sKill, pwKill, 4, "p1");
    check("Backstab: kills the target outright", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check(
      "Backstab: does NOT refund on a real kill (unlike Push/Charged Shot's conditional send-home)",
      r.power.charges.p1 === CHARGE_CAP - BACKSTAB_COST,
      `got ${r.power.charges.p1}`,
    );
    check(
      `Backstab: Larceny drains ROGUE_STEAL_ON_CAPTURE (${ROGUE_STEAL_ON_CAPTURE}) from the victim on a real kill`,
      r.power.charges.p2 === Math.max(0, 1 - ROGUE_STEAL_ON_CAPTURE),
      `got ${r.power.charges.p2}`,
    );
    check("Backstab: reports no wound (the field is kept for shape, always null now)", r.woundedTokenId === null);
    const sPact = state("p1", { 0: 4, 4: 6, 5: 1 }); // warlock's 5 waits behind in its own lane: a stand-in
    const pwPact = power({ p1: "rogue", p2: "warlock" }, { p1: CHARGE_CAP, p2: 0 });
    const rp = applyBackstab(sPact, pwPact, 4, "p1");
    // Backstab is a blade never a bow, but it still delivers by LANDING NOWHERE
    // — the rogue never occupies the victim's tile — so it is a RANGED kill.
    // Under DARK_BARGAIN_LANDING_ONLY it is refused like Push/Charged Shot.
    check(
      "Backstab: Larceny drains first, then the victim's Dark Bargain pays (warlock at 0 ends at 1) unless landing-only",
      DARK_BARGAIN_LANDING_ONLY ? rp.power.charges.p2 === 0 : rp.power.charges.p2 === 1,
      `got ${rp.power.charges.p2}`,
    );
    check(
      "Backstab: the bargain saved the runner and took the stand-in unless landing-only",
      DARK_BARGAIN_LANDING_ONLY
        ? rp.state.tokens.find((t) => t.id === 4)!.position === -1 && rp.state.tokens.find((t) => t.id === 5)!.position === 1
        : rp.state.tokens.find((t) => t.id === 4)!.position === 5 && rp.state.tokens.find((t) => t.id === 5)!.position === -1,
    );
    const pwLit: PowerState = { ...power({ p1: "rogue", p2: "bard" }, { p1: CHARGE_CAP, p2: 0 }), inspired: { 4: 3 } };
    const rl = applyBackstab(sPact, pwLit, 4, "p1");
    check("Backstab: a lit (inspired) victim loses the song on the reserve trip", rl.power.inspired[4] === undefined);
    check("Backstab: ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
  }

  // --- Breaks any live shield streak (no token of the mover's ever moves,
  //     so it never lands on a shield itself) ---
  {
    const sStreak = state("p1", { 0: 4, 4: 6 });
    const base = power({ p1: "rogue", p2: "archer" }, { p1: CHARGE_CAP, p2: 0 });
    const pwStreak: PowerState = { ...base, shieldStreak: { ...base.shieldStreak, p1: 2 } };
    const r = applyBackstab(sStreak, pwStreak, 4, "p1");
    check("Backstab: breaks a live shield streak", r.power.shieldStreak.p1 === 0);
  }
}

// ---------------------------------------------------------------------------
// Rogue: Grand Heist ultimate — teleport-capture like Blink Strike, pierces

// ---------------------------------------------------------------------------
// Rogue: Grand Heist ultimate — teleport-capture like Blink Strike, pierces
// shield tiles/Ward/Bulwark/Blessing (every ultimate does), and drains the
// target owner's ENTIRE bank on the kill — NOT just Larceny's flat amount,
// which is deliberately not also applied on top
// ---------------------------------------------------------------------------
{
  const s = state("p1", { 0: 5, 4: 9 });
  const base = power({ p1: "rogue", p2: "mage" });
  const pw: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true } };
  check(
    "Grand Heist: target eligibility matches Rain of Arrows' pool (reused)",
    JSON.stringify(getGrandHeistTargets(s, pw, "p1")) === JSON.stringify(getRainOfArrowsTargets(s, pw, "p1")),
  );

  const sNone = state("p1", { 4: 9 }); // p1 has zero on-board tokens
  check("Grand Heist: no targets when the mover has no on-board token", getGrandHeistTargets(sNone, pw, "p1").length === 0);

  const pwFull: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true }, charges: { p1: 0, p2: 2 } };
  const r = applyGrandHeist(s, pwFull, 4, "p1");
  check("Grand Heist: relocates the mover's token onto the target's tile", r.state.tokens.find((t) => t.id === 0)!.position === 9);
  check("Grand Heist: captures the target", r.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: grants 1 charge on the capture", r.power.charges.p1 === 1, `got ${r.power.charges.p1}`);
  check(
    "Grand Heist: drains the target owner's ENTIRE bank, not just Larceny's flat amount",
    r.power.charges.p2 === 0,
    `got ${r.power.charges.p2}`,
  );
  check("Grand Heist: clears ultimateReady on use", r.power.ultimateReady.p1 === false);
  check("Grand Heist: always ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);

  // Pierces Ward.
  const sWard = state("p1", { 0: 5, 4: 9 });
  const pwWard: PowerState = {
    ...base,
    ultimateReady: { ...base.ultimateReady, p1: true },
    classes: { p1: "rogue", p2: "mage" },
    charges: { p1: 0, p2: CHARGE_CAP },
  };
  check("Grand Heist: sanity — the target really is warded", isWarded(sWard, pwWard, sWard.tokens.find((t) => t.id === 4)!));
  const rWard = applyGrandHeist(sWard, pwWard, 4, "p1");
  check("Grand Heist: captures a Warded target", rWard.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: drains the Warded target owner's entire (full-cap) bank", rWard.power.charges.p2 === 0);

  // Pierces a wall, and clears the captured token's wall (the same
  // reserve-trip leak resolveTurn already guards against elsewhere).
  const sBulwark = state("p1", { 0: 5, 4: 9 });
  const baseW = power({ p1: "rogue", p2: "warrior" });
  const pwBulwark: PowerState = {
    ...baseW,
    ultimateReady: { ...baseW.ultimateReady, p1: true },
    charges: { p1: 0, p2: 2 },
    walls: { 4: "bulwark" },
  };
  const rBulwark = applyGrandHeist(sBulwark, pwBulwark, 4, "p1");
  check("Grand Heist: captures a walled target", rBulwark.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: clears the captured token's wall", rBulwark.power.walls[4] === undefined);

  // Pierces Blessing — a REAL kill (every ultimate kills straight through
  // a wall, same as Rain of Arrows/Blink Strike/Warpath).
  const sBlessed = state("p1", { 0: 5, 4: 9 });
  const pwBlessed: PowerState = {
    ...power({ p1: "rogue", p2: "cleric" }, { p1: 0, p2: 2 }),
    ultimateReady: { p1: true, p2: false },
    walls: { 4: "blessing" },
  };
  const rBlessed = applyGrandHeist(sBlessed, pwBlessed, 4, "p1");
  check("Grand Heist: kills a Blessed target outright (ultimates pierce a wall)", rBlessed.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: clears the captured token's wall", rBlessed.power.walls[4] === undefined);
  check(
    "Grand Heist: still drains the entire bank even on a pierced-blessing kill",
    rBlessed.power.charges.p2 === 0,
  );
}

// ---------------------------------------------------------------------------
// WARLOCK (2026-07-26) — Blood Pact / Curse of Chains / Sacrifice / Fel Storm
// ---------------------------------------------------------------------------
{
  // --- Dark Bargain: the fiend trades a rear stone for a runner (2026-09-16,
  // replaced Blood Pact) ----------------------------------------------------
  {
    // p1 archer's 0 at 6 lands on the p2 warlock's runner 4 at 8 (flip 2);
    // the warlock's 5 at 5 and 6 at 3 stand behind it.
    const pw = power({ p1: "archer", p2: "warlock" });
    const landOn8 = (st: GameState) => getLegalPowerMoves(st, pw, 2).find((mv) => mv.tokenId === 0 && mv.to === 8)!;
    const s = state("p1", { 0: 6, 4: 8, 5: 5, 6: 3 });
    const r = applyPowerMove(s, pw, landOn8(s), "p1");
    check("Bargain: the runner steps back one tile", r.state.tokens.find((t) => t.id === 4)!.position === 8 - DARK_BARGAIN_RETREAT);
    check("Bargain: the least-advanced other stone goes home instead", r.state.tokens.find((t) => t.id === 6)!.position === -1 && r.state.tokens.find((t) => t.id === 5)!.position === 5);
    check("Bargain: the attacker still takes the tile and still banks the kill", r.state.tokens.find((t) => t.id === 0)!.position === 8 && r.power.charges.p1 === 1);
    check("Bargain: the stand-in's death pays the warlock", r.power.charges.p2 === BLOOD_PACT_CHARGES, `p2=${r.power.charges.p2}`);
    check(
      "Bargain: announced on the warlock's slot",
      r.power.darkBargain.p2?.savedTokenId === 4 && r.power.darkBargain.p2?.from === 8 && r.power.darkBargain.p2?.to === 7 && r.power.darkBargain.p2?.sacrificedTokenId === 6 && r.power.darkBargain.p2?.sacrificedFrom === 3,
      JSON.stringify(r.power.darkBargain),
    );
    check("Bargain: the fresh-turn tick clears the announcement", tickDarkBargainForNewTurn(r.power).darkBargain.p2 === null);
    check("Bargain: the tick is a no-op reference when nothing is set", tickDarkBargainForNewTurn(pw) === pw);

    // No other stone strictly BEHIND the victim: the stone dies, nothing is paid.
    const sAhead = state("p1", { 0: 6, 4: 8, 5: 10 });
    const rA = applyPowerMove(sAhead, pw, landOn8(sAhead), "p1");
    check("Bargain: refused when the only other stone is ahead of the victim", rA.state.tokens.find((t) => t.id === 4)!.position === -1 && rA.state.tokens.find((t) => t.id === 5)!.position === 10);
    check("Bargain: a refused death pays nothing", rA.power.charges.p2 === 0 && rA.power.darkBargain.p2 === null);
    const sAlone = state("p1", { 0: 6, 4: 8 });
    const rAl = applyPowerMove(sAlone, pw, landOn8(sAlone), "p1");
    check("Bargain: refused when the victim is the warlock's only stone on the board", rAl.state.tokens.find((t) => t.id === 4)!.position === -1 && rAl.power.charges.p2 === 0);

    // Retreat tile held by someone else: refused.
    const sBlocked = state("p1", { 0: 6, 1: 7, 4: 8, 6: 3 });
    const rB = applyPowerMove(sBlocked, pw, landOn8(sBlocked), "p1");
    check("Bargain: refused when the retreat tile is occupied", rB.state.tokens.find((t) => t.id === 4)!.position === -1 && rB.state.tokens.find((t) => t.id === 6)!.position === 3);
    // ...unless the occupant IS the stand-in, which vacates it.
    const sSwap = state("p1", { 0: 6, 4: 8, 5: 7 });
    const rS = applyPowerMove(sSwap, pw, landOn8(sSwap), "p1");
    check("Bargain: the stand-in on the retreat tile gives up its place", rS.state.tokens.find((t) => t.id === 4)!.position === 7 && rS.state.tokens.find((t) => t.id === 5)!.position === -1);

    // A Push from directly behind leaves the pusher on the retreat tile — refused by the same rule.
    const sPush = state("p2", { 0: 9, 1: 3, 4: 8 });
    const rP = applyPush(sPush, power({ p1: "warlock", p2: "archer" }, { p2: 1 }), 0, "p2");
    check("Bargain: a pushed-home stone whose retreat tile the pusher holds simply dies", rP.state.tokens.find((t) => t.id === 0)!.position === -1 && rP.state.tokens.find((t) => t.id === 1)!.position === 3 && rP.power.charges.p1 === 0);
    // Non-warlock owners get nothing from the same death (unchanged).
    const rNo = applyPush(sPush, power({ p1: "mage", p2: "archer" }, { p2: 1 }), 0, "p2");
    check("Bargain: a non-warlock victim banks nothing", rNo.power.charges.p1 === 0);

    // Ultimates take what they want: Blink Strike kills the runner outright.
    const sUlt = state("p1", { 0: 5, 4: 8, 6: 3 });
    const pwUlt: PowerState = { ...power({ p1: "mage", p2: "warlock" }), ultimateReady: { p1: true, p2: false } };
    const rU = applyBlinkStrike(sUlt, pwUlt, 4, "p1");
    check("Bargain: an ultimate bypasses it", rU.state.tokens.find((t) => t.id === 4)!.position === -1 && rU.state.tokens.find((t) => t.id === 6)!.position === 3 && rU.power.charges.p2 === 0);

    // The warlock's own Sacrifice is suicide, never a bargain.
    const sSelf = state("p1", { 0: 5, 1: 9, 4: 8 });
    const rSelf = applySacrifice(sSelf, power({ p1: "warlock", p2: "archer" }, { p1: SACRIFICE_COST }), 4, "p1");
    check("Bargain: never struck for the warlock's own Sacrifice", rSelf.state.tokens.find((t) => t.id === 1)!.position === -1 && rSelf.state.tokens.find((t) => t.id === 0)!.position === 5 && rSelf.power.darkBargain.p1 === null);

    // A necromancer's corpse and grave follow the stone that actually died.
    const pwNec = power({ p1: "necromancer", p2: "warlock" });
    const sNec = state("p1", { 0: 6, 4: 8, 6: 3 });
    const rN = applyPowerMove(sNec, pwNec, getLegalPowerMoves(sNec, pwNec, 2).find((mv) => mv.tokenId === 0 && mv.to === 8)!, "p1");
    check("Bargain: the necromancer's corpse is the stand-in, on its own tile", rN.power.corpse.p1?.tokenId === 6 && rN.power.corpse.p1?.tile === 3 && rN.power.grave.p1 === 3, JSON.stringify(rN.power.corpse));
    check("Bargain: the necromancer still banks the soul bounty", rN.power.charges.p1 === SOUL_BOUNTY_CHARGES);

    // The stand-in died for real: reserve-trip hygiene strips any wall from
    // it, same defensive guard as curse/hamstring/inspire — even though a
    // Warlock's own stone can never actually hold one in real play (Bulwark/
    // Bless/Benediction only ever grant a wall to their OWN caster's army).
    const pwWalled: PowerState = { ...pw, walls: { 6: "bulwark" } };
    const rW = applyPowerMove(s, pwWalled, getLegalPowerMoves(s, pwWalled, 2).find((mv) => mv.tokenId === 0 && mv.to === 8)!, "p1");
    check("Bargain: the stand-in's wall clears on its reserve trip", rW.power.walls[6] === undefined);

    // --- The archer lever: DARK_BARGAIN_LANDING_ONLY ----------------------
    // Flag is false by default (ships only after playtest Test 1), so these
    // assert against the CURRENT value — flip it locally to exercise the
    // other branch; both must stay green.

    // Charge sweep (ranged: the sweep victim is never on the warrior's own
    // landing tile). Warlock's runner 4 at 6 is swept by warrior 0's charge
    // 4->8; warlock's 5 at 2 is the stand-in, strictly behind the runner,
    // with a free retreat tile at 5.
    {
      const sSweep = state("p1", { 0: 4, 4: 6, 5: 2 });
      const pwSweep = power({ p1: "warrior", p2: "warlock" }, { p1: 1 });
      const mSweep = getLegalPowerMoves(sSweep, pwSweep, 4).find((mv) => mv.tokenId === 0 && mv.to === 8)!;
      check("Bargain/lever: sanity — the sweep catches the runner", mSweep.chargeSweepCaptures.includes(4));
      const rSweep = applyCharge(sSweep, pwSweep, mSweep, "p1");
      if (DARK_BARGAIN_LANDING_ONLY) {
        check("Bargain/lever: a ranged Charge-sweep kill is refused — the runner just dies", rSweep.state.tokens.find((t) => t.id === 4)!.position === -1);
        check("Bargain/lever: the stand-in is untouched", rSweep.state.tokens.find((t) => t.id === 5)!.position === 2);
      } else {
        check("Bargain/lever: a Charge-sweep kill still bargains when the lever is off", rSweep.state.tokens.find((t) => t.id === 4)!.position === 5);
        check("Bargain/lever: the stand-in pays for it", rSweep.state.tokens.find((t) => t.id === 5)!.position === -1);
      }
    }

    // Push (ranged, send-home): warlock's runner 4 at 5, stand-in 5 sits
    // exactly on the retreat tile (4) and is excluded from its own block —
    // the push's collision math and the bargain's retreat math coincide by
    // construction (both are one tile behind the victim).
    {
      const sPushLever = state("p1", { 4: 5, 5: 4 });
      const rPushLever = applyPush(sPushLever, power({ p1: "archer", p2: "warlock" }, { p1: 1 }), 4, "p1");
      check(
        "Bargain/lever: sanity — the push forces a collision-home either way",
        DARK_BARGAIN_LANDING_ONLY ? rPushLever.state.tokens.find((t) => t.id === 4)!.position === -1 : rPushLever.state.tokens.find((t) => t.id === 4)!.position === 4,
      );
      if (DARK_BARGAIN_LANDING_ONLY) {
        check("Bargain/lever: a ranged Push send-home is refused", rPushLever.state.tokens.find((t) => t.id === 5)!.position === 4 && rPushLever.power.charges.p2 === 0);
      } else {
        check("Bargain/lever: a Push send-home still bargains when the lever is off — the runner retreats to the tile the push tried to send it to, vacated by the stand-in", rPushLever.state.tokens.find((t) => t.id === 5)!.position === -1 && rPushLever.power.charges.p2 === 1);
      }
    }

    // Corpse Explosion (ranged): warlock's runner 4 stands on the grave (8),
    // stand-in 5 waits behind at 3, retreat tile 7 is free.
    {
      const pwBlastLever: PowerState = {
        ...power({ p1: "necromancer", p2: "warlock" }, { p1: CORPSE_EXPLOSION_COST }),
        corpse: { p1: { tokenId: 6, tile: 8 }, p2: null },
        grave: { p1: 8, p2: null },
      };
      const sBlastLever = state("p1", { 4: 8, 5: 3 });
      const rBlastLever = applyCorpseExplosion(sBlastLever, pwBlastLever, "p1");
      if (DARK_BARGAIN_LANDING_ONLY) {
        check("Bargain/lever: the blast's ranged kill is refused", rBlastLever.state.tokens.find((t) => t.id === 4)!.position === -1 && rBlastLever.state.tokens.find((t) => t.id === 5)!.position === 3);
      } else {
        check("Bargain/lever: the blast still bargains when the lever is off", rBlastLever.state.tokens.find((t) => t.id === 4)!.position === 7 && rBlastLever.state.tokens.find((t) => t.id === 5)!.position === -1);
      }
    }

    // A Bard march (LANDING) fires the bargain either way — the lever only
    // narrows RANGED deliveries. Warlock's runner 4 at 8 stands on the
    // march's landing tile; stand-in 5 waits at 3; retreat tile 7 is free.
    {
      const sMarchLever = state("p1", { 0: 6, 4: 8, 5: 3 });
      let pwMarchLever = power({ p1: "bard", p2: "warlock" }, { p1: INSPIRE_COST + HASTE_COST });
      pwMarchLever = applyInspire(pwMarchLever, 0, "p1");
      const rMarchLever = applySongOfHaste(sMarchLever, pwMarchLever, "p1");
      check("Bargain/lever: a Bard march is a landing capture and always bargains", rMarchLever.state.tokens.find((t) => t.id === 4)!.position === 7 && rMarchLever.state.tokens.find((t) => t.id === 5)!.position === -1);
    }
  }

  // --- Curse of Chains: targeting -----------------------------------------
  const sCurse = state("p1", { 0: 5, 4: 9, 5: 2 });
  const pwCurse = power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST });
  const curseTargets = getCurseTargets(sCurse, pwCurse, "p1");
  check("Curse: an enemy in shared water is a legal target", curseTargets.includes(4));
  check("Curse: an enemy in its own private lane is NOT", !curseTargets.includes(5));
  check(
    "Curse: no targets below CURSE_COST",
    getCurseTargets(sCurse, power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST - 1 }), "p1").length === 0,
  );
  // Already-cursed by THIS caster is excluded (a full-price no-op).
  const pwAlready = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST * 2 }), 4, "p1");
  check("Curse: re-cursing the same stone is not offered", !getCurseTargets(sCurse, pwAlready, "p1").includes(4));
  // Vanish makes a stone untargetable by every enemy ability below an ult.
  const pwVanished: PowerState = {
    ...power({ p1: "warlock", p2: "rogue" }, { p1: CURSE_COST }),
    vanished: { 4: VANISH_TURNS },
  };
  check("Curse: a Vanished stone cannot be cursed", !getCurseTargets(sCurse, pwVanished, "p1").includes(4));
  // Ward/shield tiles do NOT block it — the chains bind the legs, not armor.
  const sWard = state("p1", { 0: 5, 4: 9, 6: 3 });
  const pwWard = power({ p1: "warlock", p2: "mage" }, { p1: CURSE_COST, p2: CHARGE_CAP });
  check("Curse: a Warded stone IS cursable", getCurseTargets(sWard, pwWard, "p1").includes(4));

  // --- Curse of Chains: the stride reduction -------------------------------
  const sSlow = state("p2", { 4: 6, 0: 0 });
  const pwSlow = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST }), 4, "p1");
  check("Curse: applyCurse spends CURSE_COST", pwSlow.charges.p1 === 0);
  check("Curse: the mark is live", isCursed(pwSlow, 4));
  const slowed = getLegalPowerMoves(sSlow, pwSlow, 3).find((m) => m.tokenId === 4);
  check("Curse: a flip of 3 moves the cursed stone only 3 - CURSE_SLOW", slowed?.to === 6 + 3 - CURSE_SLOW);
  const uncursed = getLegalPowerMoves(sSlow, power({ p1: "warlock", p2: "archer" }), 3).find((m) => m.tokenId === 4);
  check("Curse: an unafflicted stone moves its full distance", uncursed?.to === 6 + 3);
  check(
    "Curse: at flip CURSE_SLOW the cursed stone has no move at all",
    getLegalPowerMoves(sSlow, pwSlow, CURSE_SLOW).every((m) => m.tokenId !== 4),
  );
  // The victim's OTHER stones are untouched — the hex is per-token.
  const sBoth = state("p2", { 4: 6, 5: 6 });
  const pwBoth = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST }), 4, "p1");
  const other = getLegalPowerMoves(sBoth, pwBoth, 3).find((m) => m.tokenId === 5);
  check("Curse: only the marked stone is slowed", other?.to === 9);

  // --- Curse of Chains: expiry ---------------------------------------------
  {
    // Ticks on the VICTIM's turn-starts (curse slots are keyed by caster).
    let p = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST }), 4, "p1");
    const victimTurn = state("p2", { 4: 6 });
    for (let i = 1; i < CURSE_TURNS; i++) {
      const r = tickCurseForNewTurn(victimTurn, p);
      p = r.power;
      check(`Curse: still bound after ${i} victim turn(s)`, isCursed(p, 4) && r.expiredTokenId === null);
    }
    const last = tickCurseForNewTurn(victimTurn, p);
    check("Curse: lifts after CURSE_TURNS victim turn-starts", !isCursed(last.power, 4));
    check("Curse: announces which stone was freed", last.expiredTokenId === 4);
    // The CASTER's own turn-starts must not tick it down.
    const casterTurn = state("p1", { 4: 6 });
    const pCaster = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST }), 4, "p1");
    check(
      "Curse: the caster's own turn does not burn a curse turn",
      tickCurseForNewTurn(casterTurn, pCaster).power.curse.p1?.turnsLeft === CURSE_TURNS,
    );
  }

  // --- Curse hygiene: a reserve trip lifts the chains ----------------------
  {
    // p2 archer at 8 pushes the cursed p1 stone at 9 home; the curse must
    // not ride the reserve trip back onto the board.
    const sHyg = state("p2", { 0: 9, 4: 8 });
    const pwHyg = applyCurse(power({ p1: "warlock", p2: "archer" }, { p1: CURSE_COST, p2: 1 }), 0, "p2");
    check("Curse hygiene: the mark is live before the kill", isCursed(pwHyg, 0));
    const rHyg = applyPush(sHyg, pwHyg, 0, "p2");
    check("Curse hygiene: a killed stone's curse lifts", !isCursed(rHyg.power, 0));
  }

  // --- Sacrifice: targeting -------------------------------------------------
  // Target on 8, not 7: tile 7 is the board's middle SHIELD (see
  // BOARD_LAYOUT), which every class including this one is barred from.
  const sSac = state("p1", { 0: 5, 1: 9, 4: 8, 5: 2 });
  const pwSac = power({ p1: "warlock", p2: "archer" }, { p1: SACRIFICE_COST });
  const sacTargets = getSacrificeTargets(sSac, pwSac, "p1");
  check("Sacrifice: an enemy in shared water is a legal target", sacTargets.includes(4));
  check("Sacrifice: an enemy in its own private lane is NOT", !sacTargets.includes(5));
  check(
    "Sacrifice: no targets below SACRIFICE_COST",
    getSacrificeTargets(sSac, power({ p1: "warlock", p2: "archer" }, { p1: SACRIFICE_COST - 1 }), "p1").length === 0,
  );
  check(
    "Sacrifice: no targets with no stone to give",
    getSacrificeTargets(state("p1", { 4: 7 }), pwSac, "p1").length === 0,
  );
  // Bulwark/Vanish block it, same as ever.
  const pwSacBul: PowerState = { ...pwSac, walls: { 4: "bulwark" } };
  check("Sacrifice: a walled stone is protected", !getSacrificeTargets(sSac, pwSacBul, "p1").includes(4));
  // RETIRED 2026-09-17: Ward is no longer pierced either — walls went
  // absolute and Ward stopped being pierceable by anything below an
  // ultimate at the same time, so Sacrifice's whole "pierce Ward/Blessing"
  // identity is gone; getSacrificeTargets is a single isProtected check now.
  const pwSacWard = power({ p1: "warlock", p2: "mage" }, { p1: SACRIFICE_COST, p2: CHARGE_CAP });
  const sSacWard = state("p1", { 0: 5, 1: 9, 4: 8 });
  check(
    "Sacrifice: a Warded stone is NOT a legal target any more (the old pierce retired)",
    isWarded(sSacWard, pwSacWard, sSacWard.tokens.find((t) => t.id === 4)!) &&
      !getSacrificeTargets(sSacWard, pwSacWard, "p1").includes(4),
  );

  // --- Sacrifice: resolution + economy --------------------------------------
  {
    const rSac = applySacrifice(sSac, pwSac, 4, "p1");
    check("Sacrifice: the target dies", rSac.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Sacrifice: the MOST-advanced own stone is the price", rSac.sacrificedTokenId === 1);
    check("Sacrifice: that stone goes home", rSac.state.tokens.find((t) => t.id === 1)!.position === -1);
    check("Sacrifice: the rear stone is untouched", rSac.state.tokens.find((t) => t.id === 0)!.position === 5);
    // THE economy invariant this ability was rebalanced around: the full
    // bank is spent and the pact does NOT refund the self-inflicted death.
    check("Sacrifice: spends the full bank and banks nothing back", rSac.power.charges.p1 === 0);
    check("Sacrifice: ends the turn", rSac.state.currentPlayer === "p2");
  }
  {
    // RETIRED 2026-09-17: a BLESSED (walled) target is no longer a legal
    // Sacrifice target at all — the old "pierce, no wound split" identity
    // is gone; the target pool excludes it outright, same as Bulwark.
    const pwSacBless: PowerState = { ...pwSac, walls: { 4: "blessing" } };
    check("Sacrifice: a Blessed stone is not a legal target any more", !getSacrificeTargets(sSac, pwSacBless, "p1").includes(4));
  }
  {
    // In a mirror, the ENEMY warlock is still paid for the stone it lost.
    const pwMirror = power({ p1: "warlock", p2: "warlock" }, { p1: SACRIFICE_COST });
    const rMirror = applySacrifice(sSac, pwMirror, 4, "p1");
    check(
      "Sacrifice: an enemy warlock's Dark Bargain still fires for the target unless landing-only",
      DARK_BARGAIN_LANDING_ONLY
        ? rMirror.power.charges.p2 === 0 && rMirror.state.tokens.find((t) => t.id === 4)!.position === -1
        : rMirror.power.charges.p2 === 1 && rMirror.state.tokens.find((t) => t.id === 5)!.position === -1 && rMirror.state.tokens.find((t) => t.id === 4)!.position === 7,
    );
    check("Sacrifice: the caster still gets nothing for its own", rMirror.power.charges.p1 === 0);
  }

  // --- Fel Storm ------------------------------------------------------------
  {
    // The private-lane decoy sits at 1, not 2: the stacking walk runs
    // 4 -> 3 -> 2 for three victims, so a stone parked on 2 would
    // legitimately push the third one further back and muddy the check.
    const sStorm = state("p1", { 0: 5, 4: 11, 5: 9, 6: 8, 7: 1 });
    const pwStorm: PowerState = {
      ...power({ p1: "warlock", p2: "archer" }),
      ultimateReady: { p1: true, p2: false },
    };
    const stormTargets = getFelStormTargets(sStorm, pwStorm, "p1");
    check("Fel Storm: catches every enemy in shared water", [4, 5, 6].every((id) => stormTargets.includes(id)));
    check("Fel Storm: spares an enemy in its own private lane", !stormTargets.includes(7));

    const rStorm = applyFelStorm(sStorm, pwStorm, "p1");
    const pos = (id: number) => rStorm.state.tokens.find((t) => t.id === id)!.position;
    // Most-advanced lands on the gate; the rest stack backward in order.
    check("Fel Storm: the lead victim lands on the gate", pos(4) === FEL_STORM_RETURN_POSITION);
    check("Fel Storm: the pack stacks backward, order preserved", pos(5) === FEL_STORM_RETURN_POSITION - 1 && pos(6) === FEL_STORM_RETURN_POSITION - 2);
    check("Fel Storm: a private-lane enemy is untouched", pos(7) === 1);
    check("Fel Storm: the warlock's own stone is untouched", pos(0) === 5);
    check("Fel Storm: nobody dies", rStorm.sentHomeIds.length === 0);
    check("Fel Storm: spends the ultimate", rStorm.power.ultimateReady.p1 === false);
    check("Fel Storm: ends the turn", rStorm.state.currentPlayer === "p2");
    check("Fel Storm: grants no charge (displacement, not capture)", rStorm.power.charges.p1 === 0);

    // Pierces everything: Ward, a wall and a shield tile are all irrelevant.
    const sPierce = state("p1", { 0: 5, 4: 11 });
    const pwPierce: PowerState = {
      ...power({ p1: "warlock", p2: "mage" }, { p2: CHARGE_CAP }),
      ultimateReady: { p1: true, p2: false },
      walls: { 4: "bulwark" },
    };
    const rPierce = applyFelStorm(sPierce, pwPierce, "p1");
    check(
      "Fel Storm: drags a Warded + walled stone anyway",
      rPierce.state.tokens.find((t) => t.id === 4)!.position === FEL_STORM_RETURN_POSITION,
    );
    check("Fel Storm: a dragged stone keeps its wall (it never died — this is a displacement, not a kill)", rPierce.power.walls[4] === "bulwark");
  }
}

// ---------------------------------------------------------------------------
// HUNTER (2026-07-26) — Wolf Companion / Snare / Piercing Shot / Wild Hunt
// ---------------------------------------------------------------------------
{
  // --- Wolf Companion -----------------------------------------------------
  // p2 hunter's lead stone sits on 8, so the wolf guards 9.
  const sWolf = state("p1", { 0: 6, 4: 8 });
  const pwWolf = power({ p1: "archer", p2: "hunter" });
  check("Wolf: guards the tile ahead of the hunter's LEAD stone", wolfGuardTile(sWolf, pwWolf, "p2") === 9);
  check("Wolf: a non-hunter has none", wolfGuardTile(sWolf, power({ p1: "archer", p2: "archer" }), "p2") === null);
  // A hunter whose only stone is in its private lane guards nothing (the
  // tile ahead isn't contested) — the flaw the first balance run exposed.
  check(
    "Wolf: guards nothing from the private lane",
    wolfGuardTile(state("p1", { 4: 1 }), pwWolf, "p2") === null,
  );

  // p1 moves 6 -> 9 (flip 3) and lands on the guarded tile: the wolf takes it.
  const wolfMove = getLegalPowerMoves(sWolf, pwWolf, 3).find((m) => m.tokenId === 0)!;
  const rWolf = applyPowerMove(sWolf, pwWolf, wolfMove, "p1");
  check("Wolf: the stone that landed there is taken", rWolf.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Wolf: the bite is announced", rWolf.wolfBite?.tokenId === 0 && rWolf.wolfBite?.sentHome === true);
  check("Wolf: the kill pays the hunter a charge", rWolf.power.charges.p2 === 1);
  // Landing anywhere else is safe.
  const safeMove = getLegalPowerMoves(sWolf, pwWolf, 2).find((m) => m.tokenId === 0)!;
  check("Wolf: only the guarded tile bites", applyPowerMove(sWolf, pwWolf, safeMove, "p1").wolfBite === null);
  // Protection walks past it.
  const pwWolfWard = power({ p1: "mage", p2: "hunter" }, { p1: CHARGE_CAP });
  const rWarded = applyPowerMove(sWolf, pwWolfWard, getLegalPowerMoves(sWolf, pwWolfWard, 3).find((m) => m.tokenId === 0)!, "p1");
  check("Wolf: a Warded stone walks past untouched", rWarded.wolfBite === null);

  // --- Snare: placement ---------------------------------------------------
  const sSnare = state("p1", { 0: 5, 4: 9 });
  const pwSnare = power({ p1: "hunter", p2: "archer" }, { p1: SNARE_COST });
  const tiles = getSnareTiles(sSnare, pwSnare, "p1");
  check("Snare: offers empty contested tiles", tiles.includes(6) && tiles.includes(8));
  check("Snare: never the middle shield tile", !tiles.includes(7));
  check("Snare: never a private-lane tile", !tiles.some((t) => t < 4 || t > 11));
  check("Snare: never an occupied tile", !tiles.includes(5) && !tiles.includes(9));
  check(
    "Snare: nothing offered below SNARE_COST",
    getSnareTiles(sSnare, power({ p1: "hunter", p2: "archer" }, { p1: SNARE_COST - 1 }), "p1").length === 0,
  );
  const pwArmed = applySnare(pwSnare, 8, "p1");
  check("Snare: applySnare spends SNARE_COST", pwArmed.charges.p1 === 0);
  check("Snare: the trap is armed on the chosen tile", pwArmed.traps.p1 === 8);
  check("Snare: re-siting is not re-offered on the same tile", !getSnareTiles(sSnare, { ...pwArmed, charges: { p1: 2, p2: 0 } }, "p1").includes(8));

  // --- Snare: springing ---------------------------------------------------
  {
    // p2's stone on 6 flips 2 -> lands on 8, where p1's trap waits. The
    // hunter's own stone is parked on 10 ON PURPOSE: at 5 its wolf would
    // guard tile 6, which is exactly where the trap throws the victim —
    // the trap feeds the wolf, a real and rather good interaction, but it
    // would confound the knockback assertions below. It gets its own check
    // right after this block.
    const sSpring = state("p2", { 0: 10, 4: 6 });
    const pwSpring: PowerState = { ...power({ p1: "hunter", p2: "archer" }), traps: { p1: 8, p2: null } };
    const m = getLegalPowerMoves(sSpring, pwSpring, 2).find((t) => t.tokenId === 4)!;
    const r = applyPowerMove(sSpring, pwSpring, m, "p2");
    check("Snare: springs on the landing", r.trapSprung?.tile === 8 && r.trapSprung?.tokenId === 4);
    check("Snare: throws the victim TRAP_KNOCKBACK back", r.state.tokens.find((t) => t.id === 4)!.position === 8 - TRAP_KNOCKBACK);
    check("Snare: the trap is consumed", r.power.traps.p1 === null);
    check("Snare: pays its setter TRAP_BOUNTY", r.power.charges.p1 === TRAP_BOUNTY);
    // Landing elsewhere leaves it armed.
    const m1 = getLegalPowerMoves(sSpring, pwSpring, 1).find((t) => t.tokenId === 4)!;
    const rMiss = applyPowerMove(sSpring, pwSpring, m1, "p2");
    check("Snare: an untripped trap stays armed", rMiss.power.traps.p1 === 8 && rMiss.trapSprung === null);
  }
  {
    // TRAP FEEDS WOLF: the hunter's stone on 5 guards tile 6, and a trap on
    // 8 throws its victim to exactly 6 — so the two halves of the kit chain
    // into a kill. Emergent from the resolve order (trap, then wolf, each
    // re-reading the board), not special-cased anywhere, and worth pinning
    // down so a future reorder can't silently break it.
    const sChain = state("p2", { 0: 5, 4: 6 });
    const pwChain: PowerState = { ...power({ p1: "hunter", p2: "archer" }), traps: { p1: 8, p2: null } };
    const m = getLegalPowerMoves(sChain, pwChain, 2).find((t) => t.tokenId === 4)!;
    const r = applyPowerMove(sChain, pwChain, m, "p2");
    check("Trap into wolf: the trap springs first", r.trapSprung?.tile === 8);
    check("Trap into wolf: the throw lands in the wolf's jaws and it kills", r.wolfBite?.sentHome === true);
    check("Trap into wolf: the victim ends up home", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Trap into wolf: the hunter is paid for both", r.power.charges.p1 === TRAP_BOUNTY + 1);
  }

  // --- Piercing Shot ------------------------------------------------------
  {
    // p1 hunter's lead stone on 5; enemy on 9 with a clear lane between.
    const sShot = state("p1", { 0: 5, 4: 9 });
    const pwShot = power({ p1: "hunter", p2: "archer" }, { p1: PIERCING_SHOT_COST });
    check("Piercing Shot: finds the first enemy down the lane", getPiercingShotTargets(sShot, pwShot, "p1")[0] === 4);
    check(
      "Piercing Shot: nothing offered below the full bank",
      getPiercingShotTargets(sShot, power({ p1: "hunter", p2: "archer" }, { p1: PIERCING_SHOT_COST - 1 }), "p1").length === 0,
    );
    const r = applyPiercingShot(sShot, pwShot, "p1");
    check("Piercing Shot: the victim dies", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Piercing Shot: reports the kill", r.killedTokenId === 4);
    check("Piercing Shot: spends the bank and earns the capture charge", r.power.charges.p1 === 1);
    check("Piercing Shot: ends the turn", r.state.currentPlayer === "p2");

    // THE counterplay: the first body stops the arrow, for everything behind.
    const sBlocked = state("p1", { 0: 5, 4: 9, 5: 6 });
    const pwBlocked: PowerState = { ...pwShot, walls: { 5: "bulwark" } };
    check(
      "Piercing Shot: a protected stone body-blocks the lane",
      getPiercingShotTargets(sBlocked, pwBlocked, "p1").length === 0,
    );
    // An UNPROTECTED nearer stone is simply the one that dies.
    check("Piercing Shot: the nearer unprotected stone is the victim", getPiercingShotTargets(sBlocked, pwShot, "p1")[0] === 5);
    // No enemy ahead at all = no shot. (The own-stone arm of
    // piercingShotVictim is defensive only: the arrow fires FROM the
    // hunter's most-advanced stone, so by construction none of their own
    // stones can be ahead of it. It is kept for effectiveOwner's sake and
    // against a future change to which stone shoots.)
    check(
      "Piercing Shot: no enemy down the lane means no shot",
      getPiercingShotTargets(state("p1", { 0: 9, 4: 5 }), pwShot, "p1").length === 0,
    );
    // RETIRED 2026-09-17: a BLESSED (walled) sole occupant now stops the
    // arrow outright (piercingShotVictim's own isProtected check returns
    // null) — no wound tier left, the shot simply finds no victim at all
    // and the cost is spent for nothing.
    const pwBless: PowerState = { ...pwShot, walls: { 4: "blessing" } };
    check("Piercing Shot: a Blessed sole occupant leaves no legal target", getPiercingShotTargets(sShot, pwBless, "p1").length === 0);
    const rBless = applyPiercingShot(sShot, pwBless, "p1");
    check("Piercing Shot: armor stops the arrow — no kill, no wound, the stone holds its tile", rBless.killedTokenId === null && rBless.woundedTokenId === null && rBless.state.tokens.find((t) => t.id === 4)!.position === 9);
  }

  // --- Wild Hunt ----------------------------------------------------------
  {
    const sHunt = state("p1", { 0: 5, 4: 6, 5: 9, 6: 11, 7: 2 });
    const pwHunt: PowerState = {
      ...power({ p1: "hunter", p2: "archer" }),
      ultimateReady: { p1: true, p2: false },
      traps: { p1: 8, p2: null },
    };
    const pool = getWildHuntTargets(sHunt, pwHunt, "p1");
    check("Wild Hunt: pools every enemy in shared water", [4, 5, 6].every((id) => pool.includes(id)));
    check("Wild Hunt: spares a private-lane enemy", !pool.includes(7));

    const r = applyWildHunt(sHunt, pwHunt, "p1");
    check("Wild Hunt: the wolf takes the NEAREST quarry", r.killedTokenId === 4);
    check("Wild Hunt: that stone goes home", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Wild Hunt: everyone else in the row freezes", r.frozenTokenIds.includes(5) && r.frozenTokenIds.includes(6));
    check("Wild Hunt: the private-lane enemy is untouched", !r.frozenTokenIds.includes(7));
    check("Wild Hunt: frozen stones carry the timer", isHamstrung(r.power, 5) && isHamstrung(r.power, 6));
    check("Wild Hunt: spends the ultimate", r.power.ultimateReady.p1 === false);
    check("Wild Hunt: springs the hunter's own trap too", r.power.traps.p1 === null);
    check("Wild Hunt: the kill pays a charge", r.power.charges.p1 === 1);

    // A frozen stone generates no moves at all, and its owner's others do.
    const frozenTurn: GameState = { ...r.state, currentPlayer: "p2" };
    const moves = getLegalPowerMoves(frozenTurn, r.power, 2);
    check("Frozen: the stone offers no moves", moves.every((m) => m.tokenId !== 5));
    check("Frozen: the army's other stones move normally", moves.some((m) => m.tokenId === 7));
    // It thaws on the victim's own turn-starts.
    let p = r.power;
    for (let i = 0; i < WILD_HUNT_FREEZE_TURNS; i++) p = tickHamstringForNewTurn(frozenTurn, p).power;
    check("Frozen: thaws after WILD_HUNT_FREEZE_TURNS victim turns", !isHamstrung(p, 5));
  }
}

// ---------------------------------------------------------------------------
// BARBARIAN (2026-07-27) — Rage / Reckless Swing / Whirlwind / Bloodbath
// ---------------------------------------------------------------------------
{
  // --- Rage: the deficit, not the raw reserve count -----------------------
  const even = state("p1", { 0: 5, 4: 5 }); // 3 in reserve each
  const pwBarb = power({ p1: "barbarian", p2: "archer" });
  check("Rage: nothing while the reserves are level (incl. the opening)", rageFor(even, pwBarb, "p1") === 0);
  check("Rage: a non-barbarian never rages", rageFor(even, power({ p1: "archer", p2: "archer" }), "p1") === 0);
  // Barbarian down two stones (1 on board) vs archer with 3 on board.
  const behind = state("p1", { 0: 5, 4: 4, 5: 6, 6: 8 });
  check("Rage: stokes when behind on stones", rageFor(behind, pwBarb, "p1") === 2);
  // Barbarian AHEAD gets nothing.
  const ahead = state("p1", { 0: 5, 1: 6, 2: 8, 4: 4 });
  check("Rage: nothing while ahead", rageFor(ahead, pwBarb, "p1") === 0);
  check("Rage: capped at RAGE_MAX", rageFor(state("p1", { 4: 4, 5: 5, 6: 6, 7: 8 }), pwBarb, "p1") === RAGE_MAX);

  // --- Rage: scoped to ONE stone (RAGE_SCOPE) -----------------------------
  {
    // p1 barbarian has stones on 5 and 9, two in reserve; the archer has
    // all four on the board, so the deficit is 2.
    const s = state("p1", { 0: 5, 1: 9, 4: 2, 5: 4, 6: 6, 7: 8 });
    const raged = ragedToken(s, pwBarb, "p1");
    check("Rage: the raged stone is the least-advanced (reserve counts as least)", raged === 2 || raged === 3);
    const moves = getLegalPowerMoves(s, pwBarb, 1);
    // The two BOARD stones move their plain distance; only the raged
    // (reserve) stone gets the bonus, entering further up the lane.
    check("Rage: an unraged board stone moves its plain distance", moves.some((m) => m.tokenId === 0 && m.to === 6));
    const entering = moves.find((m) => m.tokenId === raged);
    check("Rage: the raged stone enters further in", entering !== undefined && entering.to === 1 - 1 + RAGE_MAX);
  }

  // --- Reckless Swing -----------------------------------------------------
  {
    // p1 barbarian on 8, enemy directly ahead on 9.
    const s = state("p1", { 0: 8, 4: 9 });
    const pw = power({ p1: "barbarian", p2: "archer" }, { p1: RECKLESS_SWING_COST });
    check("Reckless: the enemy directly ahead is a target", getRecklessSwingTargets(s, pw, "p1").includes(4));
    // Not adjacent = not a target.
    check(
      "Reckless: a distant enemy is not",
      !getRecklessSwingTargets(state("p1", { 0: 5, 4: 9 }), pw, "p1").includes(4),
    );
    // RETIRED 2026-09-17: no longer pierces Bulwark/Vanish either — walls
    // are absolute now, so Reckless Swing lost its one physical-pierce
    // identity along with everything else below an ultimate.
    const pwBul: PowerState = { ...pw, walls: { 4: "bulwark" } };
    check("Reckless: a wall now stops it too (the old pierce retired)", !getRecklessSwingTargets(s, pwBul, "p1").includes(4));
    // Does NOT pierce Ward or a shield tile — never did.
    const pwWard = power({ p1: "barbarian", p2: "mage" }, { p1: RECKLESS_SWING_COST, p2: CHARGE_CAP });
    check("Reckless: a Ward still stops it", !getRecklessSwingTargets(s, pwWard, "p1").includes(4));
    check(
      "Reckless: a shield tile still stops it",
      !getRecklessSwingTargets(state("p1", { 0: 6, 4: 7 }), pw, "p1").includes(4),
    );

    const r = applyRecklessSwing(s, pw, 4, "p1");
    check("Reckless: the victim dies", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Reckless: the swinger is thrown back", r.state.tokens.find((t) => t.id === 0)!.position === 8 - RECKLESS_SELF_KNOCKBACK);
    check("Reckless: reports both halves of the trade", r.swingerTokenId === 0 && r.killedTokenId === 4);
    check("Reckless: spends the mana and earns the capture charge", r.power.charges.p1 === RECKLESS_SWING_COST - 1 + 1);
    check("Reckless: ends the turn", r.state.currentPlayer === "p2");
    // RETIRED 2026-09-17: a BLESSED (walled) victim is no longer a legal
    // target at all — no wound tier left, walls are absolute.
    const pwBless: PowerState = { ...pw, walls: { 4: "blessing" } };
    check("Reckless: a Blessed stone is not a legal target any more", !getRecklessSwingTargets(s, pwBless, "p1").includes(4));
    // Recklessness can genuinely kill you: swinging from tile 1 recoils home.
    const rHome = applyRecklessSwing(state("p1", { 0: 1, 4: 2 }), pw, 4, "p1");
    check("Reckless: a recoil with nowhere to land sends the swinger home", rHome.swingerSentHome === true);
  }

  // --- Whirlwind ----------------------------------------------------------
  {
    // p1 barbarian on 6 and 10; enemies on 5, 7 (in reach) and 11 (also in
    // reach of the stone on 10) and 2 (private lane, out).
    const s = state("p1", { 0: 6, 1: 10, 4: 5, 5: 8, 6: 11, 7: 2 });
    const pw = power({ p1: "barbarian", p2: "archer" }, { p1: WHIRLWIND_COST });
    const pool = getWhirlwindTargets(s, pw, "p1");
    check("Whirlwind: catches enemies within reach of any of your stones", pool.includes(4) && pool.includes(6));
    check("Whirlwind: spares a private-lane enemy", !pool.includes(7));
    check(
      "Whirlwind: nothing offered below the full bank",
      getWhirlwindTargets(s, power({ p1: "barbarian", p2: "archer" }, { p1: WHIRLWIND_COST - 1 }), "p1").length === 0,
    );
    const r = applyWhirlwind(s, pw, "p1");
    check("Whirlwind: captures at most WHIRLWIND_CAP", r.capturedTokenIds.length <= WHIRLWIND_CAP);
    check("Whirlwind: takes the deepest runner first", r.capturedTokenIds[0] === 6);
    check("Whirlwind: shoves whatever it didn't take", r.knockedTokenIds.length > 0);
    check("Whirlwind: the barbarian's own stones never move", r.state.tokens.find((t) => t.id === 0)!.position === 6);
    check("Whirlwind: ends the turn", r.state.currentPlayer === "p2");
  }

  // --- Bloodbath ----------------------------------------------------------
  {
    // p1 barbarian's lead stone on 5; enemies at 6, 8, 10 all ahead of it.
    const s = state("p1", { 0: 5, 4: 6, 5: 8, 6: 10 });
    const pw: PowerState = {
      ...power({ p1: "barbarian", p2: "archer" }),
      ultimateReady: { p1: true, p2: false },
    };
    const path = getBloodbathTargets(s, pw, "p1");
    check("Bloodbath: pools everything ahead of the lead stone", [4, 5, 6].every((id) => path.includes(id)));
    const r = applyBloodbath(s, pw, "p1");
    check("Bloodbath: runs down every one of them — uncapped", r.killedTokenIds.length === 3);
    check("Bloodbath: they all go home", [4, 5, 6].every((id) => r.state.tokens.find((t) => t.id === id)!.position === -1));
    check("Bloodbath: the charge ends at the row's end", r.state.tokens.find((t) => t.id === 0)!.position === BLOODBATH_END_POSITION);
    check("Bloodbath: spends the ultimate", r.power.ultimateReady.p1 === false);
    // Pierces everything, ultimate convention.
    const pwArmoured: PowerState = { ...pw, walls: { 5: "bulwark", 4: "blessing" } };
    const rA = applyBloodbath(s, pwArmoured, "p1");
    check("Bloodbath: pierces a Bulwark and a Blessing alike", rA.killedTokenIds.length === 3);
  }
}

// ---------------------------------------------------------------------------
// BARD (2026-07-27) — Encore / Inspire / Song of Haste / Crescendo
// ---------------------------------------------------------------------------
{
  // --- Encore: the deeper purse and the double zero-flip ------------------
  const pwBard = power({ p1: "bard", p2: "archer" });
  check("Encore: a zero flip pays the bard double", grantZeroFlipCharge(pwBard, "p1").charges.p1 === ENCORE_ZERO_FLIP_CHARGES);
  check("Encore: everyone else still gets one", grantZeroFlipCharge(power({ p1: "archer" }), "p1").charges.p1 === 1);
  check("Encore: the bard's purse runs deeper", chargeCapFor(pwBard, "p1") === BARD_CHARGE_CAP);
  check("Encore: everyone else's does not", chargeCapFor(pwBard, "p2") === CHARGE_CAP);

  // --- Inspire ------------------------------------------------------------
  const sBard = state("p1", { 0: 5, 1: 8, 2: 2, 4: 9 });
  const pwLit = power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST });
  const pool = getInspireTargets(sBard, pwLit, "p1");
  check("Inspire: offers the bard's own on-board stones", pool.includes(0) && pool.includes(1));
  check("Inspire: never an enemy stone", !pool.includes(4));
  check(
    "Inspire: nothing offered below INSPIRE_COST",
    getInspireTargets(sBard, power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST - 1 }), "p1").length === 0,
  );
  const lit1 = applyInspire(pwLit, 0, "p1");
  check("Inspire: spends INSPIRE_COST", lit1.charges.p1 === 0);
  check("Inspire: the stone is lit", isInspired(lit1, 0));
  check("Inspire: an already-lit stone is not re-offered", !getInspireTargets(sBard, { ...lit1, charges: { p1: 4, p2: 0 } }, "p1").includes(0));
  // INSPIRE_CAP closes the pool once enough are burning.
  let capped: PowerState = { ...pwLit, charges: { p1: 4, p2: 0 } };
  for (let i = 0; i < INSPIRE_CAP; i++) capped = applyInspire(capped, i, "p1");
  check("Inspire: the pool closes at INSPIRE_CAP", getInspireTargets(sBard, capped, "p1").length === 0);

  // --- Inspire: the stride bonus, and the exact-escape guard --------------
  {
    const s = state("p1", { 0: 5 });
    const lit = applyInspire(power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST }), 0, "p1");
    const m = getLegalPowerMoves(s, lit, 2).find((x) => x.tokenId === 0);
    check("Inspire: a lit stone strides INSPIRE_BONUS further", m?.to === 5 + 2 + INSPIRE_BONUS);
    const plain = getLegalPowerMoves(s, power({ p1: "bard", p2: "archer" }), 2).find((x) => x.tokenId === 0);
    check("Inspire: an unlit stone strides normally", plain?.to === 7);
    // THE GUARD: a lit stone on 13 must still be able to take the exact
    // step home — the bonus is dropped rather than the move.
    const sEnd = state("p1", { 0: 13 });
    const litEnd = applyInspire(power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST }), 0, "p1");
    const esc = getLegalPowerMoves(sEnd, litEnd, 1).find((x) => x.tokenId === 0);
    check("Inspire: never overshoots the finish — the exact step still escapes", esc?.to === PATH_LENGTH_PER_PLAYER);
  }

  // --- Song of Haste ------------------------------------------------------
  {
    const s = state("p1", { 0: 5, 1: 8, 4: 11 });
    // Enough to light two stones AND still sing: two inspires at
    // INSPIRE_COST each, then HASTE_COST on top.
    let pw = power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST * 2 + HASTE_COST });
    pw = applyInspire(pw, 0, "p1");
    pw = applyInspire(pw, 1, "p1");
    check("Haste: the song's pool is the lit stones", getSongOfHasteTargets(s, pw, "p1").sort().join() === "0,1");
    const r = applySongOfHaste(s, pw, "p1");
    check("Haste: every lit stone marches HASTE_TILES", r.state.tokens.find((t) => t.id === 0)!.position === 5 + HASTE_TILES);
    check("Haste: and the other one too", r.state.tokens.find((t) => t.id === 1)!.position === 8 + HASTE_TILES);
    check("Haste: the inspirations survive the song", isInspired(r.power, 0) && isInspired(r.power, 1));
    check("Haste: ends the turn", r.state.currentPlayer === "p2");
    // An unlit stone stays put.
    check("Haste: an unlit stone doesn't march", !r.movedIds.includes(2));
  }
  {
    // The march CAN escape a stone — the fix that un-stuck the whole class.
    const s = state("p1", { 0: PATH_LENGTH_PER_PLAYER - 1 - HASTE_TILES, 1: 3, 2: 3, 3: 3 });
    let pw = power({ p1: "bard", p2: "archer" }, { p1: INSPIRE_COST + HASTE_COST });
    pw = applyInspire(pw, 0, "p1");
    const r = applySongOfHaste(s, pw, "p1");
    check("Haste: an exact landing escapes the stone", r.state.tokens.find((t) => t.id === 0)!.position === PATH_LENGTH_PER_PLAYER);
  }

  // --- Crescendo ----------------------------------------------------------
  {
    const s = state("p1", { 0: 5, 1: 7, 2: 9, 4: 2 });
    const pw: PowerState = {
      ...power({ p1: "bard", p2: "archer" }),
      ultimateReady: { p1: true, p2: false },
    };
    check("Crescendo: its pool is the whole on-board army", getCrescendoTargets(s, pw, "p1").sort().join() === "0,1,2");
    const r = applyCrescendo(s, pw, "p1");
    check("Crescendo: lights every one of them — past INSPIRE_CAP", [0, 1, 2].every((id) => isInspired(r.power, id)));
    check("Crescendo: and marches them", r.movedIds.length === 3);
    check("Crescendo: spends the ultimate", r.power.ultimateReady.p1 === false);
    check("Crescendo: ends the turn", r.state.currentPlayer === "p2");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("All Master Killer rulebook scenarios pass.");
