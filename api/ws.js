// api/ws.ts
import { experimental_upgradeWebSocket } from "@vercel/functions";
import Redis from "ioredis";
import { randomBytes, randomUUID } from "crypto";

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

// bot.ts
function pickBotMove(state, moves, rand = Math.random) {
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

// master-killer.ts
function otherPlayerId(p) {
  return p === "p1" ? "p2" : "p1";
}
var CHARGE_CAP = 2;
var PUSH_DISTANCE = 1;
var CHARGE_SWEEP_CAP = 1;
var WARD_SCOPE = "most-advanced";
var PUSH_WARD_COST = 1;
var PUSH_WARD_DISTANCE = 3;
var ULTIMATE_STREAK = 3;
function initialPowerState() {
  return {
    classes: { p1: "archer", p2: "archer" },
    // placeholder until picked
    charges: { p1: 0, p2: 0 },
    safeTokens: /* @__PURE__ */ new Set(),
    reflipUsedThisTurn: false,
    shieldStreak: { p1: 0, p2: 0 },
    ultimateReady: { p1: false, p2: false }
  };
}
function resetTurnFlags(power) {
  return { ...power, reflipUsedThisTurn: false };
}
function isMostAdvanced(state, token) {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  const mine = state.tokens.filter(
    (t) => t.owner === token.owner && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER
  );
  if (mine.length === 0) return false;
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best;
}
function findMostAdvancedToken(state, mover) {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => t.position > best.position ? t : best);
}
function findLeastAdvancedToken(state, mover) {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => t.position < best.position ? t : best);
}
function isWarded(state, power, token) {
  if (power.classes[token.owner] !== "mage") return false;
  if (power.charges[token.owner] < CHARGE_CAP) return false;
  if (WARD_SCOPE === "most-advanced") return isMostAdvanced(state, token);
  return true;
}
function onShieldTile(token) {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  return BOARD_LAYOUT[token.position].type === "shield";
}
function hasTransientSafety(power, token) {
  return power.safeTokens.has(token.id);
}
function isProtected(state, power, token) {
  return onShieldTile(token) || hasTransientSafety(power, token) || isWarded(state, power, token);
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
function getLegalPowerMoves(state, power, flip) {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];
  const player = state.currentPlayer;
  const cls = power.classes[player];
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
    const self = occupants.find((t) => t.owner === player);
    const enemy = occupants.find((t) => t.owner !== player);
    if (self) continue;
    let captures = [];
    let breaksWard = false;
    if (enemy) {
      if (onShieldTile(enemy) || hasTransientSafety(power, enemy)) continue;
      if (isWarded(state, power, enemy)) {
        if (cls !== "warrior") continue;
        breaksWard = true;
        captures = [enemy.id];
      } else {
        captures = [enemy.id];
      }
    }
    const bonusCaptures = [];
    if (cls === "archer" && BOARD_LAYOUT[to + 1].isContested) {
      const sniped = state.tokens.find(
        (t) => t.position === to + 1 && t.owner !== player && t.id !== enemy?.id
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
        if (occ.some((t) => t.owner === player)) {
          laneClear = false;
          break;
        }
        const foe = occ.find((t) => t.owner !== player);
        if (foe && chargeSweepCaptures.length < CHARGE_SWEEP_CAP && !onShieldTile(foe) && !hasTransientSafety(power, foe)) {
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
  return state.tokens.filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => BOARD_LAYOUT[t.position].isContested).filter((t) => !hasTransientSafety(power, t)).map((t) => t.id);
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
function resolveTurn(state, power, mover, tokenId, to, allCaptures, landsOnShield, causesWin, grantsSafety, rand = Math.random) {
  const streakResult = resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand);
  power = streakResult.power;
  const rainOfArrows = streakResult.rainOfArrows;
  const finalCaptures = rainOfArrows?.targetTokenId != null ? [...allCaptures, rainOfArrows.targetTokenId] : allCaptures;
  const tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (finalCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });
  let safeTokens = power.safeTokens;
  if (safeTokens.has(tokenId) || finalCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(tokenId);
    for (const id of finalCaptures) safeTokens.delete(id);
  }
  if (grantsSafety) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(tokenId);
  }
  let nextPower = { ...power, safeTokens };
  if (finalCaptures.length > 0 || landsOnShield) {
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
    move.breaksWard,
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
    move.breaksWard,
    rand
  );
}
function getPushTargets(state, power, mover) {
  const foe = otherPlayerId(mover);
  return state.tokens.filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER).filter((t) => BOARD_LAYOUT[t.position].isContested).filter((t) => !onShieldTile(t) && !hasTransientSafety(power, t)).filter((t) => !isWarded(state, power, t) || power.charges[mover] >= PUSH_WARD_COST).map((t) => t.id);
}
function applyPush(state, power, targetTokenId, mover) {
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const cost = pushCost(state, power, target);
  const rawTo = target.position - pushDistance(state, power, target);
  const contestedLanding = rawTo >= 0 && rawTo < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[rawTo].isContested;
  const collides = state.tokens.some(
    (t) => t.id !== targetTokenId && t.position === rawTo && (t.owner === target.owner || contestedLanding)
  );
  const landing = collides || rawTo < 0 ? -1 : rawTo;
  const sendsHome = landing === -1;
  const tokens = state.tokens.map((t) => t.id === targetTokenId ? { ...t, position: landing } : t);
  let safeTokens = power.safeTokens;
  if (safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(targetTokenId);
  }
  let spentPower = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - cost },
    safeTokens
  };
  if (sendsHome) spentPower = addCharge(spentPower, mover);
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
    reflipUsedThisTurn: true
  };
}
function getBlinkStrikeTargets(state, power, mover) {
  if (!findMostAdvancedToken(state, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}
function getWarpathTargets(state, power, mover) {
  if (!findLeastAdvancedToken(state, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}
function applyBlinkStrike(state, power, targetTokenId, mover) {
  const mine = findMostAdvancedToken(state, mover);
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    safeTokens.delete(targetTokenId);
  }
  let nextPower = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false }
  };
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
  const mine = findLeastAdvancedToken(state, mover);
  const target = state.tokens.find((t) => t.id === targetTokenId);
  const from = mine.position;
  const to = target.position;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const sweepCaptures = [];
  let brokeWard = isWarded(state, power, target);
  for (let i = lo + 1; i < hi; i++) {
    if (!BOARD_LAYOUT[i].isContested) continue;
    const foe = state.tokens.find(
      (t) => t.position === i && t.owner !== mover && t.id !== mine.id && t.id !== targetTokenId
    );
    if (foe && !hasTransientSafety(power, foe)) {
      sweepCaptures.push(foe.id);
      if (isWarded(state, power, foe)) brokeWard = true;
    }
  }
  const allCaptures = [targetTokenId, ...sweepCaptures];
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });
  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || allCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    for (const id of allCaptures) safeTokens.delete(id);
  }
  if (brokeWard) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(mine.id);
  }
  let nextPower = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false }
  };
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

