// ============================================================================
// api/ws.ts — Regatta referee as a Vercel Function (WebSocket + Redis).
//
// The local referee (referee.ts) keeps rooms in process memory, which works
// because it's one long-lived process. On Vercel, each WebSocket connection
// is its own function invocation (possibly a different instance), and
// connections are recycled at the function's max duration. So here:
//
//   - Room state lives in Redis (Upstash) as a JSON doc with a version
//     number. Writes are compare-and-set via a Lua script; a losing writer
//     reloads and re-evaluates.
//   - Broadcasts go through a Redis pub/sub channel per room. Every
//     connection subscribes and derives ITS seat's view (legalMoves only for
//     the current player) from the published doc.
//   - "Driving" (flipping coins, auto-skipping, bot turns) is done by the
//     connection whose seat owns the current turn — or by the human's
//     connection for bot turns. If that connection is mid-reconnect, the
//     turn resumes the moment it rejoins: rejoining always re-evaluates.
//   - Clients hold a seat token (issued on join) and rejoin with it after
//     reconnects and page reloads. Rooms expire from Redis after inactivity.
//
// Game logic is untouched: rulebook.ts decides legality, bot.ts picks CPU
// moves — both shared verbatim with the local referee.
// ============================================================================

import { experimental_upgradeWebSocket } from "@vercel/functions";
import Redis from "ioredis";
import { randomBytes, randomUUID } from "crypto";
import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  type GameState,
  type Move,
  type PlayerId,
} from "../rulebook";
import { pickBotMove } from "../bot";
import type { ServerMessage, ClientMessage } from "../protocol";

export const config = { maxDuration: 300 };

const ROOM_TTL_S = 4 * 60 * 60; // idle rooms evaporate after 4h
const AUTO_SKIP_DELAY_MS = 500;
const BOT_THINK_MS = 900;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const REDIS_URL =
  process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;

interface RoomDoc {
  code: string;
  vsCpu: boolean;
  seats: { p1: string | null; p2: string | null }; // seat tokens ("BOT" for cpu p2)
  started: boolean;
  state: GameState;
  currentFlip: number | null;
  turns: number;
  captures: { p1: number; p2: number };
  lastMove: Move | null;
  lastMovePlayer: PlayerId | null;
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
  version: number;
}

const roomKey = (code: string) => `room:${code}`;
const roomChannel = (code: string) => `room:${code}:ch`;

// Compare-and-set: write only if the stored version matches what we read.
const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cjson.decode(cur).version ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

function freshMatchFields(): Pick<
  RoomDoc,
  | "state" | "currentFlip" | "turns" | "captures"
  | "lastMove" | "lastMovePlayer" | "wasSkipped" | "skippedPlayer" | "skipReason"
> {
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
    skipReason: null,
  };
}

