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

// api/ws.ts
var config = { maxDuration: 300 };
var ROOM_TTL_S = 4 * 60 * 60;
var AUTO_SKIP_DELAY_MS = 500;
var BOT_THINK_MS = 900;
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;
var roomKey = (code) => `room:${code}`;
var roomChannel = (code) => `room:${code}:ch`;
var CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cjson.decode(cur).version ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;
function freshMatchFields() {
  const state = initialState();
  state.currentPlayer = Math.random() < 0.5 ? "p1" : "p2";
  return {
    state,
    currentFlip: null,
    turns: 0,
    captures: { p1: 0, p2: 0 },
    lastMove: null,
    lastMovePlayer: null,
    wasSkipped: false,
    skippedPlayer: null,
    skipReason: null
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
    const sendStateView = (doc) => {
      if (!mySeat || !doc.started) return;
      if (doc.state.winner === null) lastAnnouncedWinner = null;
      const legalMoves = doc.currentFlip !== null && doc.state.currentPlayer === mySeat ? getLegalMoves(doc.state, doc.currentFlip) : null;
      send({
        type: "state",
        state: doc.state,
        flip: doc.currentFlip,
        legalMoves,
        lastMove: doc.lastMove,
        lastMovePlayer: doc.lastMovePlayer,
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
    const maybeDrive = async (doc) => {
      if (!doc.started || doc.state.winner || !iDrive(doc)) return;
      if (doc.currentFlip === null) {
        const next = {
          ...doc,
          currentFlip: flipCoins(),
          turns: doc.turns + 1,
          // A fresh flip consumes the previous announcement.
          lastMove: null,
          lastMovePlayer: null,
          wasSkipped: false,
          skippedPlayer: null,
          skipReason: null
        };
        if (await commit(next)) await maybeDrive(next);
        else {
          const reloaded = await loadDoc(doc.code);
          if (reloaded) await maybeDrive(reloaded);
        }
        return;
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (moves.length === 0) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return;
          const skipped = cur.state.currentPlayer;
          const next = {
            ...cur,
            state: applyNoMove(cur.state),
            currentFlip: null,
            wasSkipped: true,
            skippedPlayer: skipped,
            skipReason: cur.currentFlip === 0 ? "flip-zero" : "no-legal-move"
          };
          if (await commit(next)) await maybeDrive(next);
        }, AUTO_SKIP_DELAY_MS);
        return;
      }
      if (doc.vsCpu && doc.state.currentPlayer === "p2") {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return;
          if (cur.currentFlip === null || cur.state.currentPlayer !== "p2") return;
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
    const subscribeToRoom = async (code) => {
      await sub.subscribe(roomChannel(code));
      sub.on("message", async (_channel, payload) => {
        const doc = JSON.parse(payload);
        sendStateView(doc);
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
        await maybeDrive(next);
        return;
      }
      let code = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        code = Array.from(
          randomBytes(4),
          (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]
        ).join("");
        const token = randomUUID();
        const doc = {
          code,
          vsCpu: msg.mode === "cpu",
          seats: { p1: token, p2: msg.mode === "cpu" ? "BOT" : null },
          started: msg.mode === "cpu",
          ...freshMatchFields(),
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
          if (doc.started) await maybeDrive(doc);
          else send({ type: "waiting", reason: "Waiting for opponent" });
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
        } else if (msg.type === "chooseMove") {
          const doc = await loadDoc(myRoom);
          if (doc) await applyChosenMove(doc, mySeat, msg.moveIndex);
        } else if (msg.type === "newMatch") {
          const doc = await loadDoc(myRoom);
          if (!doc) return;
          if (doc.state.winner === null) {
            send({ type: "error", message: "Current match hasn't ended" });
            return;
          }
          lastAnnouncedWinner = null;
          const next = { ...doc, ...freshMatchFields() };
          if (await commit(next)) await maybeDrive(next);
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