// master-killer-bot.ts
function scoreMove(state, m, extraCaptures, rand) {
  let score = 0;
  const allCaptures = [...m.captures, ...m.bonusCaptures, ...extraCaptures];
  if (m.causesWin) score += 1e3;
  if (allCaptures.length > 0) {
    const victimProgress = Math.max(
      ...allCaptures.map((id) => state.tokens.find((t) => t.id === id)?.position ?? 0)
    );
    score += 400 + victimProgress * 10 + (allCaptures.length - 1) * 150;
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
  return score;
}
function scorePush(state, power, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  const warded = isWarded(state, power, target);
  const rawTo = target.position - (warded ? PUSH_WARD_DISTANCE : PUSH_DISTANCE);
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo
  );
  const sendsHome = collides || rawTo < 0;
  let score = (sendsHome ? 350 : 180) + target.position * 8;
  if (warded) score += sendsHome ? 250 : 60;
  score += rand() * 20;
  return score;
}
function scoreUltimateStrike(state, targetId, rand) {
  const target = state.tokens.find((t) => t.id === targetId);
  let score = 500 + target.position * 10;
  score += rand() * 20;
  return score;
}
function scoreReflip(currentMoveCount, flip, rand) {
  if (flip === 0 || currentMoveCount === 0) return 500 + rand() * 20;
  return -1;
}
function pickBotPowerAction(state, power, moves, flip, rand = Math.random) {
  const mover = state.currentPlayer;
  const cls = power.classes[mover];
  const charges = power.charges[mover];
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = scoreMove(state, m, [], rand);
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
  if (cls === "mage" && charges >= 1 && !power.reflipUsedThisTurn) {
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
  return best;
}

// api/ws.ts
var config = { maxDuration: 300 };
var ROOM_TTL_S = 4 * 60 * 60;
var AUTO_SKIP_DELAY_MS = 500;
var BOT_THINK_MS = 900;
var BOT_RESCUE_THINK_MS = 300;
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var MK_CLASSES = ["archer", "mage", "warrior"];
var REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;
function toWirePower(p) {
  return { ...p, safeTokens: [...p.safeTokens] };
}
function fromWirePower(w) {
  return { ...w, safeTokens: new Set(w.safeTokens) };
}
var roomKey = (code) => `room:${code}`;
var roomChannel = (code) => `room:${code}:ch`;
var CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cjson.decode(cur).version ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;
function freshMatchFields(variant) {
  const state = initialState();
  return {
    phase: variant === "masterKiller" ? "classPick" : "opening",
    openingFlips: { p1: null, p2: null },
    state,
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
    lastChargeEvent: null,
    zeroFlipChargeBefore: null,
    lastRainOfArrows: null,
    lastUltimate: null
  };
}
function GET(request) {
  if (!REDIS_URL) {
    return new Response("Realtime backend not configured (missing REDIS_URL)", {
      status: 500
    });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Regatta referee \u2014 connect via WebSocket", {
      status: 426,
      headers: { Upgrade: "websocket" }
    });
  }
  return experimental_upgradeWebSocket(async (ws) => {
    const redis = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    let mySeat = null;
    let myRoom = null;
    let lastAnnouncedWinner = null;
    let prevPhase = null;
    let pendingTimer = null;
    const send = (msg) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
      }
    };
    const loadDoc = async (code) => {
      const raw = await redis.get(roomKey(code));
      return raw ? JSON.parse(raw) : null;
    };
    const commit = async (next) => {
      const prevVersion = next.version;
      next.version = prevVersion + 1;
      const ok = await redis.eval(
        CAS_LUA,
        1,
        roomKey(next.code),
        String(prevVersion),
        JSON.stringify(next),
        String(ROOM_TTL_S)
      );
      if (ok === 1) {
        await redis.publish(roomChannel(next.code), JSON.stringify(next));
        return true;
      }
      return false;
    };
    const scheduleVersioned = (doc, ms, fn) => {
      const versionAtSchedule = doc.version;
      setTimeout(async () => {
        try {
          const cur = await loadDoc(doc.code);
          if (cur && cur.version === versionAtSchedule) await fn(cur);
        } catch (err) {
          console.error("scheduled action failed", err);
        }
      }, ms);
    };
    const sendStateView = (doc) => {
      if (!mySeat || !doc.started) return;
      if (doc.phase === "classPick" && doc.mk) {
        prevPhase = "classPick";
        send({
          type: "classPick",
          classes: {
            p1: doc.classesPicked.p1 ? doc.mk.classes.p1 : null,
            p2: doc.classesPicked.p2 ? doc.mk.classes.p2 : null
          },
          ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu)
        });
        return;
      }
      if (doc.phase === "opening") {
        prevPhase = "opening";
        const { p1, p2 } = doc.openingFlips;
        send({
          type: "opening",
          flips: { ...doc.openingFlips },
          first: null,
          tie: p1 !== null && p2 !== null && p1 === p2
        });
        return;
      }
      if (prevPhase === "opening" || prevPhase === "classPick") {
        prevPhase = "play";
        send({
          type: "opening",
          flips: { ...doc.openingFlips },
          first: doc.state.currentPlayer,
          tie: false
        });
      }
      if (doc.state.winner === null) lastAnnouncedWinner = null;
      const legalMoves = doc.variant === "classic" && doc.currentFlip !== null && doc.state.currentPlayer === mySeat ? getLegalMoves(doc.state, doc.currentFlip) : null;
      const powerMoves = doc.variant === "masterKiller" && doc.state.currentPlayer === mySeat ? doc.currentPowerMoves : null;
      const power = doc.mk ? {
        classes: { ...doc.mk.classes },
        charges: { ...doc.mk.charges },
        safeTokens: [...doc.mk.safeTokens],
        pushTargets: doc.mk.classes[doc.state.currentPlayer] === "archer" ? getPushTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer) : [],
        ultimateReady: { ...doc.mk.ultimateReady },
        blinkStrikeTargets: doc.mk.classes[doc.state.currentPlayer] === "mage" && doc.mk.ultimateReady[doc.state.currentPlayer] ? getBlinkStrikeTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer) : [],
        warpathTargets: doc.mk.classes[doc.state.currentPlayer] === "warrior" && doc.mk.ultimateReady[doc.state.currentPlayer] ? getWarpathTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer) : []
      } : void 0;
      send({
        type: "state",
        state: doc.state,
        flip: doc.currentFlip,
        legalMoves,
        powerMoves,
        power,
        lastMove: doc.lastMove,
        lastMovePlayer: doc.lastMovePlayer,
        lastPush: doc.lastPush,
        lastChargeEvent: doc.lastChargeEvent,
        lastRainOfArrows: doc.lastRainOfArrows,
        lastUltimate: doc.lastUltimate,
        wasSkipped: doc.wasSkipped,
        skippedPlayer: doc.skippedPlayer,
        skipReason: doc.skipReason
      });
      if (doc.state.winner && lastAnnouncedWinner !== doc.state.winner) {
        lastAnnouncedWinner = doc.state.winner;
        send({
          type: "gameOver",
          winner: doc.state.winner,
          stats: { turns: doc.turns, captures: { ...doc.captures } }
        });
      }
    };
    const iDrive = (doc) => {
      if (!mySeat) return false;
      const turnOwner = doc.state.currentPlayer;
      if (doc.vsCpu) return mySeat === "p1";
      return turnOwner === mySeat;
    };
    const maybeDriveClassPick = async (doc) => {
      if (!mySeat || !doc.started || doc.phase !== "classPick" || !doc.mk) return;
      if (doc.vsCpu && !doc.classesPicked.p2 && mySeat === "p1") {
        scheduleVersioned(doc, BOT_THINK_MS, async (cur) => {
          if (cur.phase !== "classPick" || cur.classesPicked.p2 || !cur.mk) return;
          const cls = MK_CLASSES[Math.floor(Math.random() * MK_CLASSES.length)];
          await commit({
            ...cur,
            mk: { ...cur.mk, classes: { ...cur.mk.classes, p2: cls } },
            classesPicked: { ...cur.classesPicked, p2: true }
          });
        });
      }
      if (!doc.classesPicked.p1 || !doc.classesPicked.p2 && !doc.vsCpu) return;
      console.log(`[${doc.code}] classes: p1=${doc.mk.classes.p1} p2=${doc.mk.classes.p2}`);
      const next = { ...doc, phase: "opening" };
      if (await commit(next)) await maybeDriveOpening(next);
      else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDriveClassPick(reloaded);
      }
    };
    const maybeDriveOpening = async (doc) => {
      if (!mySeat || !doc.started || doc.phase !== "opening") return;
      const { p1, p2 } = doc.openingFlips;
      if (doc.vsCpu && p2 === null && mySeat === "p1") {
        scheduleVersioned(doc, BOT_THINK_MS, async (cur) => {
          if (cur.phase !== "opening" || cur.openingFlips.p2 !== null) return;
          await commit({
            ...cur,
            openingFlips: { ...cur.openingFlips, p2: flipCoins() }
          });
        });
      }
      if (p1 === null || p2 === null) return;
      if (p1 === p2) {
        scheduleVersioned(doc, 1600, async (cur) => {
          if (cur.phase !== "opening") return;
          await commit({ ...cur, openingFlips: { p1: null, p2: null } });
        });
        return;
      }
      const first = p1 > p2 ? "p1" : "p2";
      console.log(`[${doc.code}] opening: p1=${p1} p2=${p2} \u2014 ${first} first`);
      const next = {
        ...doc,
        phase: "play",
        state: { ...doc.state, currentPlayer: first }
      };
      if (await commit(next)) await maybeDrive(next);
    };
    const maybeDrive = async (doc) => {
      if (!doc.started || doc.phase !== "play" || doc.state.winner || !iDrive(doc)) return;
      if (doc.currentFlip === null) {
        const commitTurnFlip = async (cur) => {
          const flip = flipCoins();
          let mk = cur.mk;
          let currentPowerMoves = null;
          let zeroFlipChargeBefore = null;
          if (cur.variant === "masterKiller" && mk) {
            let power = fromWirePower(mk);
            if (flip === 0) {
              zeroFlipChargeBefore = power.charges[cur.state.currentPlayer];
              power = grantZeroFlipCharge(power, cur.state.currentPlayer);
            }
            mk = toWirePower(power);
            currentPowerMoves = getLegalPowerMoves(cur.state, power, flip);
          }
          const next = {
            ...cur,
            currentFlip: flip,
            mk,
            currentPowerMoves,
            turns: cur.turns + 1,
            // A fresh flip consumes the previous announcement.
            lastMove: null,
            lastMovePlayer: null,
            lastPush: null,
            lastChargeEvent: null,
            lastRainOfArrows: null,
            lastUltimate: null,
            wasSkipped: false,
            skippedPlayer: null,
            skipReason: null,
            zeroFlipChargeBefore
          };
          if (await commit(next)) await maybeDrive(next);
          else {
            const reloaded = await loadDoc(cur.code);
            if (reloaded) await maybeDrive(reloaded);
          }
        };
        if (doc.turns === 0) {
          scheduleVersioned(doc, 1400, async (cur) => {
            if (cur.phase === "play" && cur.currentFlip === null) {
              await commitTurnFlip(cur);
            }
          });
        } else {
          await commitTurnFlip(doc);
        }
        return;
      }
      const moves = doc.variant === "masterKiller" ? doc.currentPowerMoves ?? [] : getLegalMoves(doc.state, doc.currentFlip);
      const isBotTurn = doc.vsCpu && doc.state.currentPlayer === "p2";
      if (isBotTurn && doc.variant === "masterKiller" && moves.length === 0) {
        const versionAtSchedule = doc.version;
        scheduleVersioned(doc, BOT_RESCUE_THINK_MS, async (cur) => {
          if (cur.version !== versionAtSchedule || !cur.mk || cur.currentFlip === null) return;
          if (cur.state.currentPlayer !== "p2") return;
          const power = fromWirePower(cur.mk);
          const action = pickBotPowerAction(cur.state, power, cur.currentPowerMoves ?? [], cur.currentFlip, Math.random);
          if (action) await applyBotPowerAction(cur, "p2", action);
        });
      }
      if (moves.length === 0) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return;
          const skipped = cur.state.currentPlayer;
          const skipReason = cur.currentFlip === 0 ? "flip-zero" : "no-legal-move";
          let lastChargeEvent = null;
          if (skipReason === "flip-zero" && cur.mk && cur.zeroFlipChargeBefore !== null) {
            const delta = cur.mk.charges[skipped] - cur.zeroFlipChargeBefore;
            lastChargeEvent = delta !== 0 ? { player: skipped, delta } : null;
          }
          const mk = cur.mk ? toWirePower(breakShieldStreak(fromWirePower(cur.mk), skipped)) : cur.mk;
          const next = {
            ...cur,
            state: applyNoMove(cur.state),
            mk,
            currentFlip: null,
            currentPowerMoves: null,
            wasSkipped: true,
            skippedPlayer: skipped,
            skipReason,
            lastChargeEvent,
            zeroFlipChargeBefore: null
          };
          if (await commit(next)) await maybeDrive(next);
        }, AUTO_SKIP_DELAY_MS);
        return;
      }
      if (isBotTurn) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return;
          if (cur.currentFlip === null || cur.state.currentPlayer !== "p2") return;
          if (cur.variant === "masterKiller" && cur.mk) {
            const power = fromWirePower(cur.mk);
            const botMoves2 = cur.currentPowerMoves ?? [];
            const action = pickBotPowerAction(cur.state, power, botMoves2, cur.currentFlip, Math.random);
            if (action) await applyBotPowerAction(cur, "p2", action);
            return;
          }
          const botMoves = getLegalMoves(cur.state, cur.currentFlip);
          if (botMoves.length === 0) return;
          await applyChosenMove(cur, "p2", pickBotMove(cur.state, botMoves));
        }, BOT_THINK_MS);
        return;
      }
    };
    const applyChosenMove = async (doc, seat, moveIndex) => {
      if (doc.state.winner) {
        send({ type: "error", message: "Game is over" });
        return;
      }
      if (doc.state.currentPlayer !== seat) {
        send({ type: "error", message: "Not your turn" });
        return;
      }
      if (doc.currentFlip === null) {
        send({ type: "error", message: "No flip yet" });
        return;
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (moveIndex < 0 || moveIndex >= moves.length) {
        send({ type: "error", message: "Invalid move index" });
        return;
      }
      const move = moves[moveIndex];
      const next = {
        ...doc,
        state: applyMove(doc.state, move),
        currentFlip: null,
        captures: {
          ...doc.captures,
          [seat]: doc.captures[seat] + move.captures.length
        },
        lastMove: move,
        lastMovePlayer: seat,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(
          `[${doc.code}] ${seat} tok${move.tokenId} ${move.from}->${move.to} win=${move.causesWin}`
        );
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerMove = async (doc, seat, move) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyPowerMove(doc.state, fromWirePower(doc.mk), move, seat, Math.random);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
      const captureCount = move.captures.length + move.bonusCaptures.length + rainHit;
      const next = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + captureCount },
        lastMove: move,
        lastMovePlayer: seat,
        lastPush: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: r.rainOfArrows,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(
          `[${doc.code}] [MOVE] ${seat} tok${move.tokenId} ${move.from}->${move.to} caps=${captureCount} snipe=${move.bonusCaptures.length > 0} win=${move.causesWin} rainOfArrows=${rainHit === 1}`
        );
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerCharge = async (doc, seat, move) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyCharge(doc.state, fromWirePower(doc.mk), move, seat, Math.random);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
      const captureCount = move.captures.length + move.bonusCaptures.length + move.chargeSweepCaptures.length + rainHit;
      const next = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + captureCount },
        lastMove: move,
        lastMovePlayer: seat,
        lastPush: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: r.rainOfArrows,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [CHARGE] ${seat} tok${move.tokenId} ${move.from}->${move.to} caps=${captureCount} win=${move.causesWin}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerPush = async (doc, seat, targetTokenId) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyPush(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        lastMove: null,
        lastMovePlayer: seat,
        lastPush: { targetTokenId },
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [PUSH] ${seat} -> tok${targetTokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerBlinkStrike = async (doc, seat, targetTokenId) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyBlinkStrike(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + 1 + r.sweptTokenIds.length },
        lastMove: null,
        lastMovePlayer: seat,
        lastPush: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: { kind: "blinkStrike", targetTokenId, sweptTokenIds: r.sweptTokenIds },
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [BLINK STRIKE] ${seat} -> tok${targetTokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerWarpath = async (doc, seat, targetTokenId) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyWarpath(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + 1 + r.sweptTokenIds.length },
        lastMove: null,
        lastMovePlayer: seat,
        lastPush: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: { kind: "warpath", targetTokenId, sweptTokenIds: r.sweptTokenIds },
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [WARPATH] ${seat} -> tok${targetTokenId} swept=${r.sweptTokenIds.length}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyMasterKillerReflip = async (doc, seat) => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      let power = applyReflip(fromWirePower(doc.mk), seat);
      const flip = flipCoins();
      if (flip === 0) power = grantZeroFlipCharge(power, seat);
      const chargeDelta = power.charges[seat] - chargesBefore;
      const next = {
        ...doc,
        mk: toWirePower(power),
        currentFlip: flip,
        currentPowerMoves: getLegalPowerMoves(doc.state, power, flip),
        lastMove: null,
        lastPush: null,
        lastRainOfArrows: null,
        lastUltimate: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] ${seat} re-flipped -> ${flip}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };
    const applyBotPowerAction = async (doc, seat, action) => {
      switch (action.kind) {
        case "move":
          await applyMasterKillerMove(doc, seat, action.move);
          break;
        case "charge":
          await applyMasterKillerCharge(doc, seat, action.move);
          break;
        case "push":
          await applyMasterKillerPush(doc, seat, action.targetTokenId);
          break;
        case "reflip":
          await applyMasterKillerReflip(doc, seat);
          break;
        case "blinkStrike":
          await applyMasterKillerBlinkStrike(doc, seat, action.targetTokenId);
          break;
        case "warpath":
          await applyMasterKillerWarpath(doc, seat, action.targetTokenId);
          break;
      }
    };
    const handlePickClass = async (doc, seat, cls) => {
      if (doc.phase !== "classPick" || !doc.mk || doc.classesPicked[seat]) return;
      const next = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, [seat]: cls } },
        classesPicked: { ...doc.classesPicked, [seat]: true }
      };
      if (await commit(next)) await maybeDriveClassPick(next);
      else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDriveClassPick(reloaded);
      }
    };
    const handleUsePower = async (doc, seat, action) => {
      if (doc.variant !== "masterKiller" || !doc.mk) {
        send({ type: "error", message: "Not a Master Killer room" });
        return;
      }
      if (doc.state.winner !== null) {
        send({ type: "error", message: "Game is over" });
        return;
      }
      if (doc.phase !== "play" || doc.state.currentPlayer !== seat) {
        send({ type: "error", message: "Not your turn" });
        return;
      }
      const cls = doc.mk.classes[seat];
      if (action.kind === "reflip") {
        if (cls !== "mage") return send({ type: "error", message: "Only a Mage can Re-flip" });
        if (doc.mk.charges[seat] < 1) return send({ type: "error", message: "No charge available" });
        if (doc.mk.reflipUsedThisTurn) return send({ type: "error", message: "Already re-flipped this turn" });
        await applyMasterKillerReflip(doc, seat);
        return;
      }
      if (action.kind === "push") {
        if (cls !== "archer") return send({ type: "error", message: "Only an Archer can Push" });
        if (doc.mk.charges[seat] < 1) return send({ type: "error", message: "No charge available" });
        if (!getPushTargets(doc.state, fromWirePower(doc.mk), seat).includes(action.targetTokenId)) {
          return send({ type: "error", message: "Invalid push target" });
        }
        await applyMasterKillerPush(doc, seat, action.targetTokenId);
        return;
      }
      if (action.kind === "blinkStrike") {
        if (cls !== "mage") return send({ type: "error", message: "Only a Mage can Blink Strike" });
        if (!doc.mk.ultimateReady[seat]) return send({ type: "error", message: "Ultimate not ready" });
        if (!getBlinkStrikeTargets(doc.state, fromWirePower(doc.mk), seat).includes(action.targetTokenId)) {
          return send({ type: "error", message: "Invalid Blink Strike target" });
        }
        await applyMasterKillerBlinkStrike(doc, seat, action.targetTokenId);
        return;
      }
      if (action.kind === "warpath") {
        if (cls !== "warrior") return send({ type: "error", message: "Only a Warrior can Warpath" });
        if (!doc.mk.ultimateReady[seat]) return send({ type: "error", message: "Ultimate not ready" });
        if (!getWarpathTargets(doc.state, fromWirePower(doc.mk), seat).includes(action.targetTokenId)) {
          return send({ type: "error", message: "Invalid Warpath target" });
        }
        await applyMasterKillerWarpath(doc, seat, action.targetTokenId);
        return;
      }
      if (cls !== "warrior") return send({ type: "error", message: "Only a Warrior can Charge" });
      if (doc.mk.charges[seat] < 1) return send({ type: "error", message: "No charge available" });
      if (!doc.currentPowerMoves || action.moveIndex < 0 || action.moveIndex >= doc.currentPowerMoves.length) {
        return send({ type: "error", message: "Invalid move index" });
      }
      const move = doc.currentPowerMoves[action.moveIndex];
      if (!move.chargeAvailable) return send({ type: "error", message: "Charge not available for that move" });
      await applyMasterKillerCharge(doc, seat, move);
    };
    const subscribeToRoom = async (code) => {
      await sub.subscribe(roomChannel(code));
      sub.on("message", async (_channel, payload) => {
        const doc = JSON.parse(payload);
        sendStateView(doc);
        await maybeDriveClassPick(doc);
        await maybeDriveOpening(doc);
        await maybeDrive(doc);
      });
    };
    const seatIn = async (doc, seat, token) => {
      mySeat = seat;
      myRoom = doc.code;
      await subscribeToRoom(doc.code);
      send({
        type: "role",
        player: seat,
        room: doc.code,
        vsCpu: doc.vsCpu,
        variant: doc.variant,
        seatToken: token
      });
    };
    const handleJoin = async (msg) => {
      if (myRoom) {
        send({ type: "error", message: "Already in a room" });
        return;
      }
      if (msg.mode === "join") {
        const code2 = (msg.room ?? "").trim().toUpperCase();
        const doc = await loadDoc(code2);
        if (!doc) {
          send({ type: "error", message: `Room ${code2 || "?"} not found` });
          return;
        }
        if (doc.seats.p2 !== null) {
          send({ type: "error", message: `Room ${code2} is already full` });
          return;
        }
        const token = randomUUID();
        const next = {
          ...doc,
          seats: { ...doc.seats, p2: token },
          started: true
        };
        if (!await commit(next)) {
          send({ type: "error", message: `Room ${code2} is already full` });
          return;
        }
        await seatIn(next, "p2", token);
        await maybeDriveClassPick(next);
        await maybeDriveOpening(next);
        return;
      }
      let code = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        code = Array.from(
          randomBytes(4),
          (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]
        ).join("");
        const token = randomUUID();
        const variant = msg.variant === "masterKiller" ? "masterKiller" : "classic";
        const doc = {
          code,
          vsCpu: msg.mode === "cpu",
          seats: { p1: token, p2: msg.mode === "cpu" ? "BOT" : null },
          started: msg.mode === "cpu",
          variant,
          ...freshMatchFields(variant),
          version: 1
        };
        const created = await redis.set(
          roomKey(code),
          JSON.stringify(doc),
          "EX",
          ROOM_TTL_S,
          "NX"
        );
        if (created) {
          await seatIn(doc, "p1", token);
          if (doc.started) {
            sendStateView(doc);
            await maybeDriveClassPick(doc);
            await maybeDriveOpening(doc);
          } else {
            send({ type: "waiting", reason: "Waiting for opponent" });
          }
          return;
        }
      }
      send({ type: "error", message: "Could not allocate a room, try again" });
    };
    const handleRejoin = async (msg) => {
      if (myRoom) {
        const cur = await loadDoc(myRoom);
        if (cur) sendStateView(cur);
        return;
      }
      const doc = await loadDoc((msg.room ?? "").toUpperCase());
      if (!doc || doc.seats[msg.seat] !== msg.seatToken) {
        send({ type: "error", message: "Room not found" });
        return;
      }
      await seatIn(doc, msg.seat, msg.seatToken);
      sendStateView(doc);
      if (!doc.started) send({ type: "waiting", reason: "Waiting for opponent" });
      await maybeDriveClassPick(doc);
      await maybeDriveOpening(doc);
      await maybeDrive(doc);
    };
    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send({ type: "error", message: "Invalid JSON" });
        return;
      }
      try {
        if (msg.type === "join") await handleJoin(msg);
        else if (msg.type === "rejoin") await handleRejoin(msg);
        else if (!myRoom || !mySeat) {
          send({ type: "error", message: "Join a room first" });
        } else if (msg.type === "openingFlip") {
          const doc = await loadDoc(myRoom);
          if (!doc || doc.phase !== "opening" || doc.openingFlips[mySeat] !== null) {
            return;
          }
          const next = {
            ...doc,
            openingFlips: { ...doc.openingFlips, [mySeat]: flipCoins() }
          };
          if (await commit(next)) await maybeDriveOpening(next);
        } else if (msg.type === "pickClass") {
          const doc = await loadDoc(myRoom);
          if (doc) await handlePickClass(doc, mySeat, msg.class);
        } else if (msg.type === "usePower") {
          const doc = await loadDoc(myRoom);
          if (doc) await handleUsePower(doc, mySeat, msg.action);
        } else if (msg.type === "chooseMove") {
          const doc = await loadDoc(myRoom);
          if (!doc) return;
          if (doc.variant === "masterKiller") {
            if (doc.state.winner !== null) {
              send({ type: "error", message: "Game is over" });
              return;
            }
            if (doc.phase !== "play" || doc.state.currentPlayer !== mySeat) {
              send({ type: "error", message: "Not your turn" });
              return;
            }
            if (!doc.mk || !doc.currentPowerMoves || msg.moveIndex < 0 || msg.moveIndex >= doc.currentPowerMoves.length) {
              send({ type: "error", message: "Invalid move index" });
              return;
            }
            await applyMasterKillerMove(doc, mySeat, doc.currentPowerMoves[msg.moveIndex]);
          } else {
            await applyChosenMove(doc, mySeat, msg.moveIndex);
          }
        } else if (msg.type === "newMatch") {
          const doc = await loadDoc(myRoom);
          if (!doc) return;
          if (doc.state.winner === null) {
            send({ type: "error", message: "Current match hasn't ended" });
            return;
          }
          lastAnnouncedWinner = null;
          const next = { ...doc, ...freshMatchFields(doc.variant) };
          if (await commit(next)) {
            await maybeDriveClassPick(next);
            await maybeDriveOpening(next);
          }
        }
      } catch (err) {
        console.error("ws message error", err);
        send({ type: "error", message: "Server error" });
      }
    });
    ws.on("close", () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      redis.quit().catch(() => {
      });
      sub.quit().catch(() => {
      });
    });
  });
}
export {
  GET,
  config
};
