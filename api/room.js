// api/room.ts
import Redis from "ioredis";
import { randomUUID } from "crypto";

// rulebook.ts
var TOKENS_PER_PLAYER = 4;
var COINS_PER_PLAYER = 4;
var PATH_LENGTH_PER_PLAYER = 15;
var BOARD_LAYOUT = [
  // --- own safe start row (4 tiles) — only own tokens; last tile is a shield ---
  { index: 0, type: "safe", isContested: false },
  { index: 1, type: "safe", isContested: false },
  { index: 2, type: "safe", isContested: false },
  { index: 3, type: "shield", isContested: false },
  // 4th tile of safe row
  // --- contested middle row (8 tiles) — swords, with one shield at 4th position ---
  { index: 4, type: "sword", isContested: true },
  // 1st of middle
  { index: 5, type: "sword", isContested: true },
  // 2nd
  { index: 6, type: "sword", isContested: true },
  // 3rd
  { index: 7, type: "shield", isContested: true },
  // 4th — middle shield
  { index: 8, type: "sword", isContested: true },
  // 5th
  { index: 9, type: "sword", isContested: true },
  // 6th
  { index: 10, type: "sword", isContested: true },
  // 7th
  { index: 11, type: "sword", isContested: true },
  // 8th (last of middle)
  // --- own safe finish row (2 tiles) — last tile is a shield ---
  { index: 12, type: "safe", isContested: false },
  { index: 13, type: "shield", isContested: false },
  // shield at last safe tile
  // --- finish tile — exact roll to enter ---
  { index: 14, type: "finish", isContested: false }
];
function initialState() {
  const tokens = [];
  for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
    tokens.push({ id: i, owner: "p1", position: -1 });
  }
  for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
    tokens.push({ id: i + TOKENS_PER_PLAYER, owner: "p2", position: -1 });
  }
  return {
    tokens,
    currentPlayer: "p1",
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
}
function flipCoins(rand = Math.random) {
  let marked = 0;
  for (let i = 0; i < COINS_PER_PLAYER; i++) {
    if (rand() < 0.5) marked++;
  }
  return marked;
}
function getLegalMoves(state, flip) {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];
  const player = state.currentPlayer;
  const moves = [];
  for (const token of state.tokens) {
    if (token.owner !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue;
    const from = token.position;
    const to = from === -1 ? flip - 1 : from + flip;
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      const remaining = state.tokens.filter(
        (t) => t.owner === player && t.id !== token.id && t.position < PATH_LENGTH_PER_PLAYER
      );
      moves.push({
        tokenId: token.id,
        from,
        to: PATH_LENGTH_PER_PLAYER,
        captures: [],
        landsOnShield: false,
        causesWin: remaining.length === 0
      });
      continue;
    }
    const destTile = BOARD_LAYOUT[to];
    const occupants = state.tokens.filter(
      (t) => t.position === to && t.id !== token.id && (destTile.isContested || t.owner === player)
    );
    const self = occupants.find((t) => t.owner === player);
    const enemy = occupants.find((t) => t.owner !== player);
    if (self) continue;
    if (enemy && destTile.type === "shield") continue;
    moves.push({
      tokenId: token.id,
      from,
      to,
      captures: enemy ? [enemy.id] : [],
      landsOnShield: destTile.type === "shield",
      causesWin: false
    });
  }
  return moves;
}
function applyMove(state, move) {
  const tokens = state.tokens.map((t) => {
    if (t.id === move.tokenId) return { ...t, position: move.to };
    if (move.captures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });
  const extraTurn = move.landsOnShield;
  const nextPlayer = extraTurn ? state.currentPlayer : otherPlayer(state.currentPlayer);
  return {
    tokens,
    currentPlayer: nextPlayer,
    lastFlip: null,
    // Q5b: shield extra turn = fresh flip
    winner: move.causesWin ? state.currentPlayer : null,
    extraTurn
  };
}
function applyNoMove(state) {
  return {
    ...state,
    currentPlayer: otherPlayer(state.currentPlayer),
    lastFlip: null,
    extraTurn: false
  };
}
function otherPlayer(p) {
  return p === "p1" ? "p2" : "p1";
}

// bot-difficulty.ts
var FLIP_WEIGHTS = [1, 4, 6, 4, 1];
var FLIP_WEIGHT_TOTAL = 16;
var EASY_HEED_P = 0.35;
function normalizeDifficulty(d) {
  return d === "easy" || d === "hard" ? d : "standard";
}

// bot.ts
var EVAL_ESCAPED = 200;
var EVAL_PER_TILE = 8;
var EVAL_RESERVE = -20;
var EVAL_SHIELD_TILE = 10;
var EVAL_HOME_STRETCH = 16;
var WIN_VALUE = 1e6;
function pickBotMove(state, moves, rand = Math.random, difficulty = "standard") {
  if (difficulty === "easy") return pickEasy(state, moves, rand);
  if (difficulty === "hard") return pickHard(state, moves, rand);
  return pickStandard(state, moves, rand);
}
function pickStandard(state, moves, rand) {
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;
    if (m.causesWin) score += 1e3;
    if (m.captures.length > 0) {
      const victimProgress = Math.max(
        ...m.captures.map((id) => {
          const t = state.tokens.find((tok) => tok.id === id);
          return t ? t.position : 0;
        })
      );
      score += 400 + victimProgress * 10;
    }
    if (m.landsOnShield) score += 250;
    if (m.to === PATH_LENGTH_PER_PLAYER) score += 300;
    if (m.from === -1) score += 60;
    const fromContested = m.from >= 0 && BOARD_LAYOUT[m.from]?.isContested;
    const toSafe = m.to < PATH_LENGTH_PER_PLAYER && !BOARD_LAYOUT[m.to]?.isContested;
    if (fromContested && toSafe) score += 120;
    if (m.to < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[m.to]?.isContested && BOARD_LAYOUT[m.to]?.type !== "shield") {
      const threatened = state.tokens.some(
        (t) => t.owner !== state.currentPlayer && t.position >= 0 && m.to - t.position >= 1 && m.to - t.position <= 4
      );
      if (threatened) score -= 80;
    }
    score += m.to;
    score += rand() * 20;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}
function pickEasy(state, moves, rand) {
  const winIdx = moves.findIndex((m) => m.causesWin);
  if (winIdx !== -1) return winIdx;
  if (rand() < EASY_HEED_P) return pickStandard(state, moves, rand);
  return Math.floor(rand() * moves.length);
}
function evalSide(state, player) {
  let score = 0;
  for (const t of state.tokens) {
    if (t.owner !== player) continue;
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) {
      score += EVAL_RESERVE;
      continue;
    }
    score += EVAL_PER_TILE * t.position;
    if (t.position >= 12) score += EVAL_HOME_STRETCH;
    if (BOARD_LAYOUT[t.position].type === "shield") score += EVAL_SHIELD_TILE;
  }
  return score;
}
function evaluateClassic(state, me) {
  const foe = me === "p1" ? "p2" : "p1";
  return evalSide(state, me) - evalSide(state, foe);
}
function myBestShallow(state, flip, me) {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin ? WIN_VALUE : evaluateClassic(applyMove(state, m), me);
    if (v > best) best = v;
  }
  return best;
}
function myTurnExpectation(state, me) {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    value += FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL * myBestShallow(state, f, me);
  }
  return value;
}
function oppExtraTurnExpectation(state, me) {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    let leaf;
    if (f === 0) {
      leaf = evaluateClassic(state, me);
    } else {
      const moves = getLegalMoves(state, f);
      if (moves.length === 0) {
        leaf = evaluateClassic(state, me);
      } else {
        leaf = Infinity;
        for (const m of moves) {
          const v = m.causesWin ? -WIN_VALUE : evaluateClassic(applyMove(state, m), me);
          if (v < leaf) leaf = v;
        }
      }
    }
    value += FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL * leaf;
  }
  return value;
}
function worstOppReply(state, flip, me) {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let worst = Infinity;
  for (const m of moves) {
    let v;
    if (m.causesWin) {
      v = -WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      v = next.currentPlayer === me ? myTurnExpectation(next, me) : oppExtraTurnExpectation(next, me);
    }
    if (v < worst) worst = v;
  }
  return worst;
}
function oppReplyExpectation(state, me) {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    value += FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL * worstOppReply(state, f, me);
  }
  return value;
}
function bestOwnFollowup(state, flip, me) {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let best = -Infinity;
  for (const m of moves) {
    let v;
    if (m.causesWin) {
      v = WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      v = next.currentPlayer === me ? evaluateClassic(next, me) : oppReplyExpectation(next, me);
    }
    if (v > best) best = v;
  }
  return best;
}
function pickHard(state, moves, rand) {
  const me = state.currentPlayer;
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let value;
    if (m.causesWin) {
      value = WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      value = 0;
      for (let f = 0; f <= 4; f++) {
        const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
        value += p * (next.currentPlayer === me ? bestOwnFollowup(next, f, me) : worstOppReply(next, f, me));
      }
    }
    value += rand() * 1e-3;
    if (value > bestScore) {
      bestScore = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// master-killer.ts
function otherPlayerId(p) {
  return p === "p1" ? "p2" : "p1";
}
var CHARGE_CAP = 2;
var REFLIPS_PER_TURN = 2;
var PUSH_DISTANCE = 1;
var CHARGE_SWEEP_CAP = 1;
var WARD_SCOPE = "most-advanced";
var PUSH_WARD_COST = 1;
var PUSH_WARD_DISTANCE = 0;
var CHARGED_SHOT_DISTANCE = 4;
var CHARGED_SHOT_WARD_DISTANCE = 3;
var ULTIMATE_STREAK = 3;
var BULWARK_TURNS = 2;
var BULWARK_REINFORCED_TURNS = 4;
var BULWARK_REINFORCED_SAVES = 2;
var SOUL_BOUNTY_CHARGES = 3;
var NECRO_CHARGE_CAP = 3;
var THRALL_TURNS = 3;
var REVIVE_COST = 3;
var CORPSE_EXPLOSION_COST = 2;
var CORPSE_EXPLOSION_RADIUS = 1;
var EXHUME_RETURN_POSITION = 11;
function initialPowerState() {
  return {
    classes: { p1: "archer", p2: "archer" },
    // placeholder until picked
    charges: { p1: 0, p2: 0 },
    reflipsUsedThisTurn: 0,
    shieldStreak: { p1: 0, p2: 0 },
    ultimateReady: { p1: false, p2: false },
    bulwarked: {},
    bulwarkSaves: {},
    corpse: { p1: null, p2: null },
    thrall: { p1: null, p2: null }
  };
}
function resetTurnFlags(power) {
  return { ...power, reflipsUsedThisTurn: 0 };
}
function canReflipAgain(power, mover) {
  return power.charges[mover] >= 1 && power.reflipsUsedThisTurn < REFLIPS_PER_TURN;
}
function possessorOf(power, tokenId) {
  if (power.thrall.p1?.tokenId === tokenId) return "p1";
  if (power.thrall.p2?.tokenId === tokenId) return "p2";
  return null;
}
function effectiveOwner(power, token) {
  return possessorOf(power, token.id) ?? token.owner;
}
function isMostAdvanced(state, power, token) {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  if (possessorOf(power, token.id) !== null) return false;
  const mine = state.tokens.filter(
    (t) => t.owner === token.owner && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER && possessorOf(power, t.id) === null
  );
  if (mine.length === 0) return false;
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best;
}
function findMostAdvancedToken(state, power, mover) {
  const mine = state.tokens.filter(
    (t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => t.position > best.position ? t : best);
}
function findLeastAdvancedToken(state, power, mover) {
  const mine = state.tokens.filter(
    (t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => t.position < best.position ? t : best);
}
function isWarded(state, power, token) {
  if (power.classes[token.owner] !== "mage") return false;
  if (power.charges[token.owner] < CHARGE_CAP) return false;
  if (WARD_SCOPE === "most-advanced") return isMostAdvanced(state, power, token);
  return true;
}
function onShieldTile(token) {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  return BOARD_LAYOUT[token.position].type === "shield";
}
function isBulwarked(power, token) {
  return power.bulwarked[token.id] !== void 0;
}
function isBulwarkReinforced(power, token) {
  return power.bulwarkSaves[token.id] !== void 0;
}
function isProtected(state, power, token) {
  return onShieldTile(token) || isWarded(state, power, token) || isBulwarked(power, token);
}
function pushCost(state, power, target) {
  return isWarded(state, power, target) ? PUSH_WARD_COST : 1;
}
function pushDistance(state, power, target) {
  return isWarded(state, power, target) ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
}
function addCharge(power, player) {
  const current = power.charges[player];
  if (current >= CHARGE_CAP) return power;
  return { ...power, charges: { ...power.charges, [player]: current + 1 } };
}
function grantZeroFlipCharge(power, mover) {
  return addCharge(power, mover);
}
function grantKillBounty(power, mover, count) {
  if (count <= 0 || power.classes[mover] !== "necromancer") return power;
  const current = power.charges[mover];
  const next = Math.min(NECRO_CHARGE_CAP, current + count * SOUL_BOUNTY_CHARGES);
  if (next === current) return power;
  return { ...power, charges: { ...power.charges, [mover]: next } };
}
function clearThrallIfCaptured(power, capturedIds) {
  const hit = ["p1", "p2"].filter((pl) => {
    const th = power.thrall[pl];
    return th !== null && capturedIds.includes(th.tokenId);
  });
  if (hit.length === 0) return power;
  const thrall = { ...power.thrall };
  for (const pl of hit) thrall[pl] = null;
  return { ...power, thrall };
}
function getLegalPowerMoves(state, power, flip) {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];
  const player = state.currentPlayer;
  const cls = power.classes[player];
  const moves = [];
  for (const token of state.tokens) {
    if (effectiveOwner(power, token) !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue;
    const isThrall = possessorOf(power, token.id) === player;
    const from = token.position;
    const to = from === -1 ? flip - 1 : from + flip;
    if (from === -1) {
      const foe = otherPlayerId(player);
      if (power.classes[foe] === "necromancer" && power.corpse[foe]?.tokenId === token.id && power.charges[foe] === REVIVE_COST) {
        continue;
      }
    }
    if (isThrall && to > 11) continue;
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      const remaining = state.tokens.filter(
        (t) => t.owner === player && t.id !== token.id && t.position < PATH_LENGTH_PER_PLAYER
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
        chargeSweepCaptures: []
      });
      continue;
    }
    const destTile = BOARD_LAYOUT[to];
    const occupants = state.tokens.filter(
      (t) => t.position === to && t.id !== token.id && (destTile.isContested || t.owner === player)
    );
    const self = occupants.find((t) => effectiveOwner(power, t) === player);
    const enemy = occupants.find((t) => effectiveOwner(power, t) !== player);
    if (self) continue;
    let captures = [];
    let breaksWard = false;
    if (enemy) {
      if (onShieldTile(enemy) || isBulwarked(power, enemy)) continue;
      if (isWarded(state, power, enemy)) {
        if (cls !== "warrior" && !isThrall) continue;
        breaksWard = true;
        captures = [enemy.id];
      } else {
        captures = [enemy.id];
      }
    }
    const bonusCaptures = [];
    if (cls === "archer" && BOARD_LAYOUT[to + 1].isContested) {
      const sniped = state.tokens.find(
        (t) => t.position === to + 1 && effectiveOwner(power, t) !== player && t.id !== enemy?.id
      );
      if (sniped && !isProtected(state, power, sniped)) {
        bonusCaptures.push(sniped.id);
      }
    }
    let chargeAvailable = false;
    const chargeSweepCaptures = [];
    if (cls === "warrior" && from >= 0) {
      let laneClear = true;
      for (let i = from + 1; i < to; i++) {
        const tile = BOARD_LAYOUT[i];
        if (!tile.isContested) continue;
        const occ = state.tokens.filter((t) => t.position === i && t.id !== token.id);
        if (occ.some((t) => effectiveOwner(power, t) === player)) {
          laneClear = false;
          break;
        }
        const foe = occ.find((t) => effectiveOwner(power, t) !== player);
        if (foe && chargeSweepCaptures.length < CHARGE_SWEEP_CAP && !onShieldTile(foe) && !isBulwarked(power, foe)) {
          chargeSweepCaptures.push(foe.id);
        }
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
      chargeSweepCaptures
    });
  }
  return moves;
}
function getRainOfArrowsTargets(state, power, mover) {
  const foe = otherPlayerId(mover);
  return state.tokens.filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => BOARD_LAYOUT[t.position].isContested).map((t) => t.id);
}
function breakShieldStreak(power, player) {
  if (power.shieldStreak[player] === 0) return power;
  return { ...power, shieldStreak: { ...power.shieldStreak, [player]: 0 } };
}
function resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand) {
  if (!landsOnShield) return { power: breakShieldStreak(power, mover), rainOfArrows: null };
  const next = power.shieldStreak[mover] + 1;
  if (next < ULTIMATE_STREAK) {
    return { power: { ...power, shieldStreak: { ...power.shieldStreak, [mover]: next } }, rainOfArrows: null };
  }
  const reset = { ...power, shieldStreak: { ...power.shieldStreak, [mover]: 0 } };
  const cls = power.classes[mover];
  if (cls !== "archer") {
    return { power: { ...reset, ultimateReady: { ...reset.ultimateReady, [mover]: true } }, rainOfArrows: null };
  }
  const pool = getRainOfArrowsTargets(state, reset, mover).filter((id) => !allCaptures.includes(id));
  if (pool.length === 0) return { power: reset, rainOfArrows: { targetTokenId: null } };
  const picked = pool[Math.floor(rand() * pool.length)];
  return { power: reset, rainOfArrows: { targetTokenId: picked } };
}
function resolveTurn(state, power, mover, tokenId, to, allCaptures, landsOnShield, causesWin, rand = Math.random) {
  const streakResult = resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand);
  power = streakResult.power;
  const rainOfArrows = streakResult.rainOfArrows;
  const finalCaptures = rainOfArrows?.targetTokenId != null ? [...allCaptures, rainOfArrows.targetTokenId] : allCaptures;
  const tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (finalCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });
  let bulwarked = power.bulwarked;
  let bulwarkSaves = power.bulwarkSaves;
  if (finalCaptures.some((id) => bulwarked[id] !== void 0)) {
    bulwarked = { ...bulwarked };
    bulwarkSaves = { ...bulwarkSaves };
    for (const id of finalCaptures) {
      delete bulwarked[id];
      delete bulwarkSaves[id];
    }
  }
  let nextPower = { ...power, bulwarked, bulwarkSaves };
  nextPower = clearThrallIfCaptured(nextPower, finalCaptures);
  const foe = otherPlayerId(mover);
  const soulKills = power.classes[mover] === "necromancer" ? finalCaptures.filter((id) => state.tokens.find((t) => t.id === id)?.owner === foe) : [];
  if (soulKills.length > 0) {
    nextPower = grantKillBounty(nextPower, mover, soulKills.length);
    nextPower = {
      ...nextPower,
      corpse: { ...nextPower.corpse, [mover]: { tokenId: soulKills[soulKills.length - 1], tile: to } }
    };
    if (landsOnShield) nextPower = addCharge(nextPower, mover);
  } else if (finalCaptures.length > 0 || landsOnShield) {
    nextPower = addCharge(nextPower, mover);
  }
  const extraTurn = landsOnShield;
  const nextState = {
    tokens,
    currentPlayer: extraTurn ? mover : otherPlayerId(mover),
    lastFlip: null,
    winner: causesWin ? mover : null,
    extraTurn
  };
  return { state: nextState, power: resetTurnFlags(nextPower), rainOfArrows };
}
function applyPowerMove(state, power, move, mover, rand = Math.random) {
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
    rand
  );
}
function applyCharge(state, power, move, mover, rand = Math.random) {
  const allCaptures = [...move.captures, ...move.bonusCaptures, ...move.chargeSweepCaptures];
  const spent = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 }
  };
  return resolveTurn(
    state,
    spent,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    rand
  );
}
function computeKnockbackLanding(state, power, target, distance) {
  const rawTo = target.position - distance;
  if (possessorOf(power, target.id) !== null && rawTo < 4) return -1;
  const contestedLanding = rawTo >= 0 && rawTo < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[rawTo].isContested;
  const collides = state.tokens.some(
    (t) => t.id !== target.id && t.position === rawTo && (t.owner === target.owner || contestedLanding)
  );
  return collides || rawTo < 0 ? -1 : rawTo;
}
function computePushLanding(state, power, target) {
  return computeKnockbackLanding(state, power, target, pushDistance(state, power, target));
}
function computeChargedShotLanding(state, power, target) {
  const distance = isWarded(state, power, target) ? CHARGED_SHOT_WARD_DISTANCE : CHARGED_SHOT_DISTANCE;
  return computeKnockbackLanding(state, power, target, distance);
}
function getPushTargets(state, power, mover) {
  const foe = otherPlayerId(mover);
  return state.tokens.filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => BOARD_LAYOUT[t.position].isContested).filter((t) => !onShieldTile(t)).filter((t) => !isWarded(state, power, t) || power.charges[mover] >= PUSH_WARD_COST).filter((t) => !isBulwarkReinforced(power, t)).filter((t) => !isBulwarked(power, t) || computePushLanding(state, power, t) !== -1).map((t) => t.id);
}
function applyPush(state, power, targetTokenId, mover) {
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const cost = pushCost(state, power, target);
  const landing = computePushLanding(state, power, target);
  const sendsHome = landing === -1;
  const tokens = state.tokens.map((t) => t.id === targetTokenId ? { ...t, position: landing } : t);
  let spentPower = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - cost }
  };
  if (sendsHome) {
    spentPower = addCharge(spentPower, mover);
    spentPower = clearThrallIfCaptured(spentPower, [targetTokenId]);
  }
  spentPower = breakShieldStreak(spentPower, mover);
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(spentPower) };
}
function getChargedShotTargets(state, power, mover) {
  if (power.charges[mover] !== CHARGE_CAP) return [];
  const foe = otherPlayerId(mover);
  return state.tokens.filter((t) => effectiveOwner(power, t) === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => BOARD_LAYOUT[t.position].isContested).filter((t) => !onShieldTile(t)).filter((t) => !isBulwarked(power, t) || computeChargedShotLanding(state, power, t) !== -1).map((t) => t.id);
}
function applyChargedShot(state, power, targetTokenId, mover) {
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const landing = computeChargedShotLanding(state, power, target);
  const sendsHome = landing === -1;
  const tokens = state.tokens.map((t) => t.id === targetTokenId ? { ...t, position: landing } : t);
  let spentPower = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CHARGE_CAP }
  };
  if (sendsHome) {
    spentPower = addCharge(spentPower, mover);
    spentPower = clearThrallIfCaptured(spentPower, [targetTokenId]);
  }
  spentPower = breakShieldStreak(spentPower, mover);
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(spentPower) };
}
function applyReflip(power, mover) {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    reflipsUsedThisTurn: power.reflipsUsedThisTurn + 1
  };
}
function getBlinkStrikeTargets(state, power, mover) {
  if (!findMostAdvancedToken(state, power, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}
function getWarpathTargets(state, power, mover) {
  if (!findLeastAdvancedToken(state, power, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}
function clearCapturedBulwarks(power, capturedIds) {
  if (!capturedIds.some((id) => power.bulwarked[id] !== void 0)) return power;
  const bulwarked = { ...power.bulwarked };
  const bulwarkSaves = { ...power.bulwarkSaves };
  for (const id of capturedIds) {
    delete bulwarked[id];
    delete bulwarkSaves[id];
  }
  return { ...power, bulwarked, bulwarkSaves };
}
function applyBlinkStrike(state, power, targetTokenId, mover) {
  const mine = findMostAdvancedToken(state, power, mover);
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let nextPower = clearCapturedBulwarks(
    {
      ...power,
      ultimateReady: { ...power.ultimateReady, [mover]: false }
    },
    [targetTokenId]
  );
  nextPower = clearThrallIfCaptured(nextPower, [targetTokenId]);
  nextPower = addCharge(nextPower, mover);
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: [] };
}
function applyWarpath(state, power, targetTokenId, mover) {
  const mine = findLeastAdvancedToken(state, power, mover);
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const from = mine.position;
  const to = target.position;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const sweepCaptures = [];
  for (let i = lo + 1; i < hi; i++) {
    if (!BOARD_LAYOUT[i].isContested) continue;
    const foe = state.tokens.find(
      (t) => t.position === i && effectiveOwner(power, t) !== mover && t.id !== mine.id && t.id !== targetTokenId
    );
    if (foe) {
      sweepCaptures.push(foe.id);
    }
  }
  const allCaptures = [targetTokenId, ...sweepCaptures];
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });
  let nextPower = clearCapturedBulwarks(
    {
      ...power,
      ultimateReady: { ...power.ultimateReady, [mover]: false }
    },
    allCaptures
  );
  nextPower = clearThrallIfCaptured(nextPower, allCaptures);
  nextPower = addCharge(nextPower, mover);
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: sweepCaptures };
}
function getBulwarkTargets(state, power, mover) {
  return state.tokens.filter((t) => effectiveOwner(power, t) === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => !isBulwarked(power, t)).map((t) => t.id);
}
function applyBulwark(state, power, targetTokenId, mover, reinforced = false) {
  const bulwarked = { ...power.bulwarked };
  const bulwarkSaves = { ...power.bulwarkSaves };
  let cost = 1;
  if (reinforced) {
    cost = CHARGE_CAP;
    bulwarked[targetTokenId] = BULWARK_REINFORCED_TURNS;
    bulwarkSaves[targetTokenId] = BULWARK_REINFORCED_SAVES;
  } else {
    bulwarked[targetTokenId] = BULWARK_TURNS;
  }
  const spent = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - cost },
    bulwarked,
    bulwarkSaves
  };
  const broken = breakShieldStreak(spent, mover);
  const nextState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(broken) };
}
function tickBulwarkExpiry(state, power, mover) {
  const mine = Object.keys(power.bulwarked).map(Number).filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover);
  if (mine.length === 0) return power;
  const bulwarked = { ...power.bulwarked };
  const bulwarkSaves = { ...power.bulwarkSaves };
  for (const id of mine) {
    const remaining = bulwarked[id] - 1;
    if (remaining <= 0) {
      delete bulwarked[id];
      delete bulwarkSaves[id];
    } else {
      bulwarked[id] = remaining;
    }
  }
  return { ...power, bulwarked, bulwarkSaves };
}
function getBulwarkBlockedIds(state, power, flip) {
  if (Object.keys(power.bulwarked).length === 0) return [];
  const mover = state.currentPlayer;
  const unbulwarked = { ...power, bulwarked: {} };
  const blocked = /* @__PURE__ */ new Set();
  const realMoves = getLegalPowerMoves(state, power, flip);
  const openMoves = getLegalPowerMoves(state, unbulwarked, flip);
  for (const om of openMoves) {
    const canCharge = power.charges[mover] >= 1 && om.chargeAvailable;
    const openCaptures = [...om.captures, ...om.bonusCaptures, ...canCharge ? om.chargeSweepCaptures : []];
    if (openCaptures.length === 0) continue;
    const rm = realMoves.find((m) => m.tokenId === om.tokenId && m.to === om.to);
    const realCaptures = rm ? [...rm.captures, ...rm.bonusCaptures, ...canCharge ? rm.chargeSweepCaptures : []] : [];
    for (const id of openCaptures) {
      if (power.bulwarked[id] !== void 0 && !realCaptures.includes(id)) blocked.add(id);
    }
  }
  return [...blocked];
}
function consumeBulwarkBlocks(power, blockedIds) {
  if (blockedIds.length === 0) return power;
  const bulwarked = { ...power.bulwarked };
  const bulwarkSaves = { ...power.bulwarkSaves };
  for (const id of blockedIds) {
    const saves = bulwarkSaves[id] ?? 1;
    if (saves > 1) {
      bulwarkSaves[id] = saves - 1;
    } else {
      delete bulwarked[id];
      delete bulwarkSaves[id];
    }
  }
  return { ...power, bulwarked, bulwarkSaves };
}
function tickBulwarkForNewTurn(state, power, flip) {
  const ticked = tickBulwarkExpiry(state, power, state.currentPlayer);
  const blocked = getBulwarkBlockedIds(state, ticked, flip);
  return { power: blocked.length > 0 ? consumeBulwarkBlocks(ticked, blocked) : ticked, blockedIds: blocked };
}
function tickBulwarkForReflip(state, power, flip) {
  const blocked = getBulwarkBlockedIds(state, power, flip);
  return { power: blocked.length > 0 ? consumeBulwarkBlocks(power, blocked) : power, blockedIds: blocked };
}
function getReviveSpawnTile(state, power, mover) {
  if (power.charges[mover] !== REVIVE_COST) return null;
  if (power.thrall[mover] !== null) return null;
  const corpse = power.corpse[mover];
  if (!corpse) return null;
  const body = state.tokens.find((t) => t.id === corpse.tokenId);
  if (!body || body.position !== -1) return null;
  const free = (tile) => !state.tokens.some((t) => t.position === tile);
  for (let tile = corpse.tile; tile >= 4; tile--) if (free(tile)) return tile;
  for (let tile = corpse.tile + 1; tile <= 11; tile++) if (free(tile)) return tile;
  return null;
}
function applyRevive(state, power, mover) {
  const corpse = power.corpse[mover];
  const tile = getReviveSpawnTile(state, power, mover);
  const tokens = state.tokens.map((t) => t.id === corpse.tokenId ? { ...t, position: tile } : t);
  const nextPower = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - REVIVE_COST },
    corpse: { ...power.corpse, [mover]: null },
    thrall: { ...power.thrall, [mover]: { tokenId: corpse.tokenId, turnsLeft: THRALL_TURNS } }
  };
  return { state: { ...state, tokens }, power: nextPower, raisedTokenId: corpse.tokenId, raisedTo: tile };
}
function getCorpseExplosionTargets(state, power, mover) {
  if (power.charges[mover] < CORPSE_EXPLOSION_COST) return [];
  const corpse = power.corpse[mover];
  if (!corpse) return [];
  const body = state.tokens.find((t) => t.id === corpse.tokenId);
  if (!body || body.position !== -1) return [];
  return state.tokens.filter((t) => effectiveOwner(power, t) !== mover).filter((t) => t.position >= 4 && t.position <= 11).filter((t) => Math.abs(t.position - corpse.tile) <= CORPSE_EXPLOSION_RADIUS).filter((t) => !isProtected(state, power, t)).map((t) => t.id);
}
function applyCorpseExplosion(state, power, mover) {
  const corpse = power.corpse[mover];
  const victims = getCorpseExplosionTargets(state, power, mover).map((id) => state.tokens.find((t) => t.id === id)).sort((a, b) => Math.abs(a.position - corpse.tile) - Math.abs(b.position - corpse.tile));
  let tokens = state.tokens;
  const sentHomeIds = [];
  let working = state;
  for (const victim of victims) {
    const current = working.tokens.find((t) => t.id === victim.id);
    const landing = computeKnockbackLanding(working, power, current, 1);
    if (landing === -1) sentHomeIds.push(victim.id);
    tokens = working.tokens.map((t) => t.id === victim.id ? { ...t, position: landing } : t);
    working = { ...working, tokens };
  }
  let nextPower = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CORPSE_EXPLOSION_COST },
    corpse: { ...power.corpse, [mover]: null }
  };
  nextPower = clearThrallIfCaptured(nextPower, sentHomeIds);
  nextPower = clearCapturedBulwarks(nextPower, sentHomeIds);
  nextPower = breakShieldStreak(nextPower, mover);
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return {
    state: nextState,
    power: resetTurnFlags(nextPower),
    struckTokenIds: victims.map((v) => v.id),
    sentHomeIds,
    tile: corpse.tile
  };
}
function tickThrallForNewTurn(state, power) {
  const mover = state.currentPlayer;
  const th = power.thrall[mover];
  if (!th) return { state, power, expiredTokenId: null };
  const turnsLeft = th.turnsLeft - 1;
  if (turnsLeft > 0) {
    return {
      state,
      power: { ...power, thrall: { ...power.thrall, [mover]: { ...th, turnsLeft } } },
      expiredTokenId: null
    };
  }
  const tokens = state.tokens.map((t) => t.id === th.tokenId ? { ...t, position: -1 } : t);
  return {
    state: { ...state, tokens },
    power: { ...power, thrall: { ...power.thrall, [mover]: null } },
    expiredTokenId: th.tokenId
  };
}
function getExhumeTargets(state, power, mover) {
  void power;
  const foe = otherPlayerId(mover);
  return state.tokens.filter((t) => t.owner === foe && t.position >= PATH_LENGTH_PER_PLAYER).map((t) => t.id);
}
function applyExhume(state, power, targetTokenId, mover) {
  const target = state.tokens.find((t) => t.id === targetTokenId);
  let landing = EXHUME_RETURN_POSITION;
  while (landing >= 0) {
    const contested = BOARD_LAYOUT[landing].isContested;
    const occupied = state.tokens.some(
      (t) => t.id !== target.id && t.position === landing && (t.owner === target.owner || contested)
    );
    if (!occupied) break;
    landing--;
  }
  const tokens = state.tokens.map((t) => t.id === targetTokenId ? { ...t, position: landing } : t);
  let bulwarked = power.bulwarked;
  let bulwarkSaves = power.bulwarkSaves;
  if (bulwarked[targetTokenId] !== void 0) {
    bulwarked = { ...bulwarked };
    bulwarkSaves = { ...bulwarkSaves };
    delete bulwarked[targetTokenId];
    delete bulwarkSaves[targetTokenId];
  }
  const nextPower = {
    ...power,
    bulwarked,
    bulwarkSaves,
    ultimateReady: { ...power.ultimateReady, [mover]: false }
  };
  const nextState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false
  };
  return { state: nextState, power: resetTurnFlags(nextPower), returnedTo: landing };
}

