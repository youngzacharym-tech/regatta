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
  BULWARK_REINFORCED_SAVES,
  BULWARK_REINFORCED_TURNS,
  BULWARK_TURNS,
  CHARGE_CAP,
  CHARGE_SWEEP_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  CORPSE_EXPLOSION_COST,
  EXHUME_RETURN_POSITION,
  HEAL_COST,
  NECRO_CHARGE_CAP,
  PICKPOCKET_COST,
  PICKPOCKET_STEAL,
  PUSH_DISTANCE,
  PUSH_WARD_COST,
  PUSH_WARD_DISTANCE,
  REFLIPS_PER_TURN,
  REVIVE_COST,
  ROGUE_STEAL_ON_CAPTURE,
  SOUL_BOUNTY_CHARGES,
  THRALL_TURNS,
  ULTIMATE_STREAK,
  VANISH_COST,
  VANISH_TURNS,
  applyBless,
  applyBenediction,
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyCorpseExplosion,
  applyExhume,
  applyGrandHeist,
  applyPickpocket,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyRevive,
  applyVanish,
  applyWarpath,
  breakShieldStreak,
  canReflipAgain,
  consumeBulwarkBlocks,
  effectiveOwner,
  applyHeal,
  getBenedictionTargets,
  getBlessTargets,
  getBlinkStrikeTargets,
  getBulwarkBlockedIds,
  getBulwarkTargets,
  getGrandHeistTargets,
  getHealTargets,
  getChargedShotTargets,
  getCorpseExplosionTargets,
  getExhumeTargets,
  getLegalPowerMoves,
  getPickpocketTargets,
  getPushTargets,
  getRainOfArrowsTargets,
  getReviveSpawnTile,
  getVanishTargets,
  getWarpathTargets,
  grantZeroFlipCharge,
  initialPowerState,
  isWarded,
  resetTurnFlags,
  tickBulwarkExpiry,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickThrallForNewTurn,
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
  // Attacker (p2) is deliberately NOT a warrior here — a warrior is the one
  // class that's SUPPOSED to break through a ward (see the Ward Breaker
  // scenario below); this test isolates the "everyone else stays blocked" half.
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
// 4. Re-flip: spends exactly one charge per use, counts uses, and is capped
//    at REFLIPS_PER_TURN per turn (see canReflipAgain — the shared gate the
//    server's validation, the bot, and the client button all consult)
// ---------------------------------------------------------------------------
{
  const pw = power({ p1: "mage" }, { p1: CHARGE_CAP });
  const after = applyReflip(pw, "p1");
  check("Re-flip: spends exactly one charge", after.charges.p1 === CHARGE_CAP - 1);
  check("Re-flip: increments the per-turn use counter", after.reflipsUsedThisTurn === 1);
  check("Re-flip: does not touch the other player's charges", after.charges.p2 === pw.charges.p2);

  // Second re-flip in the same turn: legal while a second charge is banked.
  check("Re-flip: a SECOND re-flip is offered with a charge still banked", canReflipAgain(after, "p1"));
  const afterSecond = applyReflip(after, "p1");
  check("Re-flip: the second re-flip spends the second charge", afterSecond.charges.p1 === CHARGE_CAP - 2);
  check("Re-flip: the second re-flip counts too", afterSecond.reflipsUsedThisTurn === 2);

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
  check(`Re-flip: sanity — the cap under test is REFLIPS_PER_TURN (${REFLIPS_PER_TURN})`, REFLIPS_PER_TURN === 2);

  // A fresh turn resets the counter (resetTurnFlags is what every
  // turn-ending resolve calls).
  check("Re-flip: a fresh turn resets the use counter", resetTurnFlags(afterSecond).reflipsUsedThisTurn === 0);
}

// ---------------------------------------------------------------------------
// 5. Ward Breaker: breaks a ward and captures — WITHOUT any follow-up
//    protection (the old transient-safety "ward counter" was removed on
//    2026-07-17, Kasen's fix list: it played like an undocumented ward)
// ---------------------------------------------------------------------------
{
  // p1 warrior token 0 at 4; p2 mage token 4 at 6, p2 at full charge (warded).
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "warrior", p2: "mage" }, { p2: CHARGE_CAP });
  const moves = getLegalPowerMoves(s, pw, 2); // 4 -> 6
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
  check("Ward Breaker: landing on a warded enemy is legal for a Warrior", !!m);
  check("Ward Breaker: captures the warded enemy", !!m && m.captures.includes(4));
  check("Ward Breaker: flags breaksWard", !!m && m.breaksWard === true);

  const r1 = applyPowerMove(s, pw, m!, "p1");
  // REGRESSION (safety removal): the Warrior's landing token must be
  // capturable right back on the opponent's next turn — no lingering
  // protection of any kind. p2's remaining mage token at 4 flips a 2 onto
  // the Warrior now sitting at 6 (contested — same physical tile).
  const s2: GameState = {
    ...r1.state,
    tokens: r1.state.tokens.map((t) => (t.id === 5 ? { ...t, position: 4 } : t)),
  };
  const movesBack = getLegalPowerMoves(s2, r1.power, 2); // p2's turn after the capture
  const mBack = movesBack.find((mv) => mv.tokenId === 5 && mv.to === 6);
  check(
    "Ward Breaker: the capturing Warrior gains NO protection — it can be captured right back",
    !!mBack && mBack.captures.includes(0),
    JSON.stringify(movesBack),
  );
}