export function GET(request: Request) {
  if (!REDIS_URL) {
    return new Response("Realtime backend not configured (missing REDIS_URL)", {
      status: 500,
    });
  }
  // Plain HTTP GETs (health checks, curious browsers) aren't upgradable —
  // answer instead of letting the upgrade helper throw.
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Regatta referee — connect via WebSocket", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  return experimental_upgradeWebSocket(async (ws) => {
    const redis = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);

    let mySeat: PlayerId | null = null;
    let myRoom: string | null = null;
    let lastAnnouncedWinner: PlayerId | null = null;
    // Timers scheduled against a doc version; cancelled implicitly by CAS.
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (msg: ServerMessage) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {}
    };

    const loadDoc = async (code: string): Promise<RoomDoc | null> => {
      const raw = await redis.get(roomKey(code));
      return raw ? (JSON.parse(raw) as RoomDoc) : null;
    };

    /** CAS-write `next` (version bumped) and publish it. False = lost race. */
    const commit = async (next: RoomDoc): Promise<boolean> => {
      const prevVersion = next.version;
      next.version = prevVersion + 1;
      const ok = (await redis.eval(
        CAS_LUA,
        1,
        roomKey(next.code),
        String(prevVersion),
        JSON.stringify(next),
        String(ROOM_TTL_S),
      )) as number;
      if (ok === 1) {
        await redis.publish(roomChannel(next.code), JSON.stringify(next));
        return true;
      }
      return false;
    };

    /** Derive and send THIS seat's view of a doc. */
    const sendStateView = (doc: RoomDoc) => {
      if (!mySeat || !doc.started) return;
      // A doc without a winner means a fresh match — re-arm gameOver delivery.
      if (doc.state.winner === null) lastAnnouncedWinner = null;
      const legalMoves =
        doc.currentFlip !== null && doc.state.currentPlayer === mySeat
          ? getLegalMoves(doc.state, doc.currentFlip)
          : null;
      send({
        type: "state",
        state: doc.state,
        flip: doc.currentFlip,
        legalMoves,
        lastMove: doc.lastMove,
        lastMovePlayer: doc.lastMovePlayer,
        wasSkipped: doc.wasSkipped,
        skippedPlayer: doc.skippedPlayer,
        skipReason: doc.skipReason,
      });
      if (doc.state.winner && lastAnnouncedWinner !== doc.state.winner) {
        lastAnnouncedWinner = doc.state.winner;
        send({
          type: "gameOver",
          winner: doc.state.winner,
          stats: { turns: doc.turns, captures: { ...doc.captures } },
        });
      }
    };

    /** Is this connection responsible for advancing the current turn? */
    const iDrive = (doc: RoomDoc): boolean => {
      if (!mySeat) return false;
      const turnOwner = doc.state.currentPlayer;
      if (doc.vsCpu) return mySeat === "p1"; // human drives self AND bot
      return turnOwner === mySeat;
    };

    /** Advance the room if it's stalled on something we're responsible for. */
    const maybeDrive = async (doc: RoomDoc): Promise<void> => {
      if (!doc.started || doc.state.winner || !iDrive(doc)) return;

      // Needs a coin flip to start the turn.
      if (doc.currentFlip === null) {
        const next: RoomDoc = {
          ...doc,
          currentFlip: flipCoins(),
          turns: doc.turns + 1,
          // A fresh flip consumes the previous announcement.
          lastMove: null,
          lastMovePlayer: null,
          wasSkipped: false,
          skippedPlayer: null,
          skipReason: null,
        };
        if (await commit(next)) await maybeDrive(next);
        else {
          const reloaded = await loadDoc(doc.code);
          if (reloaded) await maybeDrive(reloaded);
        }
        return;
      }

      const moves = getLegalMoves(doc.state, doc.currentFlip);

      // No legal move: auto-skip after a beat so clients can show the flip.
      if (moves.length === 0) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return; // superseded
          const skipped = cur.state.currentPlayer;
          const next: RoomDoc = {
            ...cur,
            state: applyNoMove(cur.state),
            currentFlip: null,
            wasSkipped: true,
            skippedPlayer: skipped,
            skipReason: cur.currentFlip === 0 ? "flip-zero" : "no-legal-move",
          };
          if (await commit(next)) await maybeDrive(next);
        }, AUTO_SKIP_DELAY_MS);
        return;
      }

      // Bot's turn: think, then move.
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
      // Otherwise: our own human turn — wait for the client's chooseMove.
    };

    const applyChosenMove = async (
      doc: RoomDoc,
      seat: PlayerId,
      moveIndex: number,
    ): Promise<void> => {
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
      const next: RoomDoc = {
        ...doc,
        state: applyMove(doc.state, move),
        currentFlip: null,
        captures: {
          ...doc.captures,
          [seat]: doc.captures[seat] + move.captures.length,
        },
        lastMove: move,
        lastMovePlayer: seat,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(
          `[${doc.code}] ${seat} tok${move.tokenId} ${move.from}->${move.to} win=${move.causesWin}`,
        );
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const subscribeToRoom = async (code: string) => {
      await sub.subscribe(roomChannel(code));
      sub.on("message", async (_channel, payload) => {
        const doc = JSON.parse(payload) as RoomDoc;
        sendStateView(doc);
        await maybeDrive(doc);
      });
    };

    const seatIn = async (doc: RoomDoc, seat: PlayerId, token: string) => {
      mySeat = seat;
      myRoom = doc.code;
      await subscribeToRoom(doc.code);
      send({
        type: "role",
        player: seat,
        room: doc.code,
        vsCpu: doc.vsCpu,
        seatToken: token,
      });
    };

    const handleJoin = async (msg: Extract<ClientMessage, { type: "join" }>) => {
      if (myRoom) {
        send({ type: "error", message: "Already in a room" });
        return;
      }

      if (msg.mode === "join") {
        const code = (msg.room ?? "").trim().toUpperCase();
        const doc = await loadDoc(code);
        if (!doc) {
          send({ type: "error", message: `Room ${code || "?"} not found` });
          return;
        }
        if (doc.seats.p2 !== null) {
          send({ type: "error", message: `Room ${code} is already full` });
          return;
        }
        const token = randomUUID();
        const next: RoomDoc = {
          ...doc,
          seats: { ...doc.seats, p2: token },
          started: true,
        };
        if (!(await commit(next))) {
          send({ type: "error", message: `Room ${code} is already full` });
          return;
        }
        await seatIn(next, "p2", token);
        await maybeDrive(next); // p2 might own the first (randomized) turn
        return;
      }

      // create / cpu — mint a fresh room.
      let code = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        code = Array.from(
          randomBytes(4),
          (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
        ).join("");
        const token = randomUUID();
        const doc: RoomDoc = {
          code,
          vsCpu: msg.mode === "cpu",
          seats: { p1: token, p2: msg.mode === "cpu" ? "BOT" : null },
          started: msg.mode === "cpu",
          ...freshMatchFields(),
          version: 1,
        };
        const created = await redis.set(
          roomKey(code),
          JSON.stringify(doc),
          "EX",
          ROOM_TTL_S,
          "NX",
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

    const handleRejoin = async (
      msg: Extract<ClientMessage, { type: "rejoin" }>,
    ) => {
      if (myRoom) {
        // Already seated on this socket — just repaint, don't double-subscribe.
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
      sendStateView(doc); // immediate snapshot so the board repaints
      if (!doc.started) send({ type: "waiting", reason: "Waiting for opponent" });
      await maybeDrive(doc); // resume anything that stalled while we were away
    };

    ws.on("message", async (data: unknown) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
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
          const next: RoomDoc = { ...doc, ...freshMatchFields() };
          if (await commit(next)) await maybeDrive(next);
        }
      } catch (err) {
        console.error("ws message error", err);
        send({ type: "error", message: "Server error" });
      }
    });

    ws.on("close", () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      redis.quit().catch(() => {});
      sub.quit().catch(() => {});
    });
  });
}
