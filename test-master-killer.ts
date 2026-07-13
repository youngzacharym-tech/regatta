// ============================================================================
// test-master-killer.ts — hand-constructed scenario checks for
// master-killer.ts. No formal test framework exists in this repo (see
// play-random-game.ts / batch-random-games.ts for the established
// script-based convention) — this follows the same pattern: plain
// assertions, clear PASS/FAIL summary, non-zero exit on any failure.
//
// Run: npx tsx test-master-killer.ts
// ============================================================================

import { PATH_LENGTH_PER_PLAYER, type GameState, type PlayerId, type TokenState } from "./rulebook.ts";
import {
  CHARGE_CAP,
  PUSH_DISTANCE,
  PUSH_WARD_COST,
  applyCharge,
  applyPowerMove,
  applyPush,
  applyReflip,
  getLegalPowerMoves,
  getPushTargets,
  initialPowerState,
  isWarded,
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
  // class that's SUPPOSED to break through a ward (see the Shieldbreaker
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
// 4. Re-flip: spends exactly one charge and flags itself used-this-turn
// ---------------------------------------------------------------------------
{
  const pw = power({ p1: "mage" }, { p1: CHARGE_CAP });
  const after = applyReflip(pw, "p1");
  check("Re-flip: spends exactly one charge", after.charges.p1 === CHARGE_CAP - 1);
  check("Re-flip: sets the once-per-turn flag", after.reflipUsedThisTurn === true);
  check("Re-flip: does not touch the other player's charges", after.charges.p2 === pw.charges.p2);
}

// ---------------------------------------------------------------------------
// 5. Shieldbreaker: breaks a ward, grants transient safety that persists
//    across an unrelated move and clears when that token itself moves again
// ---------------------------------------------------------------------------
{
  // p1 warrior token 0 at 4; p2 mage token 4 at 6, p2 at full charge (warded).
  const s = state("p1", { 0: 4, 4: 6 });
  const pw = power({ p1: "warrior", p2: "mage" }, { p2: CHARGE_CAP });
  const moves = getLegalPowerMoves(s, pw, 2); // 4 -> 6
  const m = moves.find((mv) => mv.tokenId === 0 && mv.to === 6);
  check("Shieldbreaker: landing on a warded enemy is legal for a Warrior", !!m);
  check("Shieldbreaker: captures the warded enemy", !!m && m.captures.includes(4));
  check("Shieldbreaker: flags breaksWard", !!m && m.breaksWard === true);

  const r1 = applyPowerMove(s, pw, m!, "p1");
  check("Shieldbreaker: grants transient safety to the landing token", r1.power.safeTokens.has(0));

  // An UNRELATED move by a different p1 token shouldn't clear token 0's safety.
  // (The Shieldbreaker capture wasn't a shield landing, so the turn passed to
  // p2 — force it back to p1 to test "p1's next move" in isolation.)
  const s2: GameState = {
    ...r1.state,
    currentPlayer: "p1",
    tokens: r1.state.tokens.map((t) => (t.id === 1 ? { ...t, position: 0 } : t)),
  };
  const moves2 = getLegalPowerMoves(s2, r1.power, 1); // token 1 at 0 -> 1, a plain move
  const m2 = moves2.find((mv) => mv.tokenId === 1);
  const r2 = applyPowerMove(s2, r1.power, m2!, "p1");
  check("Shieldbreaker: safety survives an unrelated move by the same player", r2.power.safeTokens.has(0));

  // Now move token 0 itself again — its safety should clear.
  const s3 = { ...r2.state, currentPlayer: "p1" as PlayerId };
  const moves3 = getLegalPowerMoves(s3, r2.power, 1); // token 0 at 6 -> 7 (shield) or similar
  const m3 = moves3.find((mv) => mv.tokenId === 0);
  if (m3) {
    const r3 = applyPowerMove(s3, r2.power, m3, "p1");
    check("Shieldbreaker: safety clears once that token moves again", !r3.power.safeTokens.has(0));
  } else {
    check("Shieldbreaker: safety clears once that token moves again", false, "no move found for token 0 to re-test with");
  }
}

// ---------------------------------------------------------------------------
// 6. Charge: sweeps intermediate captures, stops at shield/ward, refuses
//    when its own token blocks the lane
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

  // Warded intermediate enemy is also skipped by the sweep.
  const sWard = state("p1", { 0: 4, 4: 6 });
  const pwWard = power({ p1: "warrior", p2: "mage" }, { p1: 1, p2: CHARGE_CAP });
  const movesWard = getLegalPowerMoves(sWard, pwWard, 4);
  const mWard = movesWard.find((mv) => mv.tokenId === 0 && mv.to === 8);
  check(
    "Charge: does not sweep a warded intermediate enemy",
    !!mWard && !mWard.chargeSweepCaptures.includes(4),
    JSON.stringify(mWard),
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
// 9. Push vs Ward: Archer can target a warded token, but only by paying
//    PUSH_WARD_COST (both charges) instead of the normal 1.
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

  // Soft push (no collision): the warded token is still the mage's only
  // on-board token afterward, so it's STILL most-advanced/warded — a single
  // non-collision push doesn't strip Ward by itself, it just costs tempo.
  const sSoft = state("p1", { 4: 8, 5: 3 }); // id4 most-advanced/warded; id5 far behind
  const rSoft = applyPush(sSoft, pwRich, 4, "p1");
  const movedSoft = rSoft.state.tokens.find((t) => t.id === 4)!;
  check(
    "Push: a soft push against a warded token still lands it as most-advanced -> still warded",
    movedSoft.position === 8 - PUSH_DISTANCE && isWarded(rSoft.state, rSoft.power, movedSoft),
  );

  // Collision push: id4 (warded) is knocked into id5 (same owner) and bounces
  // to reserve — Ward is now permanently gone from id4 (reserved tokens are
  // never warded) and fully hands off to id5, the mage's only remaining
  // on-board token. This is the real, hard answer to a lone warded rusher.
  const sHard = state("p1", { 4: 6, 5: 5 }); // id4 warded @6; id5 sits at the push's landing tile
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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("All Master Killer rulebook scenarios pass.");