// master-killer-bot.ts
var MK_STD_NECRO_SHIELD_EXTRA = 250;
var MK_STD_NECRO_RACE_SCALE = 1;
var MK_STD_NECRO_CAPTURE_SCALE = 2.5;
var MK_STD_NECRO_HUNT = 65;
function scoreMove(state, m, extraCaptures, rand, shieldExtra = 0, raceScale = 1, captureScale = 1, huntPerTarget = 0) {
  let score = 0;
  const allCaptures = [...m.captures, ...m.bonusCaptures, ...extraCaptures];
  if (m.causesWin) score += 1e3;
  if (allCaptures.length > 0) {
    const victimProgress = Math.max(
      ...allCaptures.map((id) => state.tokens.find((t) => t.id === id)?.position ?? 0)
    );
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
      (t) => t.owner !== state.currentPlayer && t.position >= 0 && m.to - t.position >= 1 && m.to - t.position <= 4
    );
    if (threatened) score -= 80;
  }
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
function scorePush(state, power, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  const warded = isWarded(state, power, target);
  const distance = warded ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
  const rawTo = target.position - distance;
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo
  );
  const sendsHome = collides || rawTo < 0;
  let score;
  if (sendsHome) {
    score = 350 + target.position * 8;
    if (warded) score += 250;
  } else {
    score = 180 * distance + target.position * 8;
  }
  score += rand() * 20;
  return score;
}
function scoreChargedShot(state, power, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  const warded = isWarded(state, power, target);
  const rawTo = target.position - (warded ? CHARGED_SHOT_WARD_DISTANCE : CHARGED_SHOT_DISTANCE);
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo
  );
  const sendsHome = collides || rawTo < 0;
  let score = (sendsHome ? 420 : 20) + target.position * 10;
  score += rand() * 20;
  return score;
}
function scoreUltimateStrike(state, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  let score = 500 + target.position * 10;
  score += rand() * 20;
  return score;
}
function scoreBulwark(state, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  let score = -40 + target.position * 3;
  score += rand() * 20;
  return score;
}
function bulwarkFacesThreat(state, target) {
  if (target.position < 0 || target.position >= PATH_LENGTH_PER_PLAYER) return false;
  const tile = BOARD_LAYOUT[target.position];
  if (!tile.isContested || tile.type === "shield") return false;
  return state.tokens.some(
    (t) => t.owner !== target.owner && t.position >= 0 && target.position - t.position >= 1 && target.position - t.position <= 4
  );
}
function scoreReinforcedBulwark(state, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  if (!bulwarkFacesThreat(state, target)) return -Infinity;
  let score = -40 + target.position * 5;
  score += rand() * 20;
  return score;
}
function scoreReflip(currentMoveCount, flip, rand) {
  if (flip === 0 || currentMoveCount === 0) return 500 + rand() * 20;
  return -1;
}
function scoreCorpseExplosion(state, power, victims, rand) {
  const mover = state.currentPlayer;
  let score = 0;
  for (const id of victims) {
    const t = state.tokens.find((tok) => tok.id === id);
    const landing = (
      // mirror applyCorpseExplosion's per-victim physics for the estimate
      t.position - 1 < 4 && possessorOf(power, t.id) !== null ? -1 : state.tokens.some(
        (o) => o.id !== t.id && o.position === t.position - 1 && (o.owner === t.owner || t.position - 1 >= 4 && t.position - 1 <= 11)
      ) ? -1 : t.position - 1
    );
    score += landing === -1 ? 380 + t.position * 8 : 90;
  }
  return score + rand() * 20;
}
function scoreRevive(state, power, spawnTile, rand) {
  const mover = state.currentPlayer;
  let threatened = 0;
  for (const t of state.tokens) {
    if (t.owner === mover || possessorOf(power, t.id) !== null) continue;
    if (t.position <= spawnTile || t.position > spawnTile + 4) continue;
    if (t.position >= 4 && t.position <= 11) threatened++;
  }
  return 900 + 30 * threatened + rand() * 20;
}
function scoreExhume(rand) {
  return 600 + rand() * 20;
}
function pickBotPowerAction(state, power, moves, flip, rand = Math.random, difficulty = "standard") {
  if (difficulty === "easy") return pickEasyPowerAction(state, power, moves, flip, rand);
  if (difficulty === "hard") return pickHardPowerAction(state, power, moves, flip, rand);
  return pickStandardPowerAction(state, power, moves, flip, rand);
}
function pickStandardPowerAction(state, power, moves, flip, rand) {
  const mover = state.currentPlayer;
  const cls = power.classes[mover];
  const charges = power.charges[mover];
  let best = null;
  let bestScore = -Infinity;
  const necro = cls === "necromancer";
  const shieldExtra = necro ? MK_STD_NECRO_SHIELD_EXTRA : 0;
  const raceScale = necro ? MK_STD_NECRO_RACE_SCALE : 1;
  const captureScale = necro ? MK_STD_NECRO_CAPTURE_SCALE : 1;
  const huntPerTarget = necro ? MK_STD_NECRO_HUNT : 0;
  for (const m of moves) {
    const score = scoreMove(state, m, [], rand, shieldExtra, raceScale, captureScale, huntPerTarget);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "move", move: m };
    }
    if (cls === "warrior" && m.chargeAvailable && m.chargeSweepCaptures.length > 0 && charges >= 1) {
      const chargeScore = scoreMove(state, m, m.chargeSweepCaptures, rand) + 20;
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
    const spawnTile = getReviveSpawnTile(state, power, mover);
    if (spawnTile !== null) {
      const score = scoreRevive(state, power, spawnTile, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "revive" };
      }
    }
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
function enumerateCandidates(state, power, moves) {
  const mover = state.currentPlayer;
  const cls = power.classes[mover];
  const charges = power.charges[mover];
  const out = [];
  for (const m of moves) {
    out.push({ kind: "move", move: m });
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
    out.push({ kind: "revive" });
  }
  if (cls === "necromancer" && getCorpseExplosionTargets(state, power, mover).length > 0) {
    out.push({ kind: "corpseExplosion" });
  }
  if (cls === "necromancer" && power.ultimateReady[mover]) {
    const exhumeTargets = getExhumeTargets(state, power, mover);
    if (exhumeTargets.length > 0) out.push({ kind: "exhume", targetTokenId: exhumeTargets[0] });
  }
  return out;
}
function pickEasyPowerAction(state, power, moves, flip, rand) {
  const winMove = moves.find((m) => m.causesWin);
  if (winMove) return { kind: "move", move: winMove };
  if (rand() < EASY_HEED_P) return pickStandardPowerAction(state, power, moves, flip, rand);
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rand() * candidates.length)];
}
var MK_EVAL_ESCAPED = 200;
var MK_EVAL_PER_TILE = 8;
var MK_EVAL_SHIELD_TILE = 25;
var MK_EVAL_THREAT_BASE = 40;
var MK_EVAL_THREAT_PER_TILE = 6;
var MK_EVAL_CHARGE = 24;
var MK_EVAL_ULTIMATE = 70;
var MK_EVAL_NECRO_CHARGE = 4;
var MK_EVAL_CORPSE = 15;
var MK_EVAL_THRALL = 40;
var MK_EVAL_THRALL_MENACE = 15;
var MK_EVAL_NECRO_PREY_SCALE = 1.25;
var MK_EVAL_EXHUME_HELD = 20;
var MK_EVAL_REVIVE_BIAS = 20;
var MK_EVAL_STREAK = 12;
var MK_EVAL_BULWARK = 12;
var MK_WIN_VALUE = 1e6;
var SIM_RAND = () => 0.5;
function mkEvalSide(state, power, player) {
  const foe = player === "p1" ? "p2" : "p1";
  let score = 0;
  for (const t of state.tokens) {
    const possessor = possessorOf(power, t.id);
    if (t.owner === player && possessor !== null && possessor !== player) continue;
    if (t.owner !== player) {
      if (possessor !== player) continue;
      const turnsLeft = power.thrall[player]?.turnsLeft ?? 0;
      let menaced = 0;
      for (const e of state.tokens) {
        if (e.owner === player || possessorOf(power, e.id) !== null) continue;
        if (e.position > t.position && e.position <= t.position + 4 && e.position <= 11 && e.position >= 4) menaced++;
      }
      score += (MK_EVAL_THRALL + MK_EVAL_THRALL_MENACE * menaced) * turnsLeft / THRALL_TURNS;
      continue;
    }
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += MK_EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) continue;
    score += MK_EVAL_PER_TILE * t.position;
    const tile = BOARD_LAYOUT[t.position];
    if (tile.type === "shield") score += MK_EVAL_SHIELD_TILE;
    if (tile.isContested && tile.type !== "shield" && !isWarded(state, power, t) && !isBulwarked(power, t)) {
      const threatScale = power.classes[foe] === "necromancer" ? MK_EVAL_NECRO_PREY_SCALE : 1;
      for (const e of state.tokens) {
        if (effectiveOwner(power, e) === player || e.position < 0 || e.position >= PATH_LENGTH_PER_PLAYER)
          continue;
        const gap = t.position - e.position;
        if (gap >= 1 && gap <= 4) {
          score -= threatScale * (MK_EVAL_THREAT_BASE + MK_EVAL_THREAT_PER_TILE * t.position) * FLIP_WEIGHTS[gap] / FLIP_WEIGHT_TOTAL;
        }
      }
    }
    if (isBulwarked(power, t)) score += MK_EVAL_BULWARK;
  }
  const corpse = power.corpse[player];
  if (corpse && state.tokens.find((t) => t.id === corpse.tokenId)?.position === -1) {
    score += MK_EVAL_CORPSE;
  }
  score += (power.classes[player] === "necromancer" ? MK_EVAL_NECRO_CHARGE : MK_EVAL_CHARGE) * power.charges[player];
  if (power.ultimateReady[player]) {
    const necroWithExhumeTarget = power.classes[player] === "necromancer" && state.tokens.some((t) => t.owner !== player && t.position >= PATH_LENGTH_PER_PLAYER);
    score += necroWithExhumeTarget ? MK_EVAL_EXHUME_HELD : MK_EVAL_ULTIMATE;
  }
  score += MK_EVAL_STREAK * power.shieldStreak[player];
  return score;
}
function evaluateMK(state, power, me) {
  const foe = me === "p1" ? "p2" : "p1";
  return mkEvalSide(state, power, me) - mkEvalSide(state, power, foe);
}
function mkBestOwnFollowup(state, power, flip, me) {
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
function mkWorstOppReply(state, power, flip, me) {
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
function mkValueAfterAction(state, power, me) {
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
function mkReflipValue(state, power, me) {
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
      const v = m.causesWin ? MK_WIN_VALUE : (() => {
        const r = applyPowerMove(state, powerR, m, me, SIM_RAND);
        return mkValueAfterAction(r.state, r.power, me);
      })();
      if (v > best) best = v;
    }
    value += p * best;
  }
  return value;
}
function mkSimulate(state, power, c, mover) {
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
  }
}
function mkReviveValue(state, power, flip, me) {
  const r = applyRevive(state, power, me);
  if (flip === 0) return evaluateMK(r.state, r.power, me);
  const moves = getLegalPowerMoves(r.state, r.power, flip);
  if (moves.length === 0) return evaluateMK(r.state, r.power, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin ? MK_WIN_VALUE : (() => {
      const q = applyPowerMove(r.state, r.power, m, me, SIM_RAND);
      return mkValueAfterAction(q.state, q.power, me);
    })();
    if (v > best) best = v;
  }
  return best;
}
function pickHardPowerAction(state, power, moves, flip, rand) {
  const mover = state.currentPlayer;
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    let value;
    if ((c.kind === "move" || c.kind === "charge") && c.move.causesWin) {
      value = MK_WIN_VALUE;
    } else if (c.kind === "reflip") {
      value = mkReflipValue(state, power, mover);
    } else if (c.kind === "revive") {
      value = mkReviveValue(state, power, flip, mover) + MK_EVAL_REVIVE_BIAS;
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

// room-engine.ts
var BOT_THINK_MS = 900;
var BOT_RESCUE_THINK_MS = 300;
var AUTO_SKIP_DELAY_MS = 500;
var AUTO_SKIP_WITH_RESCUE_MS = 4e3;
var OPENING_TIE_RESET_MS = 1600;
var FIRST_TURN_REVEAL_MS = 1400;
var EVENT_WINDOW = 16;
var CHAT_MAX = 40;
var CHAT_TEXT_MAX = 200;
var OPPONENT_AWAY_MS = 2e4;
var OPPONENT_LEFT_MS = 12e4;
var MK_CLASSES = ["archer", "mage", "warrior", "necromancer"];
function toWirePower(p) {
  return { ...p };
}
function fromWirePower(w) {
  return {
    ...w,
    // Docs persisted before the once-per-turn boolean (reflipUsedThisTurn)
    // became a counter read as undefined here — treat the old true as "one
    // re-flip already used" so a mid-deploy live room can't double-dip.
    reflipsUsedThisTurn: typeof w.reflipsUsedThisTurn === "number" ? w.reflipsUsedThisTurn : w.reflipUsedThisTurn ? 1 : 0,
    // Same live-room back-compat: docs persisted before reinforced Bulwark
    // existed have no bulwarkSaves — every live Bulwark in them is a plain
    // 1-block cast, which an empty map means exactly. (A doc persisted with
    // the retired safeTokens array just carries a harmless extra key.)
    bulwarkSaves: w.bulwarkSaves ?? {},
    // Docs persisted before the necromancer rework have neither corpse nor
    // thrall — no possession in flight, which the null pair means exactly.
    // (Their live necromancers ALSO lose the old Raise kit mid-game; the
    // deploy ships a rules change, not just a schema one, and the old
    // fields simply stop being read.)
    corpse: w.corpse ?? { p1: null, p2: null },
    thrall: w.thrall ?? { p1: null, p2: null }
  };
}
function sanitizeChat(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_TEXT_MAX);
}
function otherSeat(seat) {
  return seat === "p1" ? "p2" : "p1";
}
function raisableCorpse(doc, player) {
  const corpse = doc.mk?.corpse?.[player] ?? null;
  if (!corpse) return null;
  const body = doc.state.tokens.find((t) => t.id === corpse.tokenId);
  return body && body.position === -1 ? corpse : null;
}
function publicPower(doc) {
  if (!doc.mk) return null;
  const mover = doc.state.currentPlayer;
  const p = fromWirePower(doc.mk);
  return {
    classes: { ...doc.mk.classes },
    charges: { ...doc.mk.charges },
    pushTargets: doc.mk.classes[mover] === "archer" ? getPushTargets(doc.state, p, mover) : [],
    chargedShotTargets: doc.mk.classes[mover] === "archer" ? getChargedShotTargets(doc.state, p, mover) : [],
    ultimateReady: { ...doc.mk.ultimateReady },
    blinkStrikeTargets: doc.mk.classes[mover] === "mage" && doc.mk.ultimateReady[mover] ? getBlinkStrikeTargets(doc.state, p, mover) : [],
    warpathTargets: doc.mk.classes[mover] === "warrior" && doc.mk.ultimateReady[mover] ? getWarpathTargets(doc.state, p, mover) : [],
    bulwarkTargets: doc.mk.classes[mover] === "warrior" && doc.mk.charges[mover] >= 1 ? getBulwarkTargets(doc.state, p, mover) : [],
    // A Bulwark that blocked THIS flip was already consumed by
    // tickBulwarkForNewTurn, but it is still doing its job for the rest of
    // this turn (the served move list was computed with it up). Keep it in
    // the VISIBLE list until the turn resolves — CLEAR_SLOTS wipes
    // lastBulwarkBlock on the next commit, so the glow falls exactly when
    // the protection actually stops mattering. Without this union the glow
    // dropped at the block flip while captures stayed impossible all turn:
    // Kasen's 2026-07-19 "it wore off but it's still activating" report.
    bulwarkedTokenIds: [
      .../* @__PURE__ */ new Set([
        ...Object.keys(doc.mk.bulwarked).map(Number),
        ...doc.lastBulwarkBlock?.tokenIds ?? []
      ])
    ],
    bulwarkTurns: { ...doc.mk.bulwarked },
    bulwarkSavesLeft: { ...doc.mk.bulwarkSaves },
    shieldStreak: { ...doc.mk.shieldStreak },
    corpse: {
      // Broadcast only while raisable — the moment the victim re-enters
      // the marked token the decal (and the threat) vanish for both seats.
      p1: raisableCorpse(doc, "p1"),
      p2: raisableCorpse(doc, "p2")
    },
    thrall: { p1: doc.mk.thrall?.p1 ?? null, p2: doc.mk.thrall?.p2 ?? null },
    reviveSpawnTile: doc.mk.classes[mover] === "necromancer" ? getReviveSpawnTile(doc.state, p, mover) : null,
    corpseExplosionTargets: doc.mk.classes[mover] === "necromancer" ? getCorpseExplosionTargets(doc.state, p, mover) : [],
    exhumeTargets: doc.mk.classes[mover] === "necromancer" && doc.mk.ultimateReady[mover] ? getExhumeTargets(doc.state, p, mover) : [],
    reflipsUsedThisTurn: p.reflipsUsedThisTurn
  };
}
function pushEvent(doc, ev) {
  const seq = doc.seq + 1;
  const events = [...doc.events, { ...ev, seq }];
  return { ...doc, seq, events: events.slice(-EVENT_WINDOW) };
}
function classPickEventOf(doc) {
  return {
    kind: "classPick",
    classes: {
      p1: doc.classesPicked.p1 && doc.mk ? doc.mk.classes.p1 : null,
      p2: doc.classesPicked.p2 && doc.mk ? doc.mk.classes.p2 : null
    },
    ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu)
  };
}
function openingEventOf(doc, first) {
  const { p1, p2 } = doc.openingFlips;
  return {
    kind: "opening",
    flips: { ...doc.openingFlips },
    first,
    tie: first === null && p1 !== null && p2 !== null && p1 === p2
  };
}
function stateEventOf(doc) {
  return {
    kind: "state",
    state: doc.state,
    flip: doc.currentFlip,
    power: publicPower(doc) ?? void 0,
    lastMove: doc.lastMove,
    lastMovePlayer: doc.lastMovePlayer,
    lastPush: doc.lastPush,
    lastChargedShot: doc.lastChargedShot,
    lastBulwark: doc.lastBulwark,
    lastBulwarkBlock: doc.lastBulwarkBlock,
    lastChargeEvent: doc.lastChargeEvent,
    lastRainOfArrows: doc.lastRainOfArrows,
    lastUltimate: doc.lastUltimate,
    lastChargeSweep: doc.lastChargeSweep ?? null,
    lastReflip: doc.lastReflip ?? null,
    lastRevive: doc.lastRevive ?? null,
    lastThrallExpired: doc.lastThrallExpired ?? null,
    lastCorpseDenied: doc.lastCorpseDenied ?? null,
    lastCorpseExplosion: doc.lastCorpseExplosion ?? null,
    lastExhume: doc.lastExhume ?? null,
    wasSkipped: doc.wasSkipped,
    skippedPlayer: doc.skippedPlayer,
    skipReason: doc.skipReason
  };
}
function commitFrame(doc, now, ev) {
  return pushEvent({ ...doc, waitingSince: now, rescueAttempted: false }, ev);
}
function freshMatchFields(variant) {
  return {
    phase: variant === "masterKiller" ? "classPick" : "opening",
    openingFlips: { p1: null, p2: null },
    state: initialState(),
    currentFlip: null,
    turns: 0,
    captures: { p1: 0, p2: 0 },
    lastMove: null,
    lastMovePlayer: null,
    wasSkipped: false,
    skippedPlayer: null,
    skipReason: null,
    mk: variant === "masterKiller" ? toWirePower(initialPowerState()) : null,
    classesPicked: { p1: false, p2: false },
    currentPowerMoves: null,
    lastPush: null,
    lastChargedShot: null,
    lastChargeEvent: null,
    zeroFlipChargeBefore: null,
    lastRainOfArrows: null,
    lastUltimate: null,
    lastBulwark: null,
    lastBulwarkBlock: null,
    lastReflip: null,
    lastRevive: null,
    lastThrallExpired: null,
    lastCorpseDenied: null,
    lastCorpseExplosion: null,
    lastExhume: null,
    rescueAttempted: false
  };
}
function createRoomDoc(code, vsCpu, variant, p1Token, now, unlisted = false, difficulty = "standard") {
  const doc = {
    code,
    vsCpu,
    // Set only for CPU rooms — PvP docs stay byte-identical (no key at all).
    ...vsCpu ? { difficulty } : {},
    seats: { p1: p1Token, p2: vsCpu ? "BOT" : null },
    started: vsCpu,
    // cpu rooms are "full" with one human
    unlisted,
    version: 1,
    variant,
    waitingSince: now,
    seq: 0,
    events: [],
    seatLastSeen: { p1: now, p2: now },
    chat: [],
    ...freshMatchFields(variant)
  };
  if (!doc.started) return doc;
  return doc.phase === "classPick" ? pushEvent(doc, classPickEventOf(doc)) : pushEvent(doc, openingEventOf(doc, null));
}
function startRoom(doc, now) {
  const started = { ...doc, started: true, waitingSince: now };
  return started.phase === "classPick" ? pushEvent(started, classPickEventOf(started)) : pushEvent(started, openingEventOf(started, null));
}
function applyAction(doc, seat, action, now, rand = Math.random) {
  switch (action.op) {
    case "chat": {
      const text = sanitizeChat(action.text);
      if (!text) return { doc };
      const chat = [...doc.chat, { seat, text }].slice(-CHAT_MAX);
      return { doc: pushEvent({ ...doc, chat }, { kind: "chat" }) };
    }
    case "pickClass": {
      if (doc.phase !== "classPick" || !doc.mk) return { doc, error: "Not in class pick" };
      if (doc.classesPicked[seat]) return { doc, error: "Already picked" };
      let next = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, [seat]: action.class } },
        classesPicked: { ...doc.classesPicked, [seat]: true }
      };
      next = commitFrame(next, now, classPickEventOf(next));
      return { doc: maybeResolveClassPick(next, now) };
    }
    case "openingFlip": {
      if (doc.phase !== "opening") return { doc, error: "Not in the flip-off" };
      if (doc.openingFlips[seat] !== null) return { doc, error: "Already flipped" };
      let next = {
        ...doc,
        openingFlips: { ...doc.openingFlips, [seat]: flipCoins(rand) }
      };
      next = commitFrame(next, now, openingEventOf(next, null));
      return { doc: maybeResolveOpening(next, now) };
    }
    case "chooseMove": {
      if (doc.state.winner) return { doc, error: "Game is over" };
      if (doc.phase !== "play" || doc.state.currentPlayer !== seat) return { doc, error: "Not your turn" };
      if (doc.currentFlip === null) return { doc, error: "No flip yet" };
      if (doc.variant === "masterKiller") {
        if (!doc.mk || !doc.currentPowerMoves) return { doc, error: "No moves" };
        if (action.moveIndex < 0 || action.moveIndex >= doc.currentPowerMoves.length) {
          return { doc, error: "Invalid move index" };
        }
        return { doc: applyMkMove(doc, seat, doc.currentPowerMoves[action.moveIndex], now, rand) };
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (action.moveIndex < 0 || action.moveIndex >= moves.length) return { doc, error: "Invalid move index" };
      const move = moves[action.moveIndex];
      let next = {
        ...doc,
        state: applyMove(doc.state, move),
        currentFlip: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + move.captures.length },
        lastMove: move,
        lastMovePlayer: seat,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      next = commitFrame(next, now, stateEventOf(next));
      return { doc: next };
    }
    case "usePower": {
      const err = validateUsePower(doc, seat, action.action);
      if (err) return { doc, error: err };
      const a = action.action;
      if (a.kind === "reflip") return { doc: applyMkReflip(doc, seat, now, rand) };
      if (a.kind === "push") return { doc: applyMkSimple(doc, seat, "push", a.targetTokenId, now) };
      if (a.kind === "chargedShot") return { doc: applyMkSimple(doc, seat, "chargedShot", a.targetTokenId, now) };
      if (a.kind === "blinkStrike") return { doc: applyMkSimple(doc, seat, "blinkStrike", a.targetTokenId, now) };
      if (a.kind === "warpath") return { doc: applyMkSimple(doc, seat, "warpath", a.targetTokenId, now) };
      if (a.kind === "bulwark") return { doc: applyMkSimple(doc, seat, "bulwark", a.tokenId, now, a.reinforced === true) };
      if (a.kind === "revive") return { doc: applyMkRevive(doc, seat, now) };
      if (a.kind === "corpseExplosion") return { doc: applyMkCorpseExplosion(doc, seat, now) };
      if (a.kind === "exhume") return { doc: applyMkSimple(doc, seat, "exhume", a.targetTokenId, now) };
      const move = doc.currentPowerMoves[a.moveIndex];
      return { doc: applyMkCharge(doc, seat, move, now, rand) };
    }
    case "newMatch": {
      if (doc.state.winner === null) return { doc, error: "Current match hasn't ended" };
      let next = { ...doc, ...freshMatchFields(doc.variant), waitingSince: now, rescueAttempted: false };
      next = next.phase === "classPick" ? pushEvent(next, classPickEventOf(next)) : pushEvent(next, openingEventOf(next, null));
      return { doc: next };
    }
  }
}
function validateUsePower(doc, seat, a) {
  if (doc.variant !== "masterKiller" || !doc.mk) return "Not a Master Killer room";
  if (doc.state.winner !== null) return "Game is over";
  if (doc.phase !== "play" || doc.state.currentPlayer !== seat) return "Not your turn";
  const cls = doc.mk.classes[seat];
  const p = () => fromWirePower(doc.mk);
  switch (a.kind) {
    case "reflip":
      if (cls !== "mage") return "Only a Mage can Re-flip";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!canReflipAgain(p(), seat)) return "No re-flips left this turn";
      return null;
    case "push":
      if (cls !== "archer") return "Only an Archer can Push";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!getPushTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid push target";
      return null;
    case "chargedShot":
      if (cls !== "archer") return "Only an Archer can Charged Shot";
      if (doc.mk.charges[seat] !== CHARGE_CAP) return "Charged Shot needs a full charge bank";
      if (!getChargedShotTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Charged Shot target";
      return null;
    case "blinkStrike":
      if (cls !== "mage") return "Only a Mage can Blink Strike";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getBlinkStrikeTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Blink Strike target";
      return null;
    case "warpath":
      if (cls !== "warrior") return "Only a Warrior can Warpath";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getWarpathTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Warpath target";
      return null;
    case "bulwark":
      if (cls !== "warrior") return "Only a Warrior can Bulwark";
      if (a.reinforced === true) {
        if (doc.mk.charges[seat] !== CHARGE_CAP) return "Reinforced Bulwark needs a full charge bank";
      } else if (doc.mk.charges[seat] < 1) {
        return "No charge available";
      }
      if (!getBulwarkTargets(doc.state, p(), seat).includes(a.tokenId)) return "Invalid Bulwark target";
      return null;
    case "revive":
      if (cls !== "necromancer") return "Only a Necromancer can Revive";
      if (doc.currentFlip === null) return "No flip yet";
      if (getReviveSpawnTile(doc.state, p(), seat) === null) return "Revive not castable";
      return null;
    case "corpseExplosion":
      if (cls !== "necromancer") return "Only a Necromancer can detonate a corpse";
      if (getCorpseExplosionTargets(doc.state, p(), seat).length === 0)
        return "Corpse Explosion not castable";
      return null;
    case "exhume":
      if (cls !== "necromancer") return "Only a Necromancer can Exhume";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getExhumeTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Exhume target";
      return null;
    case "charge":
      if (cls !== "warrior") return "Only a Warrior can Charge";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!doc.currentPowerMoves || a.moveIndex < 0 || a.moveIndex >= doc.currentPowerMoves.length)
        return "Invalid move index";
      if (!doc.currentPowerMoves[a.moveIndex].chargeAvailable) return "Charge not available for that move";
      return null;
  }
}
var CLEAR_SLOTS = {
  lastMove: null,
  lastPush: null,
  lastChargedShot: null,
  lastBulwark: null,
  lastBulwarkBlock: null,
  lastChargeEvent: null,
  lastRainOfArrows: null,
  lastUltimate: null,
  lastChargeSweep: null,
  lastReflip: null,
  lastRevive: null,
  lastThrallExpired: null,
  lastCorpseDenied: null,
  lastCorpseExplosion: null,
  lastExhume: null,
  wasSkipped: false,
  skippedPlayer: null,
  skipReason: null
};
function applyMkMove(doc, seat, move, now, rand) {
  const chargesBefore = doc.mk.charges[seat];
  const foe = otherSeat(seat);
  const r = applyPowerMove(doc.state, fromWirePower(doc.mk), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  const caps = move.captures.length + move.bonusCaptures.length + rainHit;
  const foeCorpse = doc.mk.corpse?.[foe] ?? null;
  const corpseDenied = foeCorpse !== null && move.tokenId === foeCorpse.tokenId && move.from === -1;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + caps },
    lastMove: move,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastCorpseDenied: corpseDenied ? { tokenId: move.tokenId } : null,
    lastRainOfArrows: r.rainOfArrows
  };
  return commitFrame(next, now, stateEventOf(next));
}
function applyMkCharge(doc, seat, move, now, rand) {
  const chargesBefore = doc.mk.charges[seat];
  const r = applyCharge(doc.state, fromWirePower(doc.mk), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  const caps = move.captures.length + move.bonusCaptures.length + move.chargeSweepCaptures.length + rainHit;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + caps },
    lastMove: move,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastRainOfArrows: r.rainOfArrows,
    lastChargeSweep: { sweptTokenIds: move.chargeSweepCaptures }
  };
  return commitFrame(next, now, stateEventOf(next));
}
function applyMkSimple(doc, seat, kind, tokenId, now, reinforced = false) {
  const chargesBefore = doc.mk.charges[seat];
  const power = fromWirePower(doc.mk);
  let r;
  let slots = {};
  let capsGained = 0;
  switch (kind) {
    case "push":
      r = applyPush(doc.state, power, tokenId, seat);
      slots = { lastPush: { targetTokenId: tokenId } };
      break;
    case "chargedShot":
      r = applyChargedShot(doc.state, power, tokenId, seat);
      slots = { lastChargedShot: { targetTokenId: tokenId } };
      break;
    case "blinkStrike": {
      const rr = applyBlinkStrike(doc.state, power, tokenId, seat);
      r = rr;
      capsGained = 1 + rr.sweptTokenIds.length;
      slots = { lastUltimate: { kind: "blinkStrike", targetTokenId: tokenId, sweptTokenIds: rr.sweptTokenIds } };
      break;
    }
    case "warpath": {
      const rr = applyWarpath(doc.state, power, tokenId, seat);
      r = rr;
      capsGained = 1 + rr.sweptTokenIds.length;
      slots = { lastUltimate: { kind: "warpath", targetTokenId: tokenId, sweptTokenIds: rr.sweptTokenIds } };
      break;
    }
    case "bulwark":
      r = applyBulwark(doc.state, power, tokenId, seat, reinforced);
      slots = { lastBulwark: { tokenId, reinforced } };
      break;
    case "exhume": {
      const rr = applyExhume(doc.state, power, tokenId, seat);
      r = rr;
      slots = { lastExhume: { targetTokenId: tokenId, returnedTo: rr.returnedTo } };
      break;
    }
  }
  const delta = r.power.charges[seat] - chargesBefore;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    ...slots,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: capsGained ? { ...doc.captures, [seat]: doc.captures[seat] + capsGained } : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null
  };
  return commitFrame(next, now, stateEventOf(next));
}
function applyMkReflip(doc, seat, now, rand) {
  const chargesBefore = doc.mk.charges[seat];
  let power = applyReflip(fromWirePower(doc.mk), seat);
  const flip = flipCoins(rand);
  if (flip === 0) power = grantZeroFlipCharge(power, seat);
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  power = bulwarkResult.power;
  const delta = power.charges[seat] - chargesBefore;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(power),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastReflip: { player: seat },
    // A re-rolled zero still ends in the auto-skip path, which announces the
    // NET delta computed here — don't re-derive from zeroFlipChargeBefore.
    zeroFlipChargeBefore: null
  };
  return commitFrame(next, now, stateEventOf(next));
}
function applyMkRevive(doc, seat, now) {
  const chargesBefore = doc.mk.charges[seat];
  const flip = doc.currentFlip;
  const risen = applyRevive(doc.state, fromWirePower(doc.mk), seat);
  const currentPowerMoves = getLegalPowerMoves(risen.state, risen.power, flip);
  const bulwarkResult = tickBulwarkForReflip(risen.state, risen.power, flip);
  const power = bulwarkResult.power;
  const delta = power.charges[seat] - chargesBefore;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    state: risen.state,
    mk: toWirePower(power),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastRevive: { tokenId: risen.raisedTokenId, tile: risen.raisedTo },
    // A revive during a zero flip spends AFTER the flip commit banked the
    // grant's baseline: shift the baseline down by the same spend so the
    // auto-skip commit still announces exactly the grant (see the flip-zero
    // branch in tickOnce), not grant-minus-spend.
    zeroFlipChargeBefore: doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - REVIVE_COST : null
  };
  return commitFrame(next, now, stateEventOf(next));
}
function applyMkCorpseExplosion(doc, seat, now) {
  const chargesBefore = doc.mk.charges[seat];
  const r = applyCorpseExplosion(doc.state, fromWirePower(doc.mk), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastCorpseExplosion: { tile: r.tile, struckTokenIds: r.struckTokenIds, sentHomeIds: r.sentHomeIds }
  };
  return commitFrame(next, now, stateEventOf(next));
}
function maybeResolveClassPick(doc, now) {
  if (doc.phase !== "classPick" || !doc.mk) return doc;
  if (!doc.classesPicked.p1 || !doc.classesPicked.p2 && !doc.vsCpu) return doc;
  let next = { ...doc, phase: "opening" };
  return commitFrame(next, now, openingEventOf(next, null));
}
function maybeResolveOpening(doc, now) {
  if (doc.phase !== "opening") return doc;
  const { p1, p2 } = doc.openingFlips;
  if (p1 === null || p2 === null || p1 === p2) return doc;
  const first = p1 > p2 ? "p1" : "p2";
  let next = {
    ...doc,
    phase: "play",
    state: { ...doc.state, currentPlayer: first }
  };
  return commitFrame(next, now, openingEventOf(next, first));
}
function autoSkipDelay(doc) {
  const mover = doc.state.currentPlayer;
  const isBot = doc.vsCpu && mover === "p2";
  if (isBot) return AUTO_SKIP_DELAY_MS;
  if (doc.variant === "masterKiller" && doc.mk) {
    const p = fromWirePower(doc.mk);
    if (doc.mk.classes[mover] === "mage" && canReflipAgain(p, mover)) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    if (doc.mk.classes[mover] === "necromancer" && doc.currentFlip !== null && doc.currentFlip !== 0 && (getReviveSpawnTile(doc.state, p, mover) !== null || getCorpseExplosionTargets(doc.state, p, mover).length > 0)) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
  }
  return AUTO_SKIP_DELAY_MS;
}
function tickOnce(doc, now, rand) {
  if (!doc.started) return doc;
  const elapsed = now - doc.waitingSince;
  if (doc.phase === "classPick") {
    if (doc.vsCpu && !doc.classesPicked.p2 && doc.mk && elapsed >= BOT_THINK_MS) {
      const cls = MK_CLASSES[Math.floor(rand() * MK_CLASSES.length)];
      let next = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, p2: cls } },
        classesPicked: { ...doc.classesPicked, p2: true }
      };
      next = commitFrame(next, now, classPickEventOf(next));
      return maybeResolveClassPick(next, now);
    }
    return maybeResolveClassPick(doc, now);
  }
  if (doc.phase === "opening") {
    const { p1, p2 } = doc.openingFlips;
    if (doc.vsCpu && p2 === null && elapsed >= BOT_THINK_MS) {
      let next = { ...doc, openingFlips: { ...doc.openingFlips, p2: flipCoins(rand) } };
      next = commitFrame(next, now, openingEventOf(next, null));
      return maybeResolveOpening(next, now);
    }
    if (p1 !== null && p2 !== null && p1 === p2 && elapsed >= OPENING_TIE_RESET_MS) {
      let next = { ...doc, openingFlips: { p1: null, p2: null } };
      return commitFrame(next, now, openingEventOf(next, null));
    }
    return maybeResolveOpening(doc, now);
  }
  if (doc.state.winner) return doc;
  if (doc.currentFlip === null) {
    const delay = doc.turns === 0 ? FIRST_TURN_REVEAL_MS : 0;
    if (elapsed < delay) return doc;
    return commitTurnFlip(doc, now, rand);
  }
  const flip = doc.currentFlip;
  const moves = doc.variant === "masterKiller" ? doc.currentPowerMoves ?? [] : getLegalMoves(doc.state, flip);
  const isBotTurn = doc.vsCpu && doc.state.currentPlayer === "p2";
  if (isBotTurn && doc.variant === "masterKiller" && doc.mk && moves.length === 0 && !doc.rescueAttempted && elapsed >= BOT_RESCUE_THINK_MS) {
    const power = fromWirePower(doc.mk);
    const action = pickBotPowerAction(
      doc.state,
      power,
      doc.currentPowerMoves ?? [],
      flip,
      rand,
      doc.difficulty ?? "standard"
    );
    if (action) return applyBotAction(doc, "p2", action, now, rand);
    doc = { ...doc, rescueAttempted: true };
  }
  if (moves.length === 0 && elapsed >= autoSkipDelay(doc)) {
    const skipped = doc.state.currentPlayer;
    const skipReason = doc.currentFlip === 0 ? "flip-zero" : "no-legal-move";
    let lastChargeEvent = null;
    if (skipReason === "flip-zero" && doc.mk && doc.zeroFlipChargeBefore !== null) {
      const delta = doc.mk.charges[skipped] - doc.zeroFlipChargeBefore;
      lastChargeEvent = delta !== 0 ? { player: skipped, delta } : null;
    }
    const mk = doc.mk ? toWirePower(breakShieldStreak(fromWirePower(doc.mk), skipped)) : doc.mk;
    let next = {
      ...doc,
      ...CLEAR_SLOTS,
      state: applyNoMove(doc.state),
      mk,
      currentFlip: null,
      currentPowerMoves: null,
      wasSkipped: true,
      skippedPlayer: skipped,
      skipReason,
      lastChargeEvent,
      lastMovePlayer: doc.lastMovePlayer,
      zeroFlipChargeBefore: null
    };
    return commitFrame(next, now, stateEventOf(next));
  }
  if (isBotTurn && moves.length > 0 && elapsed >= BOT_THINK_MS) {
    if (doc.variant === "masterKiller" && doc.mk) {
      const power = fromWirePower(doc.mk);
      const action = pickBotPowerAction(
        doc.state,
        power,
        doc.currentPowerMoves ?? [],
        flip,
        rand,
        doc.difficulty ?? "standard"
      );
      if (action) return applyBotAction(doc, "p2", action, now, rand);
      return doc;
    }
    const botMoves = getLegalMoves(doc.state, flip);
    if (botMoves.length === 0) return doc;
    const idx = pickBotMove(doc.state, botMoves, rand, doc.difficulty ?? "standard");
    const move = botMoves[idx];
    let next = {
      ...doc,
      state: applyMove(doc.state, move),
      currentFlip: null,
      captures: { ...doc.captures, p2: doc.captures.p2 + move.captures.length },
      lastMove: move,
      lastMovePlayer: "p2",
      wasSkipped: false,
      skippedPlayer: null,
      skipReason: null
    };
    return commitFrame(next, now, stateEventOf(next));
  }
  return doc;
}
function applyBotAction(doc, seat, action, now, rand) {
  switch (action.kind) {
    case "move":
      return applyMkMove(doc, seat, action.move, now, rand);
    case "charge":
      return applyMkCharge(doc, seat, action.move, now, rand);
    case "push":
      return applyMkSimple(doc, seat, "push", action.targetTokenId, now);
    case "chargedShot":
      return applyMkSimple(doc, seat, "chargedShot", action.targetTokenId, now);
    case "reflip":
      return applyMkReflip(doc, seat, now, rand);
    case "blinkStrike":
      return applyMkSimple(doc, seat, "blinkStrike", action.targetTokenId, now);
    case "warpath":
      return applyMkSimple(doc, seat, "warpath", action.targetTokenId, now);
    case "bulwark":
      return applyMkSimple(doc, seat, "bulwark", action.tokenId, now, action.reinforced ?? false);
    case "revive":
      return applyMkRevive(doc, seat, now);
    case "corpseExplosion":
      return applyMkCorpseExplosion(doc, seat, now);
    case "exhume":
      return applyMkSimple(doc, seat, "exhume", action.targetTokenId, now);
  }
}
function commitTurnFlip(doc, now, rand) {
  const flip = flipCoins(rand);
  let mk = doc.mk;
  let state = doc.state;
  let currentPowerMoves = null;
  let zeroFlipChargeBefore = null;
  let lastBulwarkBlock = null;
  let lastThrallExpired = null;
  if (doc.variant === "masterKiller" && mk) {
    let power = fromWirePower(mk);
    if (flip === 0) {
      zeroFlipChargeBefore = power.charges[state.currentPlayer];
      power = grantZeroFlipCharge(power, state.currentPlayer);
    }
    const thrallResult = tickThrallForNewTurn(state, power);
    state = thrallResult.state;
    power = thrallResult.power;
    if (thrallResult.expiredTokenId !== null) lastThrallExpired = { tokenId: thrallResult.expiredTokenId };
    currentPowerMoves = getLegalPowerMoves(state, power, flip);
    const bulwarkResult = tickBulwarkForNewTurn(state, power, flip);
    power = bulwarkResult.power;
    if (bulwarkResult.blockedIds.length > 0) lastBulwarkBlock = { tokenIds: bulwarkResult.blockedIds };
    mk = toWirePower(power);
  }
  let next = {
    ...doc,
    ...CLEAR_SLOTS,
    state,
    currentFlip: flip,
    mk,
    currentPowerMoves,
    turns: doc.turns + 1,
    lastBulwarkBlock,
    lastThrallExpired,
    zeroFlipChargeBefore
  };
  return commitFrame(next, now, stateEventOf(next));
}
function tick(doc, now, rand = Math.random) {
  for (let i = 0; i < 12; i++) {
    const next = tickOnce(doc, now, rand);
    if (next === doc) return doc;
    doc = next;
  }
  return doc;
}
function viewFor(doc, seat, since, now) {
  const oldest = doc.events.length > 0 ? doc.events[0].seq : doc.seq + 1;
  const resync = since < oldest - 1;
  const yourTurn = doc.phase === "play" && doc.state.winner === null && doc.state.currentPlayer === seat;
  const legalMoves = doc.variant === "classic" && doc.currentFlip !== null && yourTurn ? getLegalMoves(doc.state, doc.currentFlip) : null;
  const powerMoves = doc.variant === "masterKiller" && yourTurn ? doc.currentPowerMoves : null;
  const opp = otherSeat(seat);
  const oppSeen = doc.seatLastSeen[opp];
  const oppIsBot = doc.vsCpu && opp === "p2";
  return {
    latestSeq: doc.seq,
    resync,
    events: resync ? [] : doc.events.filter((e) => e.seq > since),
    started: doc.started,
    phase: doc.phase,
    vsCpu: doc.vsCpu,
    difficulty: doc.vsCpu ? doc.difficulty ?? "standard" : null,
    variant: doc.variant,
    state: doc.state,
    flip: doc.currentFlip,
    openingFlips: { ...doc.openingFlips },
    classPick: doc.variant === "masterKiller" && doc.mk ? {
      classes: {
        p1: doc.classesPicked.p1 ? doc.mk.classes.p1 : null,
        p2: doc.classesPicked.p2 ? doc.mk.classes.p2 : null
      },
      ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu)
    } : null,
    power: publicPower(doc),
    yourTurn,
    legalMoves,
    powerMoves,
    gameOver: doc.state.winner ? { winner: doc.state.winner, stats: { turns: doc.turns, captures: { ...doc.captures } } } : null,
    opponentAway: !oppIsBot && doc.started && now - oppSeen > OPPONENT_AWAY_MS,
    opponentLeft: !oppIsBot && doc.started && now - oppSeen > OPPONENT_LEFT_MS,
    chat: doc.chat
  };
}