// ---------------------------------------------------------------------------
// 6. Charge: sweeps intermediate captures (including warded ones — the
//    sweep pierces Ward same as Ward Breaker), stops at shield tiles,
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

  // A warded intermediate enemy IS swept — Ward Breaker's whole identity
  // is "Warriors pierce Ward," so the sweep shouldn't quietly disagree with
  // that just because the token is mid-lane instead of the landing tile.
  const sWard = state("p1", { 0: 4, 4: 6 });
  const pwWard = power({ p1: "warrior", p2: "mage" }, { p1: 1, p2: CHARGE_CAP });
  const movesWard = getLegalPowerMoves(sWard, pwWard, 4);
  const mWard = movesWard.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: DOES sweep a warded intermediate enemy",
    !!mWard && mWard.chargeSweepCaptures.includes(4),
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
// 9. Push vs Ward: Archer can target a warded token (costs PUSH_WARD_COST,
//    same as a normal push) and knocks it back PUSH_WARD_DISTANCE instead
//    of PUSH_DISTANCE — same price, bigger effect.
// ---------------------------------------------------------------------------
{
  // p2 mage's only on-board token (id4) is trivially most-advanced -> warded.
  const s = state("p1", { 4: 6 });

  const pwPoor = power({ p1: "archer", p2: "mage" }, { p1: PUSH_WARD_COST - 1, p2: CHARGE_CAP });
  check(
    "Push: a warded target is NOT offered when the Archer can't afford PUSH_WARD_COST",
    !getPushTargets(s, pwPoor, "p1").includes(4),
  );

  const pwRich = power({ p1: "archer", p2: "mage" }, { p1: PUSH_WARD_COST, p2: CHARGE_CAP });
  check(
    "Push: a warded target IS offered once the Archer can afford PUSH_WARD_COST",
    getPushTargets(s, pwRich, "p1").includes(4),
  );

  const r = applyPush(s, pwRich, 4, "p1");
  check(
    "Push: costs PUSH_WARD_COST against a warded target, not 1",
    r.power.charges.p1 === PUSH_WARD_COST - PUSH_WARD_COST,
    `left with ${r.power.charges.p1} charges`,
  );

  // Soft push (no collision): a warded target travels PUSH_WARD_DISTANCE,
  // not PUSH_DISTANCE. Here it's still the mage's only on-board token
  // afterward, so it's STILL most-advanced/warded — a non-collision push
  // doesn't strip Ward by itself, it just costs (more) tempo now.
  const sSoft = state("p1", { 4: 8, 5: 3 }); // id4 most-advanced/warded; id5 far behind
  const rSoft = applyPush(sSoft, pwRich, 4, "p1");
  const movedSoft = rSoft.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: a warded target travels PUSH_WARD_DISTANCE, not PUSH_DISTANCE",
    movedSoft.position === 8 - PUSH_WARD_DISTANCE,
    `landed at ${movedSoft.position}`,
  );
  check(
    "Push: a soft push against a warded token can still land it as most-advanced -> still warded",
    isWarded(rSoft.state, rSoft.power, movedSoft),
  );

  // The bigger knockback's real payoff: even WITHOUT a collision, a warded
  // token near the front of the contested zone can be shoved clean out of
  // it and back into its own private lane (tile 3) — forcing it to
  // re-cross the entire 8-tile contested zone again, not just lose a step.
  const sBoundary = state("p1", { 4: 5 }); // id4 alone on board, warded, at the 2nd contested tile
  const rBoundary = applyPush(sBoundary, pwRich, 4, "p1");
  const movedBoundary = rBoundary.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: PUSH_WARD_DISTANCE can knock a warded token clean out of the contested zone",
    movedBoundary.position === 5 - PUSH_WARD_DISTANCE,
    `landed at ${movedBoundary.position}`,
  );

  // Collision push: id4 (warded) is knocked into id5 (same owner) and bounces
  // to reserve — Ward is now permanently gone from id4 (reserved tokens are
  // never warded) and fully hands off to id5, the mage's only remaining
  // on-board token. This is the real, hard answer to a lone warded rusher.
  const sHard = state("p1", { 4: 6, 5: 6 - PUSH_WARD_DISTANCE }); // id4 warded @6; id5 sits at the push's landing tile
  check("Push: sanity — id4 is warded before the push", isWarded(sHard, pwRich, sHard.tokens.find((t) => t.id === 4)!));
  const rHard = applyPush(sHard, pwRich, 4, "p1");
  const movedHard = rHard.state.tokens.find((t) => t.id === 4)!;
  const survivor = rHard.state.tokens.find((t) => t.id === 5)!;
  check("Push: a warded token can be knocked to reserve just like any other target", movedHard.position === -1);
  check("Push: a reserved token is never warded, even freshly post-push", !isWarded(rHard.state, rHard.power, movedHard));
  check(
    "Push: Ward fully hands off to the mage's remaining on-board token once the warded one is reserved",
    isWarded(rHard.state, rHard.power, survivor),
  );
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
// 12. Ultimates: 3 consecutive shield landings in one unbroken turn-chain.
//     Archer's Rain of Arrows fires immediately; Mage/Warrior instead bank
//     ultimateReady for a not-yet-built active ability.
// ---------------------------------------------------------------------------
{
  const seed = (n: number) => (pw: PowerState) => ({ ...pw, shieldStreak: { ...pw.shieldStreak, p1: n } });

  // Fires exactly on the 3rd consecutive landing — not the 2nd, not the 4th.
  const pwArcher2 = seed(2)(power({ p1: "archer" }));
  const s1 = state("p1", { 0: 6, 4: 9 }); // token0 6->7 (shield); enemy4 alone at 9 (contested)
  const m1 = getLegalPowerMoves(s1, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Ultimate: move to a shield tile is legal and available for this fixture", !!m1);
  const r1 = applyPowerMove(s1, pwArcher2, m1, "p1", () => 0);
  check("Ultimate: fires Rain of Arrows on the 3rd consecutive shield landing", r1.rainOfArrows?.targetTokenId === 4);
  check("Ultimate: streak resets to 0 once it fires", r1.power.shieldStreak.p1 === 0);
  check(
    "Ultimate: a successful Rain of Arrows hit grants a charge, like any other capture",
    r1.power.charges.p1 === 1,
    `got ${r1.power.charges.p1}`,
  );

  // 1st and 2nd landings accumulate without firing.
  const pwArcher0 = power({ p1: "archer" });
  const r0 = applyPowerMove(s1, pwArcher0, m1, "p1", () => 0);
  check("Ultimate: 1st landing accumulates without firing", r0.rainOfArrows === null && r0.power.shieldStreak.p1 === 1);
  const pwArcher1 = seed(1)(power({ p1: "archer" }));
  const rMid = applyPowerMove(s1, pwArcher1, m1, "p1", () => 0);
  check(
    "Ultimate: 2nd landing accumulates without firing",
    rMid.rainOfArrows === null && rMid.power.shieldStreak.p1 === 2,
  );

  // Bypasses shield-tile protection: the sole eligible candidate sits ON a
  // shield tile (7, contested) while the Archer's own landing is elsewhere
  // (13, the private-lane shield) — Rain of Arrows can still pick it.
  const sShieldTarget = state("p1", { 0: 12, 4: 7 }); // token0 12->13 (shield); enemy4 ON shield tile 7
  const mShield = getLegalPowerMoves(sShieldTarget, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 13)!;
  check("Ultimate: sanity — enemy candidate really is on a shield tile", BOARD_LAYOUT[7].type === "shield");
  const rShield = applyPowerMove(sShieldTarget, pwArcher2, mShield, "p1", () => 0);
  check(
    "Ultimate: Rain of Arrows bypasses shield-tile protection for its target",
    rShield.rainOfArrows?.targetTokenId === 4,
  );

  // Bypasses Ward: the sole eligible candidate is a maxed Mage's warded token.
  const pwVsMage2 = seed(2)(power({ p1: "archer", p2: "mage" }, { p2: CHARGE_CAP }));
  const mageEnemy = s1.tokens.find((t) => t.id === 4)!;
  check("Ultimate: sanity — the candidate really is warded", isWarded(s1, pwVsMage2, mageEnemy));
  const rWard = applyPowerMove(s1, pwVsMage2, m1, "p1", () => 0);
  check("Ultimate: Rain of Arrows bypasses Ward for its target", rWard.rainOfArrows?.targetTokenId === 4);

  // Empty pool entirely (no enemies anywhere): a clean whiff — streak still
  // consumed (not a silent no-op), and no phantom charge beyond the
  // ordinary landsOnShield grant.
  const sEmpty = state("p1", { 0: 6 });
  const mEmpty = getLegalPowerMoves(sEmpty, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rEmpty = applyPowerMove(sEmpty, pwArcher2, mEmpty, "p1", () => 0);
  check("Ultimate: whiffs cleanly with no enemies on the board at all", rEmpty.rainOfArrows?.targetTokenId === null);
  check("Ultimate: streak still resets to 0 on a whiff", rEmpty.power.shieldStreak.p1 === 0);
  check(
    "Ultimate: an empty-pool whiff still only grants the ordinary shield-landing charge",
    rEmpty.power.charges.p1 === 1,
    `got ${rEmpty.power.charges.p1}`,
  );

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
  const afterReflip = applyReflip(pwArcher2, "p1");
  check("Ultimate: Re-flip leaves the streak untouched", afterReflip.shieldStreak.p1 === 2);

  // Uniform-random selection spans the full candidate pool under
  // deterministic rand stand-ins: first, middle, and last. Enemies sit at
  // 9,10,11 (not 8 = to+1) specifically so Snipe doesn't ALSO fire on this
  // same shield-landing move and exclude one of them from the pool.
  const sPool = state("p1", { 0: 6, 4: 9, 5: 10, 6: 11 }); // token0 6->7 (shield); 3 enemies at 9,10,11
  const mPool = getLegalPowerMoves(sPool, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Ultimate: sanity — Snipe does not also fire on this move", mPool.bonusCaptures.length === 0);
  const pool = getRainOfArrowsTargets(sPool, pwArcher2, "p1");
  check("Ultimate: sanity — the candidate pool has all 3 enemies in id order", JSON.stringify(pool) === JSON.stringify([4, 5, 6]));
  const rFirst = applyPowerMove(sPool, pwArcher2, mPool, "p1", () => 0);
  const rMidPool = applyPowerMove(sPool, pwArcher2, mPool, "p1", () => 0.4);
  const rLast = applyPowerMove(sPool, pwArcher2, mPool, "p1", () => 0.999999);
  check("Ultimate: rand=0 picks the first pool candidate", rFirst.rainOfArrows?.targetTokenId === 4);
  check("Ultimate: rand=0.4 picks the middle pool candidate", rMidPool.rainOfArrows?.targetTokenId === 5);
  check("Ultimate: rand near 1 picks the last pool candidate", rLast.rainOfArrows?.targetTokenId === 6);

  // Never double-captures a token this same move already captured via Snipe.
  const sSnipe = state("p1", { 0: 6, 4: 8 }); // token0 6->7 (shield); Snipe should hit enemy4 at 8 (to+1)
  const mSnipe = getLegalPowerMoves(sSnipe, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Ultimate: sanity — Snipe fires on this same shield-landing move", mSnipe.bonusCaptures.includes(4));
  const rSnipe = applyPowerMove(sSnipe, pwArcher2, mSnipe, "p1", () => 0);
  check(
    "Ultimate: does not re-target a token this same move already captured via Snipe",
    rSnipe.rainOfArrows?.targetTokenId === null,
  );

  // Mage/Warrior completing the combo bank ultimateReady instead of firing
  // Rain of Arrows — no capture, no rainOfArrows signal either way.
  const pwMage2 = seed(2)(power({ p1: "mage" }));
  const mMage = getLegalPowerMoves(s1, pwMage2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rMage = applyPowerMove(s1, pwMage2, mMage, "p1", () => 0);
  check(
    "Ultimate: Mage completing the combo banks ultimateReady, not Rain of Arrows",
    rMage.rainOfArrows === null && rMage.power.ultimateReady.p1 === true && rMage.power.shieldStreak.p1 === 0,
  );
  const pwWarrior2 = seed(2)(power({ p1: "warrior" }));
  const mWarrior = getLegalPowerMoves(s1, pwWarrior2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rWarrior = applyPowerMove(s1, pwWarrior2, mWarrior, "p1", () => 0);
  check(
    "Ultimate: Warrior completing the combo banks ultimateReady, not Rain of Arrows",
    rWarrior.rainOfArrows === null && rWarrior.power.ultimateReady.p1 === true && rWarrior.power.shieldStreak.p1 === 0,
  );

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
//     power action, the mover taps ONE OF THEIR OWN on-board tokens. Full
//     immunity to a normal capture/Snipe and a Charge sweep (folded into
//     isProtected/isBulwarked); a Push can still knock it around, just
//     never send it all the way home; every ultimate — Rain of Arrows,
//     Blink Strike, AND Warpath — punches straight through it (2026-07-17,
//     Kasen's fix list dropped the old Bulwark-blocks-ultimates rule).
//     Expires after BULWARK_TURNS of the Bulwarked player's own turns, OR
//     the instant it actually blocks something, whichever comes first.
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

    const pwBulwarked: PowerState = { ...pw, bulwarked: { 0: 2 } };
    check(
      "Bulwark: an already-Bulwarked token is excluded from re-targeting",
      !getBulwarkTargets(s, pwBulwarked, "p1").includes(0),
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
      "Bulwark: flags the target with BULWARK_TURNS remaining",
      r.power.bulwarked[0] === BULWARK_TURNS,
      `got ${JSON.stringify(r.power.bulwarked)}`,
    );
    check("Bulwark: ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
  }

  // --- Blocks a normal capturing move -------------------------------------
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "archer", p2: "warrior" }), bulwarked: { 4: 3 } };
    const moves = getLegalPowerMoves(s, pw, 2); // token0: 4 -> 6
    const blocked = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check("Bulwark: blocks a normal capturing move onto the Bulwarked token", blocked === undefined, JSON.stringify(moves));

    // Sanity: the exact same setup captures fine without Bulwark.
    const pwNo = power({ p1: "archer", p2: "warrior" });
    const movesNo = getLegalPowerMoves(s, pwNo, 2);
    const openMove = movesNo.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check(
      "Bulwark: sanity — the same move captures normally without Bulwark",
      !!openMove && openMove.captures.includes(4),
    );
  }

  // --- Blocks a Charge sweep -----------------------------------------------
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "warrior" }, { p1: 1 }), bulwarked: { 4: 3 } };
    const moves = getLegalPowerMoves(s, pw, 4); // token0: 4 -> 8, enemy4 mid-lane at 6
    const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 8);
    check("Bulwark: Charge is still available (lane clear)", !!m && m.chargeAvailable === true, JSON.stringify(m));
    check(
      "Bulwark: blocks the Charge sweep capture of the Bulwarked token",
      !!m && !m.chargeSweepCaptures.includes(4),
      JSON.stringify(m),
    );
  }

  // --- Blink Strike pierces Bulwark (2026-07-17) ---------------------------
  {
    const s = state("p1", { 0: 5, 4: 8 });
    const base = power({ p1: "mage" });
    const pw: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    const targets = getBlinkStrikeTargets(s, pw, "p1");
    check("Bulwark: a Bulwarked token IS a legal Blink Strike target (ultimates pierce)", targets.includes(4), JSON.stringify(targets));

    const r = applyBlinkStrike(s, pw, 4, "p1");
    check("Bulwark: Blink Strike captures the Bulwarked token", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    // Leak regression (same bug class as the old Rain of Arrows fix): the
    // captured token's Bulwark entry must not survive the trip to reserve.
    check(
      "Bulwark: Blink Strike clears the captured token's bulwarked entry",
      r.power.bulwarked[4] === undefined,
      JSON.stringify(r.power.bulwarked),
    );
  }

  // --- Warpath pierces Bulwark too (primary target AND swept tokens) -------
  {
    const sTarget = state("p1", { 0: 4, 4: 9 });
    const baseW = power({ p1: "warrior" });
    const pwTarget: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    check(
      "Bulwark: a Bulwarked token IS a legal Warpath primary target (ultimates pierce)",
      getWarpathTargets(sTarget, pwTarget, "p1").includes(4),
    );

    // Sweep victim Bulwarked (the primary target itself is unprotected) —
    // the sweep takes it anyway, and its Bulwark entry clears with it.
    const sSweep = state("p1", { 0: 4, 4: 6, 5: 9 }); // mover token0 at 4; enemy4 at 6 (between, Bulwarked); target enemy5 at 9
    const pwSweep: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    const r = applyWarpath(sSweep, pwSweep, 5, "p1");
    check("Bulwark: a Bulwarked token in Warpath's path IS swept", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    check("Bulwark: the swept Bulwarked id appears in sweptTokenIds", r.sweptTokenIds.includes(4));
    check("Bulwark: the primary target is still captured", r.state.tokens.find((t) => t.id === 5)!.position === -1);
    check(
      "Bulwark: Warpath clears the swept token's bulwarked entry",
      r.power.bulwarked[4] === undefined,
      JSON.stringify(r.power.bulwarked),
    );
  }

  // --- Rain of Arrows pierces Bulwark (always has) --------------------------
  {
    const s = state("p1", { 0: 6, 4: 9 }); // token0 6->7 (shield); sole candidate enemy4 at 9, Bulwarked
    const seeded: PowerState = {
      ...power({ p1: "archer" }),
      shieldStreak: { p1: 2, p2: 0 },
      bulwarked: { 4: 3 },
    };
    const m = getLegalPowerMoves(s, seeded, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
    const r = applyPowerMove(s, seeded, m, "p1", () => 0);
    check(
      "Bulwark: Rain of Arrows bypasses Bulwark (same rule as every ultimate now)",
      r.rainOfArrows?.targetTokenId === 4,
    );
  }

  // --- Push: soft knockback still lands, send-home is blocked ---------------
  {
    const sSoft = state("p1", { 4: 8 }); // p2's only on-board token, alone -> no collision
    const pw: PowerState = { ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }), bulwarked: { 4: 3 } };
    check("Bulwark: a soft (non-home) push target IS legal", getPushTargets(sSoft, pw, "p1").includes(4));
    const rSoft = applyPush(sSoft, pw, 4, "p1");
    const moved = rSoft.state.tokens.find((t) => t.id === 4)!;
    check(
      "Bulwark: a soft push against a Bulwarked token still knocks it back PUSH_DISTANCE",
      moved.position === 8 - PUSH_DISTANCE,
      `landed at ${moved.position}`,
    );

    const sHome = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE }); // own-token collision at the landing tile
    const pwHome: PowerState = { ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }), bulwarked: { 4: 3 } };
    check("Bulwark: a send-home push target is NOT legal", !getPushTargets(sHome, pwHome, "p1").includes(4));

    const pwNoBulwark = power({ p1: "archer", p2: "warrior" }, { p1: 1 });
    check(
      "Bulwark: sanity — the identical send-home push IS legal without Bulwark",
      getPushTargets(sHome, pwNoBulwark, "p1").includes(4),
    );
  }

  // --- Expiry countdown ------------------------------------------------------
  {
    const s = state("p1", { 0: 4 });

    const pwOne: PowerState = { ...power({ p1: "warrior" }), bulwarked: { 0: 1 } };
    check(
      "Bulwark: expires (clears) once its countdown reaches 0",
      tickBulwarkExpiry(s, pwOne, "p1").bulwarked[0] === undefined,
    );

    const pwTwo: PowerState = { ...power({ p1: "warrior" }), bulwarked: { 0: 2 } };
    const afterTick = tickBulwarkExpiry(s, pwTwo, "p1");
    check("Bulwark: decrements by exactly 1 per tick when not yet expiring", afterTick.bulwarked[0] === 1, `got ${afterTick.bulwarked[0]}`);

    // Ticking a DIFFERENT player's turn-start must not touch this token.
    const afterOtherTick = tickBulwarkExpiry(s, pwTwo, "p2");
    check("Bulwark: ticking the OTHER player's turn leaves this token's countdown untouched", afterOtherTick.bulwarked[0] === 2);

    // A full BULWARK_TURNS-tick countdown lands exactly at expiry, not off-by-one.
    let running: PowerState = { ...power({ p1: "warrior" }), bulwarked: { 0: BULWARK_TURNS } };
    for (let i = 0; i < BULWARK_TURNS; i++) running = tickBulwarkExpiry(s, running, "p1");
    check(
      `Bulwark: expires after exactly BULWARK_TURNS (${BULWARK_TURNS}) of the Bulwarked player's own turns`,
      running.bulwarked[0] === undefined,
    );
  }

  // --- Consumed the instant it blocks something -----------------------------
  {
    // A normal move that WOULD capture this exact flip -> reported, and
    // consuming clears the flag (computed by diffing real vs Bulwark-off
    // move lists — see getBulwarkBlockedIds's doc comment).
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "warrior", p2: "warrior" }), bulwarked: { 4: 3 } };
    const blocked = getBulwarkBlockedIds(s, pw, 2); // token0: 4 -> 6, would capture 4
    check("Bulwark: getBulwarkBlockedIds reports the token this flip would have captured", blocked.includes(4), JSON.stringify(blocked));
    check("Bulwark: consumeBulwarkBlocks clears the flag", consumeBulwarkBlocks(pw, blocked).bulwarked[4] === undefined);
    check("Bulwark: consumeBulwarkBlocks is a no-op given an empty list", consumeBulwarkBlocks(pw, []) === pw);

    // tickBulwarkForNewTurn does tick-then-consume in one call, for the
    // ATTACKER's fresh-flip hook (referee.ts/api/ws.ts call this once per
    // turn-start).
    const combo = tickBulwarkForNewTurn(s, pw, 2);
    check("Bulwark: tickBulwarkForNewTurn reports the same blocked id", combo.blockedIds.includes(4));
    check("Bulwark: tickBulwarkForNewTurn's returned power has it cleared", combo.power.bulwarked[4] === undefined);

    // An unrelated flip (can't reach the Bulwarked token at all) leaves it untouched.
    const sFar = state("p1", { 0: 0, 4: 6 });
    const pwFar: PowerState = { ...power({ p1: "warrior", p2: "warrior" }), bulwarked: { 4: 3 } };
    const comboFar = tickBulwarkForNewTurn(sFar, pwFar, 1);
    check(
      "Bulwark: an unrelated flip does not consume an untouched Bulwark",
      comboFar.power.bulwarked[4] === 3,
      JSON.stringify(comboFar.power.bulwarked),
    );

    // Re-flip's own hook detects a block too, without an extra expiry tick
    // (tickBulwarkForReflip never touches the countdown, only consumption).
    const comboReflip = tickBulwarkForReflip(s, pw, 2);
    check("Bulwark: tickBulwarkForReflip also detects and consumes a block", comboReflip.power.bulwarked[4] === undefined);

    // Charge-sweep-only threat: doesn't count as "blocked" unless the mover
    // can actually afford to spend a charge on Charge this turn.
    const sSweepOnly = state("p1", { 0: 4, 4: 6 }); // token0: 4 -> 8 (flip 4); enemy4 mid-lane at 6 only
    const pwSweepNoCharge: PowerState = {
      ...power({ p1: "warrior", p2: "warrior" }, { p1: 0 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a Charge-sweep-only threat is NOT 'blocked' when the mover has 0 charges",
      !getBulwarkBlockedIds(sSweepOnly, pwSweepNoCharge, 4).includes(4),
    );
    const pwSweepWithCharge: PowerState = {
      ...power({ p1: "warrior", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a Charge-sweep threat DOES count as blocked once the mover can afford Charge",
      getBulwarkBlockedIds(sSweepOnly, pwSweepWithCharge, 4).includes(4),
    );

    // Send-home Push immunity is a STATIC property, never a save-consuming
    // "block" (2026-07-20, Kasen's field report — the old reveal-time
    // accounting let a full-bank archer melt a Reinforced Bulwark by
    // standing in range; see getBulwarkBlockedIds's doc). The target simply
    // never enters the pool, and no save is spent at any charge level.
    const sPushOnly = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE }); // p2 token4 Bulwarked; own-token collision at the landing tile
    const pwPushWithCharge: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: send-home Push immunity keeps the target out of the pool",
      !getPushTargets(sPushOnly, pwPushWithCharge, "p1").includes(4),
    );
    check(
      "Bulwark: send-home Push immunity is static — never a save-consuming block",
      !getBulwarkBlockedIds(sPushOnly, pwPushWithCharge, 1).includes(4),
    );
  }
}

