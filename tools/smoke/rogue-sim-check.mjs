// Quick, throwaway smoke: play randomized Rogue-vs-X games directly through
// getLegalPowerMoves/applyPowerMove + the new Rogue oracles/applies, to
// catch runtime bugs (undefined access, bad math) before investing in the
// full test suite. Not a permanent test — deleted once real coverage lands.
import { initialState, flipCoins } from "../../rulebook.ts";
import {
  getLegalPowerMoves,
  applyPowerMove,
  applyCharge,
  initialPowerState,
  getPushTargets,
  applyPush,
  getChargedShotTargets,
  applyChargedShot,
  getPickpocketTargets,
  applyPickpocket,
  getBackstabTargets,
  applyBackstab,
  getGrandHeistTargets,
  applyGrandHeist,
  getBlinkStrikeTargets,
  applyBlinkStrike,
  getWarpathTargets,
  applyWarpath,
  getBulwarkTargets,
  applyBulwark,
  getBenedictionTargets,
  applyBenediction,
  getBlessTargets,
  applyBless,
  getHealTargets,
  applyHeal,
  getReviveSpawnTile,
  applyRevive,
  getCorpseExplosionTargets,
  applyCorpseExplosion,
  getExhumeTargets,
  applyExhume,
} from "../../master-killer.ts";

const CLASSES = ["archer", "mage", "warrior", "necromancer", "cleric", "rogue"];
let games = 0;
let pickpocketFires = 0;
let backstabKills = 0;
let backstabWounds = 0;
let grandHeists = 0;

function playGame(p1cls, p2cls, seed) {
  let rand = mulberry32(seed);
  let state = initialState();
  let power = { ...initialPowerState(), classes: { p1: p1cls, p2: p2cls } };
  let turns = 0;
  while (state.winner === null && turns < 400) {
    turns++;
    const mover = state.currentPlayer;
    const flip = flipCoins(rand);
    if (flip === 0) continue; // zero flips just pass in this smoke, no charge-grant plumbing needed
    let moves = getLegalPowerMoves(state, power, flip);

    // Try every Rogue action opportunistically, exercising all four kits.
    if (power.classes[mover] === "rogue") {
      const pt = getPickpocketTargets(state, power, mover);
      if (pt.length > 0 && rand() < 0.5) {
        const before = power.charges[mover === "p1" ? "p2" : "p1"];
        power = applyPickpocket(power, mover);
        pickpocketFires++;
        if (power.charges[mover === "p1" ? "p2" : "p1"] > before) throw new Error("Pickpocket increased foe charges!");
        continue;
      }
      const bt = getBackstabTargets(state, power, mover);
      if (bt.length > 0 && rand() < 0.5) {
        const r = applyBackstab(state, power, bt[0], mover);
        state = r.state;
        power = r.power;
        if (r.woundedTokenId !== null) backstabWounds++;
        else backstabKills++;
        continue;
      }
      if (power.ultimateReady[mover]) {
        const gt = getGrandHeistTargets(state, power, mover);
        if (gt.length > 0) {
          const r = applyGrandHeist(state, power, gt[0], mover);
          state = r.state;
          power = r.power;
          grandHeists++;
          continue;
        }
      }
    }

    // Generic power-move handling for whichever class is up.
    if (power.classes[mover] === "warrior" && power.charges[mover] >= 1) {
      const chargeMove = moves.find((m) => m.chargeAvailable && m.chargeSweepCaptures.length > 0);
      if (chargeMove) {
        const r = applyCharge(state, power, chargeMove, mover, rand);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "archer" && power.charges[mover] >= 1) {
      const pts = getPushTargets(state, power, mover);
      if (pts.length > 0 && rand() < 0.3) {
        const r = applyPush(state, power, pts[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
      const cts = getChargedShotTargets(state, power, mover);
      if (cts.length > 0 && rand() < 0.3) {
        const r = applyChargedShot(state, power, cts[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "warrior" && power.ultimateReady[mover]) {
      const wt = getWarpathTargets(state, power, mover);
      if (wt.length > 0) {
        const r = applyWarpath(state, power, wt[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "warrior" && power.charges[mover] >= 1 && rand() < 0.2) {
      const bts = getBulwarkTargets(state, power, mover);
      if (bts.length > 0) {
        const r = applyBulwark(state, power, bts[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "mage" && power.ultimateReady[mover]) {
      const mt = getBlinkStrikeTargets(state, power, mover);
      if (mt.length > 0) {
        const r = applyBlinkStrike(state, power, mt[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "cleric") {
      if (power.ultimateReady[mover]) {
        const bp = getBenedictionTargets(state, power, mover);
        if (bp.length > 0 && rand() < 0.5) {
          const r = applyBenediction(state, power, mover);
          state = r.state;
          power = r.power;
          continue;
        }
      }
      const blessT = getBlessTargets(state, power, mover);
      if (blessT.length > 0 && rand() < 0.3) {
        const r = applyBless(state, power, blessT[0], mover);
        power = r.power;
        moves = getLegalPowerMoves(state, power, flip);
      }
      const healT = getHealTargets(state, power, mover);
      if (healT.length > 0 && rand() < 0.3) {
        const r = applyHeal(state, power, healT[0], mover);
        state = r.state;
        power = r.power;
        continue;
      }
    }
    if (power.classes[mover] === "necromancer") {
      const spawnTile = getReviveSpawnTile(state, power, mover);
      if (spawnTile !== null && rand() < 0.4) {
        const r = applyRevive(state, power, mover);
        power = r.power;
        moves = getLegalPowerMoves(state, power, flip);
      }
      const blast = getCorpseExplosionTargets(state, power, mover);
      if (blast.length > 0 && rand() < 0.2) {
        const r = applyCorpseExplosion(state, power, mover);
        state = r.state;
        power = r.power;
        continue;
      }
      if (power.ultimateReady[mover]) {
        const et = getExhumeTargets(state, power, mover);
        if (et.length > 0) {
          const r = applyExhume(state, power, et[0], mover);
          state = r.state;
          power = r.power;
          continue;
        }
      }
    }

    if (moves.length === 0) continue;
    const pick = moves[Math.floor(rand() * moves.length)];
    const r = applyPowerMove(state, power, pick, mover, rand);
    state = r.state;
    power = r.power;
  }
  if (Object.values(power.charges).some((c) => c < 0)) throw new Error("Negative charges detected!");
  games++;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seed = 1;
for (const foe of CLASSES) {
  for (let i = 0; i < 200; i++) {
    playGame("rogue", foe, seed++);
    playGame(foe, "rogue", seed++);
  }
}
console.log(`${games} games completed with zero crashes.`);
console.log(`pickpocketFires=${pickpocketFires} backstabKills=${backstabKills} backstabWounds=${backstabWounds} grandHeists=${grandHeists}`);
