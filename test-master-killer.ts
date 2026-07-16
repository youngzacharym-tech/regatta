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
  BULWARK_REINFORCED_SAVES,
  BULWARK_REINFORCED_TURNS,
  BULWARK_TURNS,
  CHARGE_CAP,
  CHARGE_SWEEP_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  PUSH_DISTANCE,
  PUSH_WARD_COST,
  PUSH_WARD_DISTANCE,
  REFLIPS_PER_TURN,
  ULTIMATE_STREAK,
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyWarpath,
  breakShieldStreak,
  canReflipAgain,
  consumeBulwarkBlocks,
  getBlinkStrikeTargets,
  getBulwarkBlockedIds,
  getBulwarkTargets,
  getChargedShotTargets,
  getLegalPowerMoves,
  getPushTargets,
  getRainOfArrowsTargets,
  getWarpathTargets,
  initialPowerState,
  isWarded,
  resetTurnFlags,
  tickBulwarkExpiry,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
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

function power(classes: Partial<Record<PlayerId, "archer" | "mage" | "warrior">>, charges: Partial<Record<PlayerId, number>> = {}): PowerState {
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
// 5. Ward Breaker: breaks a ward, grants transient safety that persists
//    across an unrelated move and clears when that token itself moves again
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
  check("Ward Breaker: grants transient safety to the landing token", r1.power.safeTokens.has(0));

  // An UNRELATED move by a different p1 token shouldn't clear token 0's safety.
  // (The Ward Breaker capture wasn't a shield landing, so the turn passed to
  // p2 — force it back to p1 to test "p1's next move" in isolation.)
  const s2: GameState = {
    ...r1.state,
    currentPlayer: "p1",
    tokens: r1.state.tokens.map((t) => (t.id === 1 ? { ...t, position: 0 } : t)),
  };
  const moves2 = getLegalPowerMoves(s2, r1.power, 1); // token 1 at 0 -> 1, a plain move
  const m2 = moves2.find((mv) => mv.tokenId === 1);
  const r2 = applyPowerMove(s2, r1.power, m2!, "p1");
  check("Ward Breaker: safety survives an unrelated move by the same player", r2.power.safeTokens.has(0));

  // Now move token 0 itself again — its safety should clear.
  const s3 = { ...r2.state, currentPlayer: "p1" as PlayerId };
  const moves3 = getLegalPowerMoves(s3, r2.power, 1); // token 0 at 6 -> 7 (shield) or similar
  const m3 = moves3.find((mv) => mv.tokenId === 0);
  if (m3) {
    const r3 = applyPowerMove(s3, r2.power, m3, "p1");
    check("Ward Breaker: safety clears once that token moves again", !r3.power.safeTokens.has(0));
  } else {
    check("Ward Breaker: safety clears once that token moves again", false, "no move found for token 0 to re-test with");
  }
}