// ---------------------------------------------------------------------------
// 14b. Reinforced Bulwark: the Warrior's full-bank (CHARGE_CAP) cast —
//      everything about the plain Bulwark doubled: 2x cost, 2x lifetime
//      (BULWARK_REINFORCED_TURNS), 2x saves (BULWARK_REINFORCED_SAVES).
//      Same target pool, same protection semantics while up (isBulwarked
//      doesn't distinguish), same turn-ending cast — only cost, countdown,
//      and how consumption resolves differ.
// ---------------------------------------------------------------------------
{
  // --- The cast: cost, countdown, saves, turn end ---------------------------
  {
    const s = state("p1", { 0: 5 });
    const pw = power({ p1: "warrior" }, { p1: CHARGE_CAP });
    const r = applyBulwark(s, pw, 0, "p1", true);
    check("Reinforced Bulwark: spends the FULL bank (CHARGE_CAP charges)", r.power.charges.p1 === 0, `got ${r.power.charges.p1}`);
    check(
      "Reinforced Bulwark: flags the target with BULWARK_REINFORCED_TURNS remaining",
      r.power.bulwarked[0] === BULWARK_REINFORCED_TURNS,
      `got ${JSON.stringify(r.power.bulwarked)}`,
    );
    check(
      "Reinforced Bulwark: banks BULWARK_REINFORCED_SAVES capture-blocks",
      r.power.bulwarkSaves[0] === BULWARK_REINFORCED_SAVES,
      `got ${JSON.stringify(r.power.bulwarkSaves)}`,
    );
    check("Reinforced Bulwark: ends the turn, same as the plain cast", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
    check(
      "Reinforced Bulwark: sanity — the doubling is real (2x turns, 2x saves vs plain)",
      BULWARK_REINFORCED_TURNS === 2 * BULWARK_TURNS && BULWARK_REINFORCED_SAVES === 2,
    );

    // The plain cast stays byte-identical: 1 charge, BULWARK_TURNS, NO
    // bulwarkSaves entry (a missing entry means "1 block" everywhere).
    const rPlain = applyBulwark(s, pw, 0, "p1");
    check("Reinforced Bulwark: a plain cast still spends exactly one charge", rPlain.power.charges.p1 === CHARGE_CAP - 1);
    check("Reinforced Bulwark: a plain cast still lasts BULWARK_TURNS", rPlain.power.bulwarked[0] === BULWARK_TURNS);
    check(
      "Reinforced Bulwark: a plain cast writes NO bulwarkSaves entry",
      rPlain.power.bulwarkSaves[0] === undefined,
      JSON.stringify(rPlain.power.bulwarkSaves),
    );

    // Already-Bulwarked tokens stay excluded from re-targeting, reinforced
    // or not — no stacking a reinforcement onto a live Bulwark.
    check(
      "Reinforced Bulwark: a reinforced token is excluded from re-targeting",
      !getBulwarkTargets(r.state, r.power, "p1").includes(0),
    );
  }

  // --- Consumption: survives its first save, fades on the second ------------
  {
    // p2's token 4 is reinforced-Bulwarked; p1's flip would capture it.
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = {
      ...power({ p1: "warrior", p2: "warrior" }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    const blocked = getBulwarkBlockedIds(s, pw, 2); // token0: 4 -> 6 would capture 4
    check("Reinforced Bulwark: a blocked capture is reported, same as plain", blocked.includes(4), JSON.stringify(blocked));

    const afterFirst = consumeBulwarkBlocks(pw, blocked);
    check(
      "Reinforced Bulwark: SURVIVES its first save — bulwarked entry stays",
      afterFirst.bulwarked[4] === BULWARK_REINFORCED_TURNS,
      JSON.stringify(afterFirst.bulwarked),
    );
    check(
      "Reinforced Bulwark: the first save spends one banked block",
      afterFirst.bulwarkSaves[4] === BULWARK_REINFORCED_SAVES - 1,
      JSON.stringify(afterFirst.bulwarkSaves),
    );
    // A Bulwark-blocked landing is dropped from the move list entirely
    // (getLegalPowerMoves `continue`s on it) — so "still protecting" means
    // no move capturing token 4 exists, same assertion shape section 14
    // uses for the plain cast.
    check(
      "Reinforced Bulwark: still protecting after the first save (capture still illegal)",
      getLegalPowerMoves(s, afterFirst, 2).find((m) => m.captures.includes(4)) === undefined,
    );

    const afterSecond = consumeBulwarkBlocks(afterFirst, [4]);
    check("Reinforced Bulwark: fades on its second save — bulwarked entry cleared", afterSecond.bulwarked[4] === undefined);
    check("Reinforced Bulwark: the spent saves entry is cleared with it", afterSecond.bulwarkSaves[4] === undefined);

    // A PLAIN Bulwark (no saves entry) is still consumed by its first block.
    const pwPlain: PowerState = { ...power({ p1: "warrior", p2: "warrior" }), bulwarked: { 4: BULWARK_TURNS } };
    const afterPlain = consumeBulwarkBlocks(pwPlain, [4]);
    check("Reinforced Bulwark: a plain Bulwark is still consumed by its FIRST block", afterPlain.bulwarked[4] === undefined);
  }

  // --- Expiry: the countdown clears the unused saves with it ----------------
  {
    const s = state("p1", { 0: 5 });
    const pwOne: PowerState = {
      ...power({ p1: "warrior" }),
      bulwarked: { 0: 1 },
      bulwarkSaves: { 0: BULWARK_REINFORCED_SAVES },
    };
    const expired = tickBulwarkExpiry(s, pwOne, "p1");
    check("Reinforced Bulwark: expiry clears the bulwarked entry", expired.bulwarked[0] === undefined);
    check("Reinforced Bulwark: expiry clears the unused saves entry too", expired.bulwarkSaves[0] === undefined);

    // A full BULWARK_REINFORCED_TURNS countdown lands exactly at expiry.
    let running: PowerState = {
      ...power({ p1: "warrior" }),
      bulwarked: { 0: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 0: BULWARK_REINFORCED_SAVES },
    };
    for (let i = 0; i < BULWARK_REINFORCED_TURNS; i++) running = tickBulwarkExpiry(s, running, "p1");
    check(
      `Reinforced Bulwark: expires after exactly BULWARK_REINFORCED_TURNS (${BULWARK_REINFORCED_TURNS}) of the caster's own turns`,
      running.bulwarked[0] === undefined && running.bulwarkSaves[0] === undefined,
    );
  }

  // --- Protection semantics while up (2026-07-17, Kasen's fix list) --------
  {
    // Ultimates pierce a reinforced Bulwark same as a plain one...
    const base = power({ p1: "mage", p2: "warrior" }, { p1: 0 });
    const s = state("p1", { 0: 8, 4: 6 });
    const pwUlt: PowerState = {
      ...base,
      ultimateReady: { ...base.ultimateReady, p1: true },
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check(
      "Reinforced Bulwark: IS a legal Blink Strike target (ultimates pierce, plain or reinforced)",
      getBlinkStrikeTargets(s, pwUlt, "p1").includes(4),
    );

    // ...but a plain Push can't touch it AT ALL — not even the soft shove a
    // plain Bulwark still allows. This is fix 1 from the 2026-07-17 list:
    // "archer's push doesn't affect reinforced bulwark."
    const sSoft = state("p1", { 0: 4, 4: 8 }); // push 8 -> 7 would be a clean soft shove
    const pwSoft: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check("Reinforced Bulwark: NOT a legal Push target, even for a soft shove", !getPushTargets(sSoft, pwSoft, "p1").includes(4));
    // Sanity: the same soft shove IS legal against a merely-plain Bulwark.
    const pwPlain: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: BULWARK_TURNS },
    };
    check("Reinforced Bulwark: sanity — the same soft Push IS legal against a plain Bulwark", getPushTargets(sSoft, pwPlain, "p1").includes(4));

    const sHome = state("p1", { 4: 0 }); // push 0 -> -1: send-home
    const pwHome: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check("Reinforced Bulwark: a send-home Push target is still NOT legal", !getPushTargets(sHome, pwHome, "p1").includes(4));

    // "Charged shot moves reinforced bulwark back": the soft Charged Shot
    // IS still legal against a reinforced Bulwark — it's the one Archer
    // tool that reaches it — while a send-home Charged Shot stays blocked.
    const sShotSoft = state("p1", { 4: 11 }); // 11 - CHARGED_SHOT_DISTANCE = 7, on-board, no collision
    const pwShot: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check(
      "Reinforced Bulwark: a soft Charged Shot IS legal — the tool that still moves it",
      getChargedShotTargets(sShotSoft, pwShot, "p1").includes(4),
    );
    const rShot = applyChargedShot(sShotSoft, pwShot, 4, "p1");
    check(
      `Reinforced Bulwark: the Charged Shot knocks it back CHARGED_SHOT_DISTANCE (${CHARGED_SHOT_DISTANCE})`,
      rShot.state.tokens.find((t) => t.id === 4)!.position === 11 - CHARGED_SHOT_DISTANCE,
      `landed at ${rShot.state.tokens.find((t) => t.id === 4)!.position}`,
    );
    check(
      "Reinforced Bulwark: the Bulwark survives the soft Charged Shot (no capture happened)",
      rShot.power.bulwarked[4] !== undefined && rShot.power.bulwarkSaves[4] === BULWARK_REINFORCED_SAVES,
    );
    // Target at contested 6; its landing (6 - CHARGED_SHOT_DISTANCE = 2, its
    // own lane) is occupied by its own teammate -> collision -> send-home.
    const sShotHome = state("p1", { 4: 6, 5: 6 - CHARGED_SHOT_DISTANCE });
    const pwShotHome: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check(
      "Reinforced Bulwark: a send-home Charged Shot is still NOT legal",
      !getChargedShotTargets(sShotHome, pwShotHome, "p1").includes(4),
    );
  }

  // --- Rain of Arrows still pierces, and a reserve trip clears the saves ----
  {
    // Same judgment-call fixture as section 14's Rain of Arrows check, with
    // a REINFORCED Bulwark on the sole candidate: the ultimate still
    // punches through, and the captured token's bulwarked AND bulwarkSaves
    // entries must both clear (no free re-entry protection later).
    const s = state("p1", { 0: 6, 4: 9 }); // token0 6->7 (shield); sole candidate enemy4 at 9
    const base = power({ p1: "archer", p2: "warrior" });
    const pw: PowerState = {
      ...base,
      shieldStreak: { ...base.shieldStreak, p1: ULTIMATE_STREAK - 1 },
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    const move = getLegalPowerMoves(s, pw, 1).find((m) => m.tokenId === 0 && m.landsOnShield)!;
    const r = applyPowerMove(s, pw, move, "p1", () => 0);
    check(
      "Reinforced Bulwark: Rain of Arrows still bypasses it (same judgment call as plain)",
      r.rainOfArrows?.targetTokenId === 4 && r.state.tokens.find((t) => t.id === 4)!.position === -1,
      JSON.stringify(r.rainOfArrows),
    );
    check("Reinforced Bulwark: the captured token's bulwarked entry is cleared", r.power.bulwarked[4] === undefined);
    check("Reinforced Bulwark: the captured token's saves entry is cleared with it", r.power.bulwarkSaves[4] === undefined);
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
  // --- Legality: gated on charges === CHARGE_CAP --------------------------
  {
    const s = state("p1", { 4: 8 }); // enemy alone on a contested tile
    const pwBelow = power({ p1: "archer" }, { p1: CHARGE_CAP - 1 });
    check(
      "Charged Shot: no targets offered below the full charge cap",
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

  // --- Legality: Bulwark blocks a target ONLY if THIS distance would send
  //     it home — using Charged Shot's OWN collision math, not Push's -----
  {
    // Soft knockback: no collision at CHARGED_SHOT_DISTANCE, target stays on
    // the board -> Bulwark does NOT block it (same "soft push" carve-out as
    // Push's own Bulwark interaction, just computed with this ability's own
    // distance).
    const posSoft = 11; // contested-zone ceiling — landing at posSoft-CHARGED_SHOT_DISTANCE always >= 6 for distance <= 5
    const sSoft = state("p1", { 4: posSoft });
    const pwSoft: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: 3 },
    };
    check(
      "Charged Shot: sanity — this fixture's landing stays on the board (no collision)",
      posSoft - CHARGED_SHOT_DISTANCE >= 0,
    );
    check(
      "Charged Shot: a Bulwarked target IS legal when THIS distance leaves it on the board",
      getChargedShotTargets(sSoft, pwSoft, "p1").includes(4),
    );

    // Own-token collision at the exact landing tile -> sent home -> Bulwark blocks it.
    const posHome = 9;
    const landingHome = posHome - CHARGED_SHOT_DISTANCE;
    check("Charged Shot: sanity — this fixture's landing tile is a valid placement", landingHome >= 0);
    const sHome = state("p1", { 4: posHome, 5: landingHome });
    const pwHome: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: 3 },
    };
    check(
      "Charged Shot: a Bulwarked target is NOT legal when THIS distance would send it home",
      !getChargedShotTargets(sHome, pwHome, "p1").includes(4),
    );

    // Sanity: the identical send-home shot IS legal without Bulwark.
    const pwHomeNoBulwark = power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP });
    check(
      "Charged Shot: sanity — the identical send-home shot IS legal without Bulwark",
      getChargedShotTargets(sHome, pwHomeNoBulwark, "p1").includes(4),
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
      "Charged Shot: spends exactly BOTH charges (CHARGE_CAP) when no refund applies",
      rPartial.power.charges.p1 === 0,
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

  // --- A Warded target is a LEGAL Charged Shot target, at
  //     CHARGED_SHOT_WARD_DISTANCE instead of CHARGED_SHOT_DISTANCE. (Changed
  //     2026-07-16 per Kasen's requested strength ordering — push-vs-ward <
  //     push-vs-normal < charged-vs-ward < charged-vs-normal, see
  //     PUSH_WARD_DISTANCE's doc for the full context. Previously a Warded
  //     target was fully excluded from getChargedShotTargets, no
  //     affordability escape hatch — that was ITSELF the prior session's fix
  //     for archer-vs-mage overshooting archer-favored, so this reopens that
  //     lever; CHARGED_SHOT_WARD_DISTANCE is the new dedicated re-tune knob
  //     for it, scoped to Mage matchups by construction since isWarded is
  //     never true otherwise.) ------------------------------------------
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
      "Charged Shot: a Warded target IS a legal target (Ward changes distance, not legality)",
      getChargedShotTargets(sWard, pwWard, "p1").includes(4),
    );

    const rWard = applyChargedShot(sWard, pwWard, 4, "p1");
    const movedWard = rWard.state.tokens.find((t) => t.id === 4)!;
    check(
      "Charged Shot vs Ward: knocks back exactly CHARGED_SHOT_WARD_DISTANCE, not CHARGED_SHOT_DISTANCE",
      movedWard.position === posWard - CHARGED_SHOT_WARD_DISTANCE,
      `landed at ${movedWard.position}, expected ${posWard - CHARGED_SHOT_WARD_DISTANCE}`,
    );

    // Meanwhile, an UNwarded enemy (mage's charges below cap) still uses the
    // unwarded, stronger distance — confirms the branch is isWarded-specific.
    const pwUnwarded = power({ p1: "archer", p2: "mage" }, { p1: CHARGE_CAP, p2: CHARGE_CAP - 1 });
    check(
      "Charged Shot: an unwarded enemy (charges below cap) is a legal target",
      getChargedShotTargets(sWard, pwUnwarded, "p1").includes(4),
    );
    const rUnwarded = applyChargedShot(sWard, pwUnwarded, 4, "p1");
    const movedUnwarded = rUnwarded.state.tokens.find((t) => t.id === 4)!;
    check(
      "Charged Shot vs an unwarded target: knocks back CHARGED_SHOT_DISTANCE, the stronger tier",
      movedUnwarded.position === posWard - CHARGED_SHOT_DISTANCE,
      `landed at ${movedUnwarded.position}, expected ${posWard - CHARGED_SHOT_DISTANCE}`,
    );
  }

  // --- Kasen's requested strength ordering holds as a standing invariant:
  //     push-vs-ward < push-vs-normal < charged-vs-ward < charged-vs-normal.
  //     A cheap regression guard against ever silently drifting out of order
  //     again while retuning any one of the four values. ------------------
  {
    check(
      "Strength order: push-vs-ward < push-vs-normal",
      PUSH_WARD_DISTANCE < PUSH_DISTANCE,
      `PUSH_WARD_DISTANCE=${PUSH_WARD_DISTANCE}, PUSH_DISTANCE=${PUSH_DISTANCE}`,
    );
    check(
      "Strength order: push-vs-normal < charged-vs-ward",
      PUSH_DISTANCE < CHARGED_SHOT_WARD_DISTANCE,
      `PUSH_DISTANCE=${PUSH_DISTANCE}, CHARGED_SHOT_WARD_DISTANCE=${CHARGED_SHOT_WARD_DISTANCE}`,
    );
    check(
      "Strength order: charged-vs-ward < charged-vs-normal",
      CHARGED_SHOT_WARD_DISTANCE < CHARGED_SHOT_DISTANCE,
      `CHARGED_SHOT_WARD_DISTANCE=${CHARGED_SHOT_WARD_DISTANCE}, CHARGED_SHOT_DISTANCE=${CHARGED_SHOT_DISTANCE}`,
    );
  }

  // --- Charged Shot's send-home immunity: static, never save-consuming
  //     (2026-07-20, Kasen's field report — the old reveal-time accounting
  //     melted a Reinforced Bulwark one save per flip against a camped
  //     full-bank archer, no shot ever fired; see getBulwarkBlockedIds) ----
  {
    const posHome = 9;
    const sChargedShotOnly = state("p1", { 4: posHome, 5: posHome - CHARGED_SHOT_DISTANCE });
    const pwAtCap: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: 3 },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check(
      "Bulwark: a would-send-home Charged Shot keeps the target out of the pool",
      !getChargedShotTargets(sChargedShotOnly, pwAtCap, "p1").includes(4),
    );
    check(
      "Bulwark: Charged Shot send-home immunity is static — never a save-consuming block",
      !getBulwarkBlockedIds(sChargedShotOnly, pwAtCap, 1).includes(4),
    );
    // The melt regression itself: three archer flips at full bank, no shot
    // fired — the Reinforced Bulwark must not lose a single save.
    let pw = pwAtCap;
    for (let i = 0; i < 3; i++) pw = tickBulwarkForReflip(sChargedShotOnly, pw, 1).power;
    check(
      "Reinforced Bulwark: does NOT melt from a camped full-bank archer",
      pw.bulwarked[4] !== undefined && pw.bulwarkSaves[4] === BULWARK_REINFORCED_SAVES,
      JSON.stringify({ bulwarked: pw.bulwarked, saves: pw.bulwarkSaves }),
    );
    // A SOFT shove stays available: same shot with a clear landing is in
    // the pool (the tool that still moves a reinforced stone).
    const sSoft = state("p1", { 4: posHome });
    check(
      "Bulwark: a soft Charged Shot shove is still offered against a reinforced stone",
      getChargedShotTargets(sSoft, pwAtCap, "p1").includes(4),
    );
  }

  // --- REGRESSION (2026-07-17): an ultimate-ready threat never counts as a
  //     Bulwark block — ultimates pierce Bulwark, so nothing was blocked and
  //     no save may be spent. (Guards against reintroducing the deleted
  //     Blink-Strike/Warpath branches in getBulwarkBlockedIds.) -------------
  {
    // p2's Bulwarked token at 9 is out of reach of any normal capture/Push
    // (p1's only token is far behind at 4 with a flip of 1 -> to 5), but a
    // ready Blink Strike could take it — that must NOT read as "blocked."
    const sUltThreat = state("p1", { 0: 4, 4: 9 });
    const baseUlt = power({ p1: "mage", p2: "warrior" });
    const pwUltReady: PowerState = {
      ...baseUlt,
      ultimateReady: { ...baseUlt.ultimateReady, p1: true },
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a ready ultimate's reach never counts as a block (it pierces instead)",
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
      check("Bounty: a kill fills the whole soul bank", r.power.charges.p1 === NECRO_CHARGE_CAP, `p1=${r.power.charges.p1}`);
      check("Bounty: corpse marker set on the death tile", r.power.corpse.p1?.tokenId === 4 && r.power.corpse.p1?.tile === 8, JSON.stringify(r.power.corpse.p1));
      check("Bounty: the victim banks nothing (death-income is gone)", r.power.charges.p2 === 0, `p2=${r.power.charges.p2}`);
      check("Bounty: the killed token goes home", r.state.tokens.find((t) => t.id === 4)!.position === -1);
    }

    // Clamp at the soul cap, and the freshest kill overwrites the corpse.
    const pwClamp: PowerState = { ...pw, charges: { p1: 2, p2: 0 }, corpse: { p1: { tokenId: 5, tile: 9 }, p2: null } };
    if (m) {
      const r = applyPowerMove(s, pwClamp, m, "p1");
      check("Bounty: clamped at NECRO_CHARGE_CAP", r.power.charges.p1 === NECRO_CHARGE_CAP, `p1=${r.power.charges.p1}`);
      check("Bounty: a newer kill overwrites the corpse", r.power.corpse.p1?.tokenId === 4 && r.power.corpse.p1?.tile === 8, JSON.stringify(r.power.corpse.p1));
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

  // --- Soul gem: generic income can never fill the third pip --------------
  {
    const pwTwo = power({ p1: "necromancer" }, { p1: 2 });
    check("Soul gem: a zero-flip charge stops at two", grantZeroFlipCharge(pwTwo, "p1").charges.p1 === 2);

    // Non-capturing shield landing at two charges: still two.
    const s = state("p1", { 0: 4 });
    const m = getLegalPowerMoves(s, pwTwo, 3).find((mv) => mv.tokenId === 0 && mv.to === 7);
    check("Soul gem: shield-landing setup is legal", !!m && m.landsOnShield, JSON.stringify(m));
    if (m) {
      const r = applyPowerMove(s, pwTwo, m, "p1");
      check("Soul gem: a shield landing cannot fill the third pip", r.power.charges.p1 === 2, `p1=${r.power.charges.p1}`);
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
    };
    const r = applyRevive(s, pw, "p1");
    check("Revive: the corpse rises where it died", r.state.tokens.find((t) => t.id === 4)!.position === 8);
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

  // --- The dead feel no magic: a thrall's capture pierces Ward -----------
  {
    // p2 is a mage at full cap; their most-advanced FREE token is warded.
    // p1's thrall stands one tile behind it: the thrall's capture is legal
    // and flagged as a ward break; p1's own (living) token is still blocked.
    const pw: PowerState = {
      ...power({ p1: "necromancer", p2: "mage" }, { p2: CHARGE_CAP }),
      thrall: { p1: { tokenId: 4, turnsLeft: 2 }, p2: null },
    };
    const s = state("p1", { 0: 5, 4: 7, 5: 9 });
    check("Ward pierce: the target is genuinely warded", isWarded(s, pw, s.tokens.find((t) => t.id === 5)!));
    const pierce = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 9);
    check("Ward pierce: the thrall's capture is legal", !!pierce && pierce.captures.includes(5), JSON.stringify(pierce));
    check("Ward pierce: announced as a ward break", !!pierce && pierce.breaksWard === true);
    const living = getLegalPowerMoves(s, pw, 4).find((mv) => mv.tokenId === 0 && mv.to === 9);
    check("Ward pierce: the necromancer's LIVING stones stay blocked", living === undefined, JSON.stringify(living));
  }

  // --- Corpse Explosion: the 2-soul corpse spend ---------------------------
  {
    // Corpse marked on tile 8; enemies at 7, 8-adjacent 9, and far 11.
    const ready: PowerState = {
      ...power({ p1: "necromancer", p2: "archer" }, { p1: CORPSE_EXPLOSION_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
    };
    const s = state("p1", { 5: 9, 6: 11 });
    check(
      "Explosion: strikes the unprotected enemy beside the grave",
      getCorpseExplosionTargets(s, ready, "p1").includes(5),
    );
    check(
      "Explosion: reaches only CORPSE_EXPLOSION_RADIUS from the grave",
      !getCorpseExplosionTargets(s, ready, "p1").includes(6),
    );
    check("Explosion: refused without a corpse", getCorpseExplosionTargets(s, { ...ready, corpse: { p1: null, p2: null } }, "p1").length === 0);
    check(
      "Explosion: refused below its cost",
      getCorpseExplosionTargets(s, { ...ready, charges: { p1: CORPSE_EXPLOSION_COST - 1, p2: 0 } }, "p1").length === 0,
    );
    const sDenied = state("p1", { 4: 1, 5: 9 });
    check("Explosion: refused once the corpse token re-enters", getCorpseExplosionTargets(sDenied, ready, "p1").length === 0);
    check("Explosion: empty pool when nothing stands near the grave", getCorpseExplosionTargets(state("p1", {}), ready, "p1").length === 0);
    // Unlike Revive, an ACTIVE thrall doesn't block the blast (different slot).
    const midThrall: PowerState = { ...ready, thrall: { p1: { tokenId: 7, turnsLeft: 1 }, p2: null } };
    const sMid = state("p1", { 5: 9, 7: 5 });
    check("Explosion: castable while a thrall serves", getCorpseExplosionTargets(sMid, midThrall, "p1").includes(5));
    check("Explosion: the caster's own thrall is family, never a victim", !getCorpseExplosionTargets(sMid, midThrall, "p1").includes(7));
    // Protections all hold: shield tile 7, Ward, Bulwark.
    const shielded = state("p1", { 5: 7 });
    const corpseAt7: PowerState = { ...ready, corpse: { p1: { tokenId: 4, tile: 8 }, p2: null } };
    check("Explosion: a shield tile shelters its occupant", !getCorpseExplosionTargets(shielded, corpseAt7, "p1").includes(5));
    const pwWard: PowerState = {
      ...power({ p1: "necromancer", p2: "mage" }, { p1: CORPSE_EXPLOSION_COST, p2: CHARGE_CAP }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
    };
    check("Explosion: Ward turns the blast", !getCorpseExplosionTargets(state("p1", { 5: 9 }), pwWard, "p1").includes(5));
    const pwBul: PowerState = { ...ready, bulwarked: { 5: 2 } };
    check("Explosion: Bulwark turns the blast", !getCorpseExplosionTargets(state("p1", { 5: 9 }), pwBul, "p1").includes(5));

    // Apply: knockback, send-home on collision, flat cost, desecration.
    const sApply = state("p1", { 5: 9, 6: 8 }); // 6 at the grave itself: 8->7 shield tile landing? 8-1=7 free -> lands ON the shield tile (legal landing, protection is for capture)
    const rA = applyCorpseExplosion(sApply, ready, "p1");
    check("Explosion: victims knocked back one tile", rA.state.tokens.find((t) => t.id === 5)!.position === 8);
    check("Explosion: spends its flat cost", rA.power.charges.p1 === 0, `p1=${rA.power.charges.p1}`);
    check("Explosion: consumes the corpse", rA.power.corpse.p1 === null);
    check("Explosion: ends the turn", rA.state.currentPlayer === "p2");
    check("Explosion: reports the epicenter", rA.tile === 8);
    check("Explosion: desecration — no corpse minted by the blast", rA.power.corpse.p1 === null);
    // Collision send-home: enemy at 9 with its own stone at 8 -> 9-1=8 occupied -> home.
    const sCollide = state("p1", { 5: 9, 6: 8 });
    const rC = applyCorpseExplosion(sCollide, ready, "p1");
    // (6 resolves first — nearest the grave — vacating 8 backward to 7, so 5 lands on 8.)
    check("Explosion: nearest-first resolution lets outer victims fill vacated tiles", rC.state.tokens.find((t) => t.id === 5)!.position === 8);
    const sWall = state("p1", { 0: 8, 5: 9 }); // MY stone holds 8: enemy at 9 has nowhere -> home
    const rW = applyCorpseExplosion(sWall, ready, "p1");
    check("Explosion: a blocked landing is a send-home", rW.state.tokens.find((t) => t.id === 5)!.position === -1);
    check("Explosion: blast send-homes pay no bounty", rW.power.charges.p1 === 0, `p1=${rW.power.charges.p1}`);
    check("Explosion: the blast breaks a live shield streak", applyCorpseExplosion(sApply, { ...ready, shieldStreak: { p1: 2, p2: 0 } }, "p1").power.shieldStreak.p1 === 0);
    // Mirror: the ENEMY's thrall (my own body) blasted home dies for real.
    const mirrorPw: PowerState = {
      ...power({ p1: "necromancer", p2: "necromancer" }, { p1: CORPSE_EXPLOSION_COST }),
      corpse: { p1: { tokenId: 4, tile: 8 }, p2: null },
      thrall: { p1: null, p2: { tokenId: 0, turnsLeft: 2 } },
    };
    const sMirror = state("p1", { 0: 9, 1: 8 }); // my body 0 possessed by p2 at 9; my stone 1 walls tile 8
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
      check("Thrall: its kill pays the full bounty (chain necromancy)", r.power.charges.p1 === NECRO_CHARGE_CAP, `p1=${r.power.charges.p1}`);
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
    const pwB: PowerState = { ...pw, bulwarked: { 4: 2 }, bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES } };
    const r3 = applyExhume(s, pwB, 4, "p1");
    check(
      "Exhume: strips a stale Bulwark on the way back",
      r3.power.bulwarked[4] === undefined && r3.power.bulwarkSaves[4] === undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleric: Bless / Heal target pools and casts
// ---------------------------------------------------------------------------
{
  // Bless pool: own on-board stones with no vitality entry, full bank only.
  const s = state("p1", { 0: 5, 1: 2, 4: 8 });
  const pwBroke = power({ p1: "cleric" }, { p1: BLESS_COST - 1 });
  check("Bless: empty pool below the full bank", getBlessTargets(s, pwBroke, "p1").length === 0);

  const pw = power({ p1: "cleric" }, { p1: BLESS_COST });
  const pool = getBlessTargets(s, pw, "p1");
  check("Bless: own on-board stones eligible (contested and private lane alike)", pool.includes(0) && pool.includes(1));
  check("Bless: reserve and enemy stones excluded", !pool.includes(2) && !pool.includes(4));

  const pwBlessed: PowerState = { ...pw, vitality: { 0: "blessed", 1: "wounded" } };
  const pool2 = getBlessTargets(s, pwBlessed, "p1");
  check("Bless: already-blessed and wounded stones excluded (Heal's job)", !pool2.includes(0) && !pool2.includes(1));

  // A stone possessed AGAINST the cleric is not theirs to bless.
  const pwPoss: PowerState = {
    ...power({ p1: "cleric", p2: "necromancer" }, { p1: BLESS_COST }),
    thrall: { p1: null, p2: { tokenId: 0, turnsLeft: 2 } },
  };
  check("Bless: a stone possessed against the cleric is excluded", !getBlessTargets(s, pwPoss, "p1").includes(0));

  // The cast: spends the mana, flags the stone, KEEPS the turn (Revive's
  // contract — no streak interaction, no board movement).
  const pwStreak: PowerState = { ...pw, shieldStreak: { p1: 2, p2: 0 } };
  const r = applyBless(s, pwStreak, 0, "p1");
  check("Bless: spends BLESS_COST", r.power.charges.p1 === 0);
  check("Bless: flags the stone blessed", r.power.vitality[0] === "blessed");
  check("Bless: keeps the turn (Revive's contract)", r.state.currentPlayer === "p1");
  check("Bless: leaves the shield streak alone", r.power.shieldStreak.p1 === 2);
  check("Bless: moves no tokens", r.state.tokens.find((t) => t.id === 0)!.position === 5);

  // Heal pool: wounded stones only, HEAL_COST affordability baked in.
  const pwW: PowerState = { ...power({ p1: "cleric" }, { p1: HEAL_COST }), vitality: { 0: "wounded", 1: "blessed" } };
  const healPool = getHealTargets(s, pwW, "p1");
  check("Heal: wounded stones only", healPool.includes(0) && !healPool.includes(1) && healPool.length === 1);
  const pwWBroke: PowerState = { ...pwW, charges: { p1: 0, p2: 0 } };
  check("Heal: empty pool when unaffordable", getHealTargets(s, pwWBroke, "p1").length === 0);

  const rh = applyHeal(s, pwW, 0, "p1");
  check("Heal: mends wounded back to blessed", rh.power.vitality[0] === "blessed");
  check("Heal: spends HEAL_COST", rh.power.charges.p1 === 0);
  check("Heal: ends the turn (the mend pays tempo — unlike Bless)", rh.state.currentPlayer === "p2");
}

// ---------------------------------------------------------------------------
// Cleric: the wound split on the landing-capture path
// ---------------------------------------------------------------------------
{
  // p2 archer at 6 flips 2 -> lands on 8 where p1 cleric's BLESSED stone
  // stands. Legality is unchanged (blessing is not protection) — the move
  // still lists the capture — but resolution wounds instead of kills.
  const s = state("p2", { 0: 8, 4: 6 });
  const pw: PowerState = { ...power({ p1: "cleric", p2: "archer" }), vitality: { 0: "blessed" } };
  const moves = getLegalPowerMoves(s, pw, 2);
  const m = moves.find((mv) => mv.tokenId === 4 && mv.to === 8);
  check("Wound: blessed enemy is still a legal capture target", !!m && m.captures.includes(0), JSON.stringify(m));

  const r = applyPowerMove(s, pw, m!, "p2");
  const victim = r.state.tokens.find((t) => t.id === 0)!;
  check("Wound: blessed victim survives (not in reserve)", victim.position !== -1);
  check("Wound: landing victim staggers back to the nearest free tile", victim.position === 7, `at ${victim.position}`);
  check("Wound: vitality downgrades to wounded", r.power.vitality[0] === "wounded");
  check("Wound: reported in the wounded list with its landing", r.wounded.length === 1 && r.wounded[0].tokenId === 0 && r.wounded[0].to === 7);
  check("Wound: attacker occupies the landing tile", r.state.tokens.find((t) => t.id === 4)!.position === 8);
  check("Wound: breaking the blessing pays the standard charge", r.power.charges.p2 === 1);

  // Stagger-back walks past occupied tiles — 7 held by the victim's own
  // sibling, so the retreat continues to 6... which the ATTACKER vacated
  // (it moved 6 -> 8), so 6 is free.
  const s2 = state("p2", { 0: 8, 1: 7, 4: 6 });
  const m2 = getLegalPowerMoves(s2, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  const r2 = applyPowerMove(s2, pw, m2, "p2");
  check("Wound: stagger walks past an occupied tile", r2.state.tokens.find((t) => t.id === 0)!.position === 6, `at ${r2.state.tokens.find((t) => t.id === 0)!.position}`);

  // A WOUNDED (blessing already broken) stone dies for real, entry cleared.
  const pwW: PowerState = { ...power({ p1: "cleric", p2: "archer" }), vitality: { 0: "wounded" } };
  const m3 = getLegalPowerMoves(s, pwW, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  const r3 = applyPowerMove(s, pwW, m3, "p2");
  check("Wound: a wounded stone is killed for real", r3.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Wound: the dead stone's vitality entry clears", r3.power.vitality[0] === undefined);
  check("Wound: a real kill still pays the capture charge", r3.power.charges.p2 === 1);

  // The retreat can leave the contested row into the victim's own private
  // lane — and a cross-owner numeric match there is NOT a collision: p2's
  // token 6 sits at ITS OWN private tile 3, a different physical square
  // from p1's tile 3, so the wounded stone still retreats 4 -> 3.
  const s4 = state("p2", { 0: 4, 5: 2, 6: 3 });
  const pw4: PowerState = { ...power({ p1: "cleric", p2: "archer" }), vitality: { 0: "blessed" } };
  const m4 = getLegalPowerMoves(s4, pw4, 2).find((mv) => mv.tokenId === 5 && mv.to === 4);
  check("Wound: setup — p2 archer can land on tile 4", !!m4 && m4!.captures.includes(0));
  const r4 = applyPowerMove(s4, pw4, m4!, "p2");
  check(
    "Wound: retreat crosses into the victim's own private lane, ignoring cross-owner numeric matches",
    r4.state.tokens.find((t) => t.id === 0)!.position === 3,
    `at ${r4.state.tokens.find((t) => t.id === 0)!.position}`,
  );
}

// ---------------------------------------------------------------------------
// Cleric: wounds from Snipe, Charge sweep, and the no-charge-for-wounds rule
// ---------------------------------------------------------------------------
{
  // Snipe a blessed target: it wounds and HOLDS its tile (never on the
  // landing tile by construction).
  const s = state("p2", { 0: 9, 4: 6 });
  const pw: PowerState = { ...power({ p1: "cleric", p2: "archer" }), vitality: { 0: "blessed" } };
  const m = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  check("Wound/Snipe: blessed target still sniped", m.bonusCaptures.includes(0));
  const r = applyPowerMove(s, pw, m, "p2");
  const victim = r.state.tokens.find((t) => t.id === 0)!;
  check("Wound/Snipe: sniped blessed stone holds its tile", victim.position === 9);
  check("Wound/Snipe: wounded, not dead", r.power.vitality[0] === "wounded");
  check("Wound/Snipe: a wound-only move still pays the standard charge", r.power.charges.p2 === 1);

  // Charge sweep over a blessed enemy: wounded in place; a mortal enemy in
  // the same sweep dies and pays the (single) capture charge.
  const s2 = state("p2", { 0: 7 - 1, 4: 4 }); // p1 blessed at 6; warrior at 4 charges to 8? lane 5,6,7 — 7 is shield...
  void s2;
  const s3 = state("p2", { 0: 5, 4: 4 });
  const pwW: PowerState = { ...power({ p1: "cleric", p2: "warrior" }, { p2: 1 }), vitality: { 0: "blessed" } };
  const m3 = getLegalPowerMoves(s3, pwW, 2).find((mv) => mv.tokenId === 4 && mv.to === 6)!;
  check("Wound/sweep: blessed enemy still listed in the sweep", m3.chargeSweepCaptures.includes(0));
  const r3 = applyCharge(s3, pwW, m3, "p2");
  const swept = r3.state.tokens.find((t) => t.id === 0)!;
  check("Wound/sweep: swept blessed stone wounded in place", swept.position === 5 && r3.power.vitality[0] === "wounded");
  check("Wound/sweep: charge spent, wound pays the standard charge back", r3.power.charges.p2 === 1);
}

// ---------------------------------------------------------------------------
// Cleric: wounds deny the necromancer's corpse and bounty
// ---------------------------------------------------------------------------
{
  // Necromancer lands on a blessed cleric stone: wound — no soul bounty,
  // no corpse marker. Only a FULL kill feeds the graveyard.
  const s = state("p2", { 0: 8, 4: 6 });
  const pw: PowerState = { ...power({ p1: "cleric", p2: "necromancer" }), vitality: { 0: "blessed" } };
  const m = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  const r = applyPowerMove(s, pw, m, "p2");
  check("Wound/necro: a wound pays the generic charge, never the bounty", r.power.charges.p2 === 1);
  check("Wound/necro: no corpse marked", r.power.corpse.p2 === null);
  check("Wound/necro: victim wounded, not killed", r.power.vitality[0] === "wounded" && r.state.tokens.find((t) => t.id === 0)!.position !== -1);

  // Same landing against a WOUNDED stone: full kill, full bounty, corpse.
  const pwW: PowerState = { ...power({ p1: "cleric", p2: "necromancer" }), vitality: { 0: "wounded" } };
  const mW = getLegalPowerMoves(s, pwW, 2).find((mv) => mv.tokenId === 4 && mv.to === 8)!;
  const rW = applyPowerMove(s, pwW, mW, "p2");
  check("Wound/necro: killing a wounded stone pays the full bounty", rW.power.charges.p2 === SOUL_BOUNTY_CHARGES);
  check("Wound/necro: and marks the corpse", rW.power.corpse.p2?.tokenId === 0 && rW.power.corpse.p2?.tile === 8);
}

// ---------------------------------------------------------------------------
// Cleric: ultimates pierce the blessing
// ---------------------------------------------------------------------------
{
  // Rain of Arrows: archer's 3rd consecutive shield landing kills a blessed
  // stone for real (rand pinned to pick the only pool member).
  const s = state("p2", { 0: 9, 4: 6 });
  const pw: PowerState = {
    ...power({ p1: "cleric", p2: "archer" }),
    shieldStreak: { p1: 0, p2: ULTIMATE_STREAK - 1 },
    vitality: { 0: "blessed" },
  };
  const m = getLegalPowerMoves(s, pw, 1).find((mv) => mv.tokenId === 4 && mv.to === 7)!;
  check("Pierce: setup — landing on the shield tile", m.landsOnShield);
  const r = applyPowerMove(s, pw, m, "p2", () => 0);
  check("Pierce: Rain of Arrows kills a blessed stone outright", r.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Pierce: the dead stone's vitality entry clears", r.power.vitality[0] === undefined);
  check("Pierce: rain reported", r.rainOfArrows?.targetTokenId === 0);

  // Blink Strike: same pierce.
  const s2 = state("p2", { 0: 9, 4: 6 });
  const pw2: PowerState = {
    ...power({ p1: "cleric", p2: "mage" }),
    ultimateReady: { p1: false, p2: true },
    vitality: { 0: "blessed" },
  };
  check("Pierce: Blink Strike lists the blessed stone", getBlinkStrikeTargets(s2, pw2, "p2").includes(0));
  const r2 = applyBlinkStrike(s2, pw2, 0, "p2");
  check("Pierce: Blink Strike kills through the blessing", r2.state.tokens.find((t) => t.id === 0)!.position === -1 && r2.power.vitality[0] === undefined);

  // Warpath: primary AND swept blessed stones both die.
  const s3 = state("p2", { 0: 9, 1: 7 + 1, 4: 5, 5: 11 });
  const pw3: PowerState = {
    ...power({ p1: "cleric", p2: "warrior" }),
    ultimateReady: { p1: false, p2: true },
    vitality: { 0: "blessed", 1: "blessed" },
  };
  const r3 = applyWarpath(s3, pw3, 0, "p2");
  check("Pierce: Warpath primary blessed target dies", r3.state.tokens.find((t) => t.id === 0)!.position === -1);
  check("Pierce: Warpath swept blessed target dies too", r3.state.tokens.find((t) => t.id === 1)!.position === -1 && r3.sweptTokenIds.includes(1));
  check("Pierce: both vitality entries clear", r3.power.vitality[0] === undefined && r3.power.vitality[1] === undefined);
}

// ---------------------------------------------------------------------------
// Cleric: blessing absorbs knockback send-homes (Push / Charged Shot / blast)
// ---------------------------------------------------------------------------
{
  // Push that WOULD send home (collision behind): blessed target is wounded
  // and holds its ground; the pusher gets no refund.
  const s = state("p1", { 0: 6, 4: 8, 5: 7 }); // p2's 4 at 8, its own 5 at 7 -> push collides
  const pw: PowerState = { ...power({ p1: "archer", p2: "cleric" }, { p1: 1 }), vitality: { 4: "blessed" } };
  check("Absorb/Push: blessed stone is still a push target", getPushTargets(s, pw, "p1").includes(4));
  const r = applyPush(s, pw, 4, "p1");
  const target = r.state.tokens.find((t) => t.id === 4)!;
  check("Absorb/Push: target holds its ground", target.position === 8);
  check("Absorb/Push: wounded, not sent home", r.power.vitality[4] === "wounded");
  check("Absorb/Push: reported", r.woundedTokenId === 4);
  check("Absorb/Push: breaking the blessing refunds the charge", r.power.charges.p1 === 1);

  // A soft shove (free tile behind) displaces a blessed stone normally.
  const s2 = state("p1", { 0: 6, 4: 9 });
  const r2 = applyPush(s2, pw, 4, "p1");
  check("Absorb/Push: soft shove still moves a blessed stone", r2.state.tokens.find((t) => t.id === 4)!.position === 8);
  check("Absorb/Push: blessing intact through a soft shove", r2.power.vitality[4] === "blessed");
  check("Absorb/Push: no wound reported on a soft shove", r2.woundedTokenId === null);

  // A WOUNDED stone pushed home dies and loses its entry.
  const pwW: PowerState = { ...power({ p1: "archer", p2: "cleric" }, { p1: 1 }), vitality: { 4: "wounded" } };
  const rW = applyPush(s, pwW, 4, "p1");
  check("Absorb/Push: a wounded stone still dies to a send-home", rW.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Absorb/Push: its entry clears", rW.power.vitality[4] === undefined);
  check("Absorb/Push: the kill refunds as usual", rW.power.charges.p1 === 1);

  // Charged Shot send-home vs blessed: absorbed the same way.
  const s3 = state("p1", { 0: 6, 4: 6 + CHARGED_SHOT_DISTANCE - 3, 5: 0 });
  void s3;
  const sC = state("p1", { 0: 11, 4: 3 + CHARGED_SHOT_DISTANCE }); // underflow-adjacent: 4 at 3+4=7? shield... pick plain positions
  void sC;
  // Simple: target at position 2 (own lane) is off the contested row —
  // Charged Shot pool needs contested. Use target at 4: knockback 4 -> 0
  // via CHARGED_SHOT_DISTANCE=4, landing 0 is its own lane (free) — soft.
  // For a send-home use a target at 4 with distance 4 -> 0 occupied by its
  // own sibling.
  const s4 = state("p1", { 0: 6, 4: 4, 5: 0 });
  const pw4: PowerState = { ...power({ p1: "archer", p2: "cleric" }, { p1: CHARGE_CAP }), vitality: { 4: "blessed" } };
  check("Absorb/Shot: blessed stone targetable", getChargedShotTargets(s4, pw4, "p1").includes(4));
  const r4 = applyChargedShot(s4, pw4, 4, "p1");
  check("Absorb/Shot: blessed target wounded in place", r4.state.tokens.find((t) => t.id === 4)!.position === 4 && r4.power.vitality[4] === "wounded");
  check("Absorb/Shot: full bank spent, break refunds one", r4.power.charges.p1 === 1);
  check("Absorb/Shot: reported", r4.woundedTokenId === 4);

  // Corpse Explosion: a blessed victim whose knockback would send home is
  // wounded in place instead; a mortal one still goes home.
  const s5 = state("p1", { 0: 5, 4: 6, 5: 5 });
  void s5;
  const s6 = state("p1", { 4: 6, 5: 5 });
  const pw6: PowerState = {
    ...power({ p1: "necromancer", p2: "cleric" }, { p1: CORPSE_EXPLOSION_COST }),
    corpse: { p1: { tokenId: 6, tile: 6 }, p2: null },
    vitality: { 4: "blessed" },
  };
  // Victims: p2's 4 at 6 (blessed, knockback 6->5 collides with its own 5
  // -> absorbed wound) and p2's 5 at 5 (mortal, knockback 5->4... free? 4
  // is empty numerically -> soft shove).
  const r6 = applyCorpseExplosion(s6, pw6, "p1");
  check("Absorb/Blast: blessed victim wounded in place", r6.state.tokens.find((t) => t.id === 4)!.position === 6 && r6.power.vitality[4] === "wounded");
  check("Absorb/Blast: reported in woundedTokenIds, not sentHomeIds", r6.woundedTokenIds.includes(4) && !r6.sentHomeIds.includes(4));
  check("Absorb/Blast: mortal victim still shoved", r6.state.tokens.find((t) => t.id === 5)!.position === 4);
}

// ---------------------------------------------------------------------------
// Cleric: Sanctified Ground (shield landings mend) + Benediction
// ---------------------------------------------------------------------------
{
  // Cleric lands on the shield tile with two wounded stones: both mend.
  const s = state("p1", { 0: 6, 1: 4, 2: 5 });
  const pw: PowerState = { ...power({ p1: "cleric" }), vitality: { 1: "wounded", 2: "wounded" } };
  const m = getLegalPowerMoves(s, pw, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  check("Mend: setup — shield landing", m.landsOnShield);
  const r = applyPowerMove(s, pw, m, "p1");
  check("Mend: all wounded stones return to blessed", r.power.vitality[1] === "blessed" && r.power.vitality[2] === "blessed");
  check("Mend: reported", r.mendedTokenIds.length === 2 && r.mendedTokenIds.includes(1) && r.mendedTokenIds.includes(2));
  check("Mend: shield landing still grants charge + extra turn", r.power.charges.p1 === 1 && r.state.currentPlayer === "p1");

  // A cleric-mirror shield landing mends only the MOVER's wounded stones.
  const sM = state("p1", { 0: 6, 1: 4, 5: 9 });
  const pwM: PowerState = { ...power({ p1: "cleric", p2: "cleric" }), vitality: { 1: "wounded", 5: "wounded" } };
  const mM = getLegalPowerMoves(sM, pwM, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rM = applyPowerMove(sM, pwM, mM, "p1");
  check("Mend: mirror — only the mover's stones mend", rM.power.vitality[1] === "blessed" && rM.power.vitality[5] === "wounded");

  // A NON-cleric shield landing mends nothing.
  const pwN: PowerState = { ...power({ p1: "archer", p2: "cleric" }), vitality: { 5: "wounded" } };
  const sN = state("p1", { 0: 6, 5: 9 });
  const mN = getLegalPowerMoves(sN, pwN, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rN = applyPowerMove(sN, pwN, mN, "p1");
  check("Mend: non-cleric landings mend nothing", rN.power.vitality[5] === "wounded" && rN.mendedTokenIds.length === 0);

  // Benediction: pool = every own on-board stone not already blessed;
  // the cast blesses them all, spends the flag, ends the turn, and leaves
  // the shield streak alone.
  const sB = state("p1", { 0: 5, 1: 2, 2: 8 });
  const pwB: PowerState = {
    ...power({ p1: "cleric" }),
    ultimateReady: { p1: true, p2: false },
    shieldStreak: { p1: 2, p2: 0 },
    vitality: { 2: "wounded", 0: "blessed" },
  };
  const poolB = getBenedictionTargets(sB, pwB, "p1");
  check("Benediction: pool is the unblessed on-board army", poolB.includes(1) && poolB.includes(2) && !poolB.includes(0) && !poolB.includes(3));
  const rB = applyBenediction(sB, pwB, "p1");
  check("Benediction: blesses the army", rB.power.vitality[1] === "blessed" && rB.power.vitality[2] === "blessed" && rB.power.vitality[0] === "blessed");
  check("Benediction: spends the flag, ends the turn", rB.power.ultimateReady.p1 === false && rB.state.currentPlayer === "p2");
  check("Benediction: leaves the shield streak alone (ultimate rule)", rB.power.shieldStreak.p1 === 2);
  check("Benediction: reports who it blessed", rB.blessedTokenIds.length === 2);

  // All-blessed army: empty pool = not castable.
  const pwAll: PowerState = { ...pwB, vitality: { 0: "blessed", 1: "blessed", 2: "blessed" } };
  const sAll = state("p1", { 0: 5, 1: 2, 2: 8 });
  check("Benediction: empty pool when nothing would change", getBenedictionTargets(sAll, pwAll, "p1").length === 0);
}

// ---------------------------------------------------------------------------
// Cleric: the blessed blade pierces Ward
// ---------------------------------------------------------------------------
{
  // p1 cleric's BLESSED stone lands on the mage's warded (most-advanced,
  // full-bank) stone: legal, captures, breaksWard — the Ward Breaker /
  // thrall exception's third member.
  const s = state("p1", { 0: 6, 4: 8 });
  const pw: PowerState = { ...power({ p1: "cleric", p2: "mage" }, { p2: CHARGE_CAP }), vitality: { 0: "blessed" } };
  check("Blessed blade: setup — target is warded", isWarded(s, pw, s.tokens.find((t) => t.id === 4)!));
  const m = getLegalPowerMoves(s, pw, 2).find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Blessed blade: a blessed stone may strike a Warded enemy", !!m && m!.captures.includes(4), JSON.stringify(m));
  check("Blessed blade: the strike breaks the Ward", !!m && m!.breaksWard);

  // The cleric's MORTAL stone is still blocked, and so is a WOUNDED one.
  const pwMortal: PowerState = power({ p1: "cleric", p2: "mage" }, { p2: CHARGE_CAP });
  const mMortal = getLegalPowerMoves(s, pwMortal, 2).find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Blessed blade: a mortal stone is still Ward-blocked", !mMortal);
  const pwWound: PowerState = { ...pwMortal, vitality: { 0: "wounded" } };
  const mWound = getLegalPowerMoves(s, pwWound, 2).find((mv) => mv.tokenId === 0 && mv.to === 8);
  check("Blessed blade: a wounded stone's light is broken — no pierce", !mWound);
}

// ---------------------------------------------------------------------------
// Cleric: BLESSING_CAP — the light shelters two at a time
// ---------------------------------------------------------------------------
{
  // Parametrized against BLESSING_CAP: the first CAP stones blessed, the
  // rest mortal — the light is spoken for.
  const s = state("p1", { 0: 5, 1: 6, 2: 8, 3: 2 });
  const atCap: Record<number, "blessed" | "wounded"> = {};
  for (let id = 0; id < BLESSING_CAP; id++) atCap[id] = "blessed";
  const pwAtCap: PowerState = { ...power({ p1: "cleric" }, { p1: BLESS_COST }), vitality: { ...atCap } };
  check("Cap: Bless pool empties at BLESSING_CAP live blessings", getBlessTargets(s, pwAtCap, "p1").length === 0);
  const pwOneDown: PowerState = { ...pwAtCap, vitality: { ...atCap, 0: "wounded" } };
  check("Cap: a wounded entry frees a slot (broken light doesn't count)", getBlessTargets(s, pwOneDown, "p1").length > 0);
  // Heal counts against the same cap: at cap, the wounded stone can't mend.
  const pwHealBlocked: PowerState = {
    ...power({ p1: "cleric" }, { p1: HEAL_COST }),
    vitality: { ...atCap, [BLESSING_CAP]: "wounded" },
  };
  check("Cap: Heal pool empties at the cap too", getHealTargets(s, pwHealBlocked, "p1").length === 0);
  // Benediction, the ultimate, exceeds the cap freely — its pool is every
  // on-board stone not already blessed.
  const pwUlt: PowerState = { ...pwAtCap, ultimateReady: { p1: true, p2: false } };
  check("Cap: Benediction ignores the cap (ultimate)", getBenedictionTargets(s, pwUlt, "p1").length === 4 - BLESSING_CAP);
  // A cleric MIRROR: the foe's blessings never count against mine.
  const sM = state("p1", { 0: 5, 5: 9, 6: 10, 7: 8 });
  const foeCap: Record<number, "blessed" | "wounded"> = {};
  for (let id = 4; id < 4 + BLESSING_CAP; id++) foeCap[id] = "blessed";
  const pwM: PowerState = { ...power({ p1: "cleric", p2: "cleric" }, { p1: BLESS_COST }), vitality: foeCap };
  check("Cap: mirror — only my own blessings count", getBlessTargets(sM, pwM, "p1").includes(0));
}

// ---------------------------------------------------------------------------
// Cleric: blessing rides through escape and Exhume
// ---------------------------------------------------------------------------
{
  // An escaped blessed token dragged back by Exhume keeps its blessing —
  // it never died; it came home in glory and got dragged back.
  const s = state("p2", { 0: PATH_LENGTH_PER_PLAYER });
  const pw: PowerState = {
    ...power({ p1: "cleric", p2: "necromancer" }),
    ultimateReady: { p1: false, p2: true },
    vitality: { 0: "blessed" },
  };
  const r = applyExhume(s, pw, 0, "p2");
  check("Exhume: a blessed returner keeps its blessing", r.power.vitality[0] === "blessed");
  check("Exhume: dragged to the return tile", r.state.tokens.find((t) => t.id === 0)!.position === EXHUME_RETURN_POSITION);
}

// ---------------------------------------------------------------------------
// Rogue: Larceny — every REAL kill also drains the foe's bank; a wound
// (blessed victim survives) pays nothing extra, and only a Rogue's own
// captures trigger it at all
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

  // Same setup, but the victim is blessed — a WOUND, not a kill. Larceny
  // must not fire (wounds pay only the standard capture charge, same rule
  // Necromancer's soul bounty already follows).
  const pwBlessed: PowerState = { ...power({ p1: "rogue", p2: "archer" }, { p2: 2 }), vitality: { 4: "blessed" } };
  const movesBlessed = getLegalPowerMoves(s, pwBlessed, 2);
  const mBlessed = movesBlessed.find((mv) => mv.tokenId === 0 && mv.to === 6)!;
  const rBlessed = applyPowerMove(s, pwBlessed, mBlessed, "p1");
  check("Larceny: a WOUND does not drain the foe", rBlessed.power.charges.p2 === 2, `got ${rBlessed.power.charges.p2}`);
  check("Larceny: sanity — the victim really was wounded, not killed", rBlessed.power.vitality[4] === "wounded");

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
  check("Pickpocket: an enemy in shared water with mana IS a legal target", targets.includes(4), JSON.stringify(targets));

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
  check("Pickpocket: reaches an enemy standing on a shield tile", getPickpocketTargets(sShield, pw, "p1").includes(4));

  const pwWarded = power({ p1: "rogue", p2: "mage" }, { p1: 1, p2: CHARGE_CAP });
  check(
    "Pickpocket: reaches a Warded enemy (Ward only protects against capture)",
    getPickpocketTargets(s, pwWarded, "p1").includes(4),
  );

  const pwBulwarked: PowerState = {
    ...power({ p1: "rogue", p2: "warrior" }, { p1: 1, p2: 2 }),
    bulwarked: { 4: 3 },
  };
  check(
    "Pickpocket: reaches a Bulwarked enemy (no capture happens, so Bulwark is irrelevant)",
    getPickpocketTargets(s, pwBulwarked, "p1").includes(4),
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
// gained too little back). Vanish is Bulwark's EXACT mechanic under a Rogue
// cast (see VANISH_COST's doc) — it writes into the same power.bulwarked
// map Warrior's Bulwark uses, so the underlying protection (blocks a plain
// capture, blocks a Charge sweep, pierced only by ultimates, ticked down by
// the same tickBulwarkExpiry) is already exhaustively covered by section
// 14's Bulwark tests above and does NOT need re-proving here — this section
// only checks Vanish's own target pool, its apply-path economy, and one
// integration proof that the shared protection really does activate when
// cast via the Rogue.
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

    const pwVanished: PowerState = { ...pw, bulwarked: { 0: 2 } };
    check(
      "Vanish: an already-protected token is excluded from re-targeting",
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
      "Vanish: flags the target with VANISH_TURNS remaining",
      r.power.bulwarked[0] === VANISH_TURNS,
      `got ${JSON.stringify(r.power.bulwarked)}`,
    );
    check("Vanish: no board movement at all", r.state.tokens.find((t) => t.id === 0)!.position === 4);
    check("Vanish: ends the turn", r.state.currentPlayer === "p2" && r.state.extraTurn === false);
    check("Vanish: breaks a live shield streak (never lands the mover on one)", (() => {
      const base = power({ p1: "rogue" }, { p1: CHARGE_CAP });
      const pwStreak: PowerState = { ...base, shieldStreak: { ...base.shieldStreak, p1: 2 } };
      return applyVanish(s, pwStreak, 0, "p1").power.shieldStreak.p1 === 0;
    })());
  }

  // --- Integration proof: a Vanished stone actually blocks a capture,
  //     same as isBulwarked already guarantees for the Warrior's own cast —
  //     this is the one place worth re-proving the reuse actually wired up
  //     correctly rather than just trusting the shared field name. ---
  {
    const s = state("p1", { 0: 4, 4: 6 });
    const pw: PowerState = { ...power({ p1: "archer", p2: "rogue" }), bulwarked: { 4: 3 } };
    const moves = getLegalPowerMoves(s, pw, 2); // token0: 4 -> 6
    const blocked = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
    check("Vanish: a Vanished stone blocks a normal capturing move onto it", blocked === undefined, JSON.stringify(moves));
  }
}

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

  // Pierces Bulwark, and clears the captured token's bulwarked entry (the
  // same reserve-trip leak resolveTurn already guards against elsewhere).
  const sBulwark = state("p1", { 0: 5, 4: 9 });
  const baseW = power({ p1: "rogue", p2: "warrior" });
  const pwBulwark: PowerState = {
    ...baseW,
    ultimateReady: { ...baseW.ultimateReady, p1: true },
    charges: { p1: 0, p2: 2 },
    bulwarked: { 4: 3 },
  };
  const rBulwark = applyGrandHeist(sBulwark, pwBulwark, 4, "p1");
  check("Grand Heist: captures a Bulwarked target", rBulwark.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: clears the captured token's bulwarked entry", rBulwark.power.bulwarked[4] === undefined);

  // Pierces Blessing — a REAL kill, not a wound (every ultimate kills
  // straight through it, same as Rain of Arrows/Blink Strike/Warpath).
  const sBlessed = state("p1", { 0: 5, 4: 9 });
  const pwBlessed: PowerState = {
    ...power({ p1: "rogue", p2: "cleric" }, { p1: 0, p2: 2 }),
    ultimateReady: { p1: true, p2: false },
    vitality: { 4: "blessed" },
  };
  const rBlessed = applyGrandHeist(sBlessed, pwBlessed, 4, "p1");
  check("Grand Heist: kills a Blessed target outright (ultimates pierce blessing)", rBlessed.state.tokens.find((t) => t.id === 4)!.position === -1);
  check("Grand Heist: clears the captured token's vitality entry", rBlessed.power.vitality[4] === undefined);
  check(
    "Grand Heist: still drains the entire bank even on a pierced-blessing kill",
    rBlessed.power.charges.p2 === 0,
  );
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