// api/room.ts
var config = { maxDuration: 60 };
var ROOM_TTL_S = 4 * 60 * 60;
var LONG_POLL_CAP_MS = 2e4;
var LONG_POLL_STEP_MS = 500;
var LASTSEEN_WRITE_THROTTLE_MS = 5e3;
var REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;
var redis = null;
function getRedis() {
  if (!redis) redis = new Redis(REDIS_URL);
  return redis;
}
var roomKey = (code) => `room:${code}`;
var OPEN_ROOMS_KEY = "rooms:open";
var LOBBY_HOST_FRESH_MS = 45e3;
var CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local doc = cjson.decode(cur)
if tostring(doc.version) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;
async function loadDoc(code) {
  const raw = await getRedis().get(roomKey(code));
  return raw ? JSON.parse(raw) : null;
}
async function casStore(prevVersion, next) {
  next.version = prevVersion + 1;
  const ok = await getRedis().eval(
    CAS_LUA,
    1,
    roomKey(next.code),
    String(prevVersion),
    JSON.stringify(next),
    String(ROOM_TTL_S)
  );
  return ok === 1;
}
async function withDoc(code, step) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc2 = await loadDoc(code);
    if (!doc2) return null;
    const r = step(doc2);
    if (r.doc === doc2) return r;
    if (await casStore(doc2.version, r.doc)) return r;
  }
  const doc = await loadDoc(code);
  return doc ? { doc, error: "Busy \u2014 try again" } : null;
}
var json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}
function touchSeat(doc, seat, now) {
  if (now - doc.seatLastSeen[seat] < LASTSEEN_WRITE_THROTTLE_MS) return doc;
  return { ...doc, seatLastSeen: { ...doc.seatLastSeen, [seat]: now } };
}
async function handleJoin(msg) {
  const now = Date.now();
  if (msg.mode === "join") {
    const code = (msg.room ?? "").trim().toUpperCase();
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await loadDoc(code);
      if (!doc) return json({ error: `Room ${code || "?"} not found` }, 404);
      if (doc.seats.p2 !== null) return json({ error: `Room ${code} is already full` }, 409);
      const token2 = randomUUID();
      let next = startRoom({ ...doc, seats: { ...doc.seats, p2: token2 } }, now);
      next = tick(next, now);
      if (await casStore(doc.version, next)) {
        await getRedis().srem(OPEN_ROOMS_KEY, code);
        const body = {
          player: "p2",
          room: code,
          vsCpu: next.vsCpu,
          variant: next.variant,
          seatToken: token2,
          view: viewFor(next, "p2", 0, now)
        };
        return json(body);
      }
    }
    return json({ error: `Room ${code} is already full` }, 409);
  }
  const vsCpu = msg.mode === "cpu";
  const variant = msg.variant === "masterKiller" ? "masterKiller" : "classic";
  const token = randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = newRoomCode();
    let doc = createRoomDoc(code, vsCpu, variant, token, now, msg.unlisted === true, normalizeDifficulty(msg.difficulty));
    doc = tick(doc, now);
    const ok = await getRedis().set(roomKey(code), JSON.stringify(doc), "EX", ROOM_TTL_S, "NX");
    if (ok === "OK") {
      if (!vsCpu && !doc.unlisted) await getRedis().sadd(OPEN_ROOMS_KEY, code);
      const body = {
        player: "p1",
        room: code,
        vsCpu,
        variant,
        seatToken: token,
        view: viewFor(doc, "p1", 0, now)
      };
      return json(body);
    }
  }
  return json({ error: "Could not allocate a room code" }, 500);
}
async function POST(request) {
  if (!REDIS_URL) return json({ error: "Server missing REDIS_URL" }, 500);
  let msg;
  try {
    msg = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  try {
    if (msg.op === "join") return await handleJoin(msg);
    if (msg.op === "listRooms") {
      const now2 = Date.now();
      const codes = await getRedis().smembers(OPEN_ROOMS_KEY);
      const rooms = [];
      const stale = [];
      if (codes.length > 0) {
        const raws = await getRedis().mget(codes.map(roomKey));
        codes.forEach((code, i) => {
          const raw = raws[i];
          if (!raw) return void stale.push(code);
          const doc = JSON.parse(raw);
          const hostFresh = now2 - doc.seatLastSeen.p1 < LOBBY_HOST_FRESH_MS;
          if (doc.started || doc.seats.p2 !== null || doc.unlisted || !hostFresh) {
            return void stale.push(code);
          }
          rooms.push({
            code,
            variant: doc.variant,
            ageSeconds: Math.max(0, Math.round((now2 - doc.waitingSince) / 1e3))
          });
        });
        if (stale.length > 0) await getRedis().srem(OPEN_ROOMS_KEY, ...stale);
      }
      rooms.sort((a, b) => a.ageSeconds - b.ageSeconds);
      return json({ rooms: rooms.slice(0, 20) });
    }
    const { room, seat, seatToken } = msg;
    if (!room || !seat || !seatToken) return json({ error: "Missing room/seat/seatToken" }, 400);
    const probe = await loadDoc(room);
    if (!probe) return json({ error: "Room not found" }, 404);
    if (probe.seats[seat] !== seatToken) return json({ error: "Bad seat token" }, 403);
    if (msg.op === "poll") {
      const since = msg.since ?? 0;
      const deadline = Date.now() + (msg.wait === false ? 0 : LONG_POLL_CAP_MS);
      for (; ; ) {
        const now2 = Date.now();
        const r2 = await withDoc(room, (doc) => ({ doc: tick(touchSeat(doc, seat, now2), now2) }));
        if (!r2) return json({ error: "Room not found" }, 404);
        if (r2.doc.seq > since || now2 >= deadline) {
          const view2 = { ...viewFor(r2.doc, seat, since, now2), error: r2.error };
          return json(view2);
        }
        await new Promise((res) => setTimeout(res, LONG_POLL_STEP_MS));
      }
    }
    const now = Date.now();
    const action = msg;
    const r = await withDoc(room, (doc) => {
      const pre = tick(touchSeat(doc, seat, now), now);
      const stepped = applyAction(pre, seat, action, now);
      return { doc: tick(stepped.doc, now), error: stepped.error };
    });
    if (!r) return json({ error: "Room not found" }, 404);
    const actionSince = typeof msg.since === "number" ? msg.since : r.doc.seq;
    const view = { ...viewFor(r.doc, seat, actionSince, now), error: r.error };
    return json(view);
  } catch (err) {
    console.error("room handler error", err);
    return json({ error: "Server error" }, 500);
  }
}
function GET() {
  return new Response("Regatta room API \u2014 POST RoomRequest JSON here.", {
    status: 200,
    headers: { "Cache-Control": "no-store" }
  });
}
export {
  GET,
  POST,
  config
};