// ---------------------------------------------------------------------------
// 6. Charge: sweeps intermediate captures (including warded ones — the
//    sweep pierces Ward same as Ward Breaker), stops at shield tiles and
//    transient safety, refuses when its own token blocks the lane
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

  // Transient safety (Ward Breaker's own "just captured, briefly immune"
  // grant) still blocks the sweep unconditionally, same as a shield tile —
  // this is the one protection with no exception for anyone, including
  // the Warrior that granted it.
  const sSafe = state("p1", { 0: 4, 4: 6 });
  const pwSafe: PowerState = { ...power({ p1: "warrior" }, { p1: 1 }), safeTokens: new Set([4]) };
  const movesSafe = getLegalPowerMoves(sSafe, pwSafe, 4);
  const mSafe = movesSafe.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: does not sweep a transiently-safe enemy",
    !!mSafe && !mSafe.chargeSweepCaptures.includes(4),
    JSON.stringify(mSafe),
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

  // Respects transient safety: the sole eligible candidate is safe — pool is
  // empty, so it fires into nothing (streak still consumed, not a silent no-op).
  const pwSafe: PowerState = { ...pwArcher2, safeTokens: new Set([4]) };
  const rSafe = applyPowerMove(s1, pwSafe, m1, "p1", () => 0);
  check(
    "Ultimate: respects transient safety — whiffs rather than picking a safe token",
    rSafe.rainOfArrows?.targetTokenId === null,
  );
  check("Ultimate: streak still resets to 0 on a whiff", rSafe.power.shieldStreak.p1 === 0);

  // Empty pool entirely (no enemies anywhere): also a clean whiff, and no
  // phantom charge beyond the ordinary landsOnShield grant.
  const sEmpty = state("p1", { 0: 6 });
  const mEmpty = getLegalPowerMoves(sEmpty, pwArcher2, 1).find((mv) => mv.tokenId === 0 && mv.to === 7)!;
  const rEmpty = applyPowerMove(sEmpty, pwArcher2, mEmpty, "p1", () => 0);
  check("Ultimate: whiffs cleanly with no enemies on the board at all", rEmpty.rainOfArrows?.targetTokenId === null);
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

  // Respects transient safety — a safe token is excluded from the target
  // pool entirely (inherited from getRainOfArrowsTargets).
  const sBlinkSafe = state("p1", { 0: 5, 4: 9 });
  const pwBlinkSafe: PowerState = { ...readyPower("mage"), safeTokens: new Set([4]) };
  check(
    "Blink Strike: a transiently-safe token is excluded from targets",
    !getBlinkStrikeTargets(sBlinkSafe, pwBlinkSafe, "p1").includes(4),
  );

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

  // Does not sweep a transiently-safe token.
  const pwWarSafe: PowerState = { ...readyPower("warrior"), safeTokens: new Set([4]) };
  const rWarSafe = applyWarpath(sWarSweep, pwWarSafe, 5, "p1");
  check("Warpath: does not sweep a transiently-safe token", rWarSafe.state.tokens.find((t) => t.id === 4)!.position === 6);
  check("Warpath: sweptTokenIds excludes the safe token", !rWarSafe.sweptTokenIds.includes(4));

  // Bypasses shield-tile protection AND Ward for a SWEPT token (not just the
  // primary target), and grants Ward Breaker-style transient safety to the
  // landing token because a Ward broke somewhere along the way. Teleporting
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
  check(
    "Warpath: grants transient safety to the landing token when a Ward breaks along the way",
    rWarWard.power.safeTokens.has(0),
  );

  // No Ward broken anywhere -> no safety grant.
  check("Warpath: no transient safety granted when no Ward was broken", !rWarSweep.power.safeTokens.has(0));

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
//     immunity to a normal capture/Snipe, a Charge sweep, Blink Strike, and
//     Warpath (folded into isProtected/isBulwarked); a Push can still knock
//     it around, just never send it all the way home; Rain of Arrows is a
//     deliberate exception (judgment call — not in the spec's explicit
//     4-action block list, and consistent with its "punches through
//     everything" identity, same as it already does to shield tiles/Ward).
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

  // --- Blocks Blink Strike --------------------------------------------------
  {
    const s = state("p1", { 0: 5, 4: 8 });
    const base = power({ p1: "mage" });
    const pw: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    const targets = getBlinkStrikeTargets(s, pw, "p1");
    check("Bulwark: excluded from Blink Strike's target pool", !targets.includes(4), JSON.stringify(targets));

    // Sanity: the same token IS a legal Blink Strike target without Bulwark.
    const pwNo: PowerState = { ...base, ultimateReady: { ...base.ultimateReady, p1: true } };
    check(
      "Bulwark: sanity — the same token is targetable without Bulwark",
      getBlinkStrikeTargets(s, pwNo, "p1").includes(4),
    );
  }

  // --- Blocks Warpath (both the primary target AND a swept token) ----------
  {
    const sTarget = state("p1", { 0: 4, 4: 9 });
    const baseW = power({ p1: "warrior" });
    const pwTarget: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    check(
      "Bulwark: excluded from Warpath's primary target pool",
      !getWarpathTargets(sTarget, pwTarget, "p1").includes(4),
    );

    // Sweep victim Bulwarked (the primary target itself is unprotected).
    const sSweep = state("p1", { 0: 4, 4: 6, 5: 9 }); // mover token0 at 4; enemy4 at 6 (between, Bulwarked); target enemy5 at 9
    const pwSweep: PowerState = { ...baseW, ultimateReady: { ...baseW.ultimateReady, p1: true }, bulwarked: { 4: 3 } };
    const r = applyWarpath(sSweep, pwSweep, 5, "p1");
    check("Bulwark: a swept token in Warpath's path is NOT captured", r.state.tokens.find((t) => t.id === 4)!.position === 6);
    check("Bulwark: the swept-but-Bulwarked id is excluded from sweptTokenIds", !r.sweptTokenIds.includes(4));
    check("Bulwark: the primary (unprotected) target is still captured", r.state.tokens.find((t) => t.id === 5)!.position === -1);
  }

  // --- Judgment call: Rain of Arrows still bypasses Bulwark -----------------
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
      "Bulwark: Rain of Arrows still bypasses Bulwark (deliberate — not in the spec's 4-action block list)",
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

    // Send-home-Push-only threat: same affordability gating.
    const sPushOnly = state("p1", { 4: 6, 5: 6 - PUSH_DISTANCE }); // p2 token4 Bulwarked; own-token collision at the landing tile
    const pwPushNoCharge: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 0 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a send-home-Push-only threat is NOT 'blocked' when the Archer has 0 charges",
      !getBulwarkBlockedIds(sPushOnly, pwPushNoCharge, 1).includes(4),
    );
    const pwPushWithCharge: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a send-home-Push threat DOES count as blocked once the Archer can afford it",
      getBulwarkBlockedIds(sPushOnly, pwPushWithCharge, 1).includes(4),
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

  // --- Protection semantics while up: identical to plain (isBulwarked) ------
  {
    // Blink Strike still can't target it (Bulwark blocks ultimates, plain or
    // reinforced), and a soft Push is still allowed while a send-home Push
    // is still blocked — the same isBulwarked-driven rules as section 14,
    // exercised here with a REINFORCED record shape (saves entry present).
    const base = power({ p1: "mage", p2: "warrior" }, { p1: 0 });
    const s = state("p1", { 0: 8, 4: 6 });
    const pwUlt: PowerState = {
      ...base,
      ultimateReady: { ...base.ultimateReady, p1: true },
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check(
      "Reinforced Bulwark: excluded from Blink Strike's target pool, same as plain",
      !getBlinkStrikeTargets(s, pwUlt, "p1").includes(4),
    );

    const sSoft = state("p1", { 0: 4, 4: 8 }); // push 8 -> 7: no collision, stays on board
    const pwSoft: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check("Reinforced Bulwark: a soft (non-home) Push target is still legal", getPushTargets(sSoft, pwSoft, "p1").includes(4));

    const sHome = state("p1", { 4: 0 }); // push 0 -> -1: send-home
    const pwHome: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: 1 }),
      bulwarked: { 4: BULWARK_REINFORCED_TURNS },
      bulwarkSaves: { 4: BULWARK_REINFORCED_SAVES },
    };
    check("Reinforced Bulwark: a send-home Push target is still NOT legal", !getPushTargets(sHome, pwHome, "p1").includes(4));
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
//     shield/transient-safety/Bulwark protections), but using
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

  // --- Legality: respects shield-tile and transient-safety, same as Push --
  {
    const pw = power({ p1: "archer" }, { p1: CHARGE_CAP });
    const sShield = state("p1", { 4: 7 }); // tile 7 is a shield tile
    check(
      "Charged Shot: a target on a shield tile is not a legal target",
      !getChargedShotTargets(sShield, pw, "p1").includes(4),
    );
    const sSafe = state("p1", { 4: 6 });
    const pwSafe: PowerState = { ...pw, safeTokens: new Set([4]) };
    check(
      "Charged Shot: a transiently-safe target is not a legal target",
      !getChargedShotTargets(sSafe, pwSafe, "p1").includes(4),
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

  // --- getBulwarkBlockedIds also recognizes a Charged-Shot-only threat,
  //     mirroring the Push branch exactly (same affordability gating, this
  //     ability's own charges === CHARGE_CAP instead of >= 1) ---------------
  {
    const posHome = 9;
    const sChargedShotOnly = state("p1", { 4: posHome, 5: posHome - CHARGED_SHOT_DISTANCE });
    const pwNoCap: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP - 1 }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a send-home-Charged-Shot-only threat is NOT 'blocked' below the full charge cap",
      !getBulwarkBlockedIds(sChargedShotOnly, pwNoCap, 1).includes(4),
    );
    const pwAtCap: PowerState = {
      ...power({ p1: "archer", p2: "warrior" }, { p1: CHARGE_CAP }),
      bulwarked: { 4: 3 },
    };
    check(
      "Bulwark: a send-home-Charged-Shot threat DOES count as blocked once the Archer is at the full charge cap",
      getBulwarkBlockedIds(sChargedShotOnly, pwAtCap, 1).includes(4),
    );
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
