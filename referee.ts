// ============================================================================
// referee.ts — authoritative WebSocket server + static file host for Regatta.
//
// Responsibilities:
//   - Serve the built Stage's static files (stage/dist/) via HTTP.
//   - Host many concurrent MATCH ROOMS. A client's first message picks a mode:
//       cpu    -> instant room vs the server-side bot (bot.ts)
//       create -> private room; share the 4-letter code / ?room=CODE link
//       join   -> seat as p2 in an existing room by code
//   - Randomize which role starts (counters first-mover advantage).
//   - Own the coin flips (server-side entropy — clients can't cheat).
//   - Own each room's GameState. Validate every move via the rulebook.
//   - Broadcast state after every transition. Only the current player sees
//     legalMoves; the opponent gets null so they can't inspect enemy options.
//   - Auto-skip when there are no legal moves for the flipped roll.
//   - Dissolve a room when a human leaves (remaining player returns to menu).
//
// Run:
//   npm run referee
//   PORT=9000 npm run referee   <- override port
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile, stat } from "fs/promises";
import { extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  type GameState,
  type Move,
  type PlayerId,
} from "./rulebook.ts";
import type { ServerMessage, ClientMessage } from "./protocol.ts";
import { pickBotMove } from "./bot.ts";

const PORT = Number(process.env.PORT ?? 8080);
const AUTO_SKIP_DELAY_MS = 500; // gives clients time to render the flip=0/no-move outcome
const BOT_THINK_MS = 900; // human-feeling pause before the CPU moves

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const STATIC_DIR = resolve(__dirname, "stage", "dist");
const STATIC_DIR_ROOT = resolve(STATIC_DIR);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------

class Match {
  state: GameState;
  currentFlip: number | null = null;
  currentLegalMoves: Move[] | null = null;
  clients: Map<PlayerId, WebSocket> = new Map();
  /** Room code this match lives under (used for logs + invites). */
  readonly code: string;
  /** When true, p2 is the server-side bot — the room is "full" with 1 human. */
  readonly vsCpu: boolean;
  /** Monotonic turn stamp so a stale bot timer can't fire into a new turn. */
  private botTurnStamp = 0;
  /** Every match opens with a flip-off: both players flip, higher count
   *  moves first, ties re-flip. Normal turns don't start until resolved. */
  phase: "opening" | "play" = "opening";
  openingFlips: { p1: number | null; p2: number | null } = { p1: null, p2: null };
  // Stats tracked for the win-screen display.
  turns = 0;
  captures = { p1: 0, p2: 0 };
  // "How did we get to this state" — reset every new turn's coin flip, set by
  // handleChooseMove / applyNoMove so the state broadcast can announce it.
  lastMove: Move | null = null;
  lastMovePlayer: PlayerId | null = null;
  wasSkipped = false;
  skippedPlayer: PlayerId | null = null;
  skipReason: "flip-zero" | "no-legal-move" | null = null;

  constructor(code: string, vsCpu: boolean) {
    this.code = code;
    this.vsCpu = vsCpu;
    this.state = initialState();
    // Randomize first player each match to counter the 52/48 first-mover edge.
    this.state.currentPlayer = Math.random() < 0.5 ? "p1" : "p2";
  }

  addClient(ws: WebSocket): PlayerId | null {
    if (this.isFull()) return null;
    const role: PlayerId = this.clients.has("p1") ? "p2" : "p1";
    this.clients.set(role, ws);
    return role;
  }

  removeClient(role: PlayerId): void {
    this.clients.delete(role);
  }

  isFull(): boolean {
    // The bot permanently occupies p2 in cpu rooms.
    return this.vsCpu ? this.clients.size >= 1 : this.clients.size === 2;
  }

  private send(role: PlayerId, msg: ServerMessage): void {
    const ws = this.clients.get(role);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg: ServerMessage): void {
    this.send("p1", msg);
    this.send("p2", msg);
  }

  private broadcastState(): void {
    for (const role of ["p1", "p2"] as PlayerId[]) {
      this.send(role, {
        type: "state",
        state: this.state,
        flip: this.currentFlip,
        legalMoves:
          this.state.currentPlayer === role ? this.currentLegalMoves : null,
        lastMove: this.lastMove,
        lastMovePlayer: this.lastMovePlayer,
        wasSkipped: this.wasSkipped,
        skippedPlayer: this.skippedPlayer,
        skipReason: this.skipReason,
      });
    }
  }

  // ---- Opening flip-off ----------------------------------------------------

  private broadcastOpening(first: PlayerId | null = null, tie = false): void {
    this.broadcast({
      type: "opening",
      flips: { ...this.openingFlips },
      first,
      tie,
    });
  }

  /** Kick off the flip-off once the room is full. In CPU rooms the bot
   *  flips by itself after a beat. */
  startOpening(): void {
    this.phase = "opening";
    this.openingFlips = { p1: null, p2: null };
    this.broadcastOpening();
    this.scheduleBotOpeningFlip();
  }

  private scheduleBotOpeningFlip(): void {
    if (!this.vsCpu) return;
    const stamp = ++this.botTurnStamp;
    setTimeout(() => {
      if (stamp !== this.botTurnStamp) return;
      if (this.phase === "opening" && this.openingFlips.p2 === null) {
        this.handleOpeningFlip("p2");
      }
    }, BOT_THINK_MS);
  }

  handleOpeningFlip(role: PlayerId): void {
    if (this.phase !== "opening" || this.openingFlips[role] !== null) return;
    this.openingFlips[role] = flipCoins();
    const { p1, p2 } = this.openingFlips;

    if (p1 === null || p2 === null) {
      this.broadcastOpening(); // one side landed — show it, keep waiting
      return;
    }
    if (p1 === p2) {
      // Tie: show both results with the tie flag, then re-arm after the
      // clients have had time to animate the flips.
      this.broadcastOpening(null, true);
      console.log(`[${this.code}] opening tie (${p1}) — re-flipping`);
      setTimeout(() => {
        if (this.phase !== "opening") return;
        this.openingFlips = { p1: null, p2: null };
        this.broadcastOpening();
        this.scheduleBotOpeningFlip();
      }, 1600);
      return;
    }

    const first: PlayerId = p1 > p2 ? "p1" : "p2";
    this.state.currentPlayer = first;
    this.phase = "play";
    this.broadcastOpening(first);
    console.log(`[${this.code}] opening: p1=${p1} p2=${p2} — ${first} moves first`);
    // Give clients a moment to animate + announce before the first turn.
    setTimeout(() => {
      if (this.phase === "play" && this.currentFlip === null) this.advance();
    }, 1400);
  }

  /** Clear per-transition announcement fields. Called at the start of each
   *  new turn (after we've broadcast the previous transition's context). */
  private clearAnnouncement(): void {
    this.lastMove = null;
    this.lastMovePlayer = null;
    this.wasSkipped = false;
    this.skippedPlayer = null;
    this.skipReason = null;
  }

  /** Drive the next turn: flip coins, compute legal moves, broadcast. */
  advance(): void {
    if (this.phase !== "play") return; // no turns until the flip-off resolves
    if (this.state.winner) {
      // Broadcast the final state first so clients can render the winning
      // token's final position before showing the game-over overlay.
      this.broadcastState();
      this.broadcast({
        type: "gameOver",
        winner: this.state.winner,
        stats: { turns: this.turns, captures: { ...this.captures } },
      });
      return;
    }

    this.turns++;
    this.currentFlip = flipCoins();
    this.currentLegalMoves = getLegalMoves(this.state, this.currentFlip);
    this.broadcastState();
    // Once the state is out, the announcement is spent. Anything the next
    // call to broadcastState() shows should be fresh.
    this.clearAnnouncement();

    // CPU turn: think briefly, then move. The stamp guards against a stale
    // timer firing after a skip/new-match already advanced the game.
    if (
      this.vsCpu &&
      this.state.currentPlayer === "p2" &&
      this.currentLegalMoves.length > 0
    ) {
      const stamp = ++this.botTurnStamp;
      setTimeout(() => {
        if (stamp !== this.botTurnStamp) return;
        if (this.currentLegalMoves === null || this.state.currentPlayer !== "p2") return;
        this.handleChooseMove("p2", pickBotMove(this.state, this.currentLegalMoves));
      }, BOT_THINK_MS);
    }

    if (this.currentLegalMoves.length === 0) {
      // Let clients see the flip result before we auto-skip.
      const skippedPlayer = this.state.currentPlayer;
      const reason: "flip-zero" | "no-legal-move" =
        this.currentFlip === 0 ? "flip-zero" : "no-legal-move";
      setTimeout(() => {
        this.state = applyNoMove(this.state);
        this.currentFlip = null;
        this.currentLegalMoves = null;
        this.wasSkipped = true;
        this.skippedPlayer = skippedPlayer;
        this.skipReason = reason;
        this.advance();
      }, AUTO_SKIP_DELAY_MS);
    }
  }

  /** Handle a chooseMove message. Returns true if the game continues. */
  handleChooseMove(role: PlayerId, moveIndex: number): void {
    if (this.state.winner !== null) {
      this.send(role, { type: "error", message: "Game is over" });
      return;
    }
    if (this.state.currentPlayer !== role) {
      this.send(role, { type: "error", message: "Not your turn" });
      return;
    }
    if (
      this.currentLegalMoves === null ||
      moveIndex < 0 ||
      moveIndex >= this.currentLegalMoves.length
    ) {
      this.send(role, { type: "error", message: "Invalid move index" });
      return;
    }

    const move = this.currentLegalMoves[moveIndex];
    this.captures[role] += move.captures.length;
    this.lastMove = move;
    this.lastMovePlayer = role;
    this.state = applyMove(this.state, move);
    this.currentFlip = null;
    this.currentLegalMoves = null;

    // Server-side sanity log — shows every move so we can compare against
    // the client's on-screen announcement to catch rulebook bugs.
    console.log(
      `[MOVE] ${role} tok${move.tokenId} ${move.from}->${move.to}`,
      `caps=${move.captures.length}`,
      `shield=${move.landsOnShield}`,
      `win=${move.causesWin}`,
    );

    this.advance();
  }

  /**
   * Handle a newMatch request. Only starts a new game once the current one
   * has ended, so a mid-game misclick from a stale button can't reset play.
   */
  handleNewMatch(role: PlayerId): void {
    if (this.state.winner === null) {
      this.send(role, {
        type: "error",
        message: "Current match hasn't ended",
      });
      return;
    }
    // Fresh state + stats; the opening flip-off decides who moves first.
    this.state = initialState();
    this.currentFlip = null;
    this.currentLegalMoves = null;
    this.turns = 0;
    this.captures = { p1: 0, p2: 0 };
    this.clearAnnouncement();
    console.log(`new match started (requested by ${role})`);
    this.startOpening();
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static file server — serves the built Vite bundle from stage/dist.
// When you POST-deploy, `npm run build` populates stage/dist. Locally you'd
// usually run Vite's dev server instead (it has HMR); this static path only
// kicks in when stage/dist exists.
// ---------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const urlPath = url.split("?")[0].split("#")[0];
  // Default to index.html for both "/" and any client-side route we don't
  // recognize (SPA-friendly, though this app is currently single-page).
  const requestedPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = resolve(join(STATIC_DIR, requestedPath));

  // Path-traversal guard — refuse anything outside STATIC_DIR.
  if (!filePath.startsWith(STATIC_DIR_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const data = await readFile(filePath);
    const mime = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": info.size,
      "Cache-Control": mime.startsWith("text/html")
        ? "no-cache" // always re-check HTML so deploys land immediately
        : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    // Fallback: serve index.html so client-side routes still work.
    try {
      const indexData = await readFile(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexData);
    } catch {
      res.writeHead(404).end(
        "Static build not found. Run `npm run build` in game/stage first, " +
          "or use the Vite dev server for local development.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lobby — many concurrent rooms, keyed by a short shareable code.
// ---------------------------------------------------------------------------

const rooms = new Map<string, Match>();

// No ambiguous glyphs (0/O, 1/I) — codes get read aloud and typed on phones.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newRoomCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch((err) => {
    console.error("static error", err);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  });
});
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let room: Match | null = null;
  let role: PlayerId | null = null;

  const sendMsg = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const handleJoin = (msg: Extract<ClientMessage, { type: "join" }>) => {
    if (room) {
      sendMsg({ type: "error", message: "Already in a room" });
      return;
    }

    if (msg.mode === "join") {
      const code = (msg.room ?? "").trim().toUpperCase();
      const target = rooms.get(code);
      if (!target) {
        sendMsg({ type: "error", message: `Room ${code || "?"} not found` });
        return;
      }
      if (target.isFull()) {
        sendMsg({ type: "error", message: `Room ${code} is already full` });
        return;
      }
      room = target;
    } else {
      const code = newRoomCode();
      room = new Match(code, msg.mode === "cpu");
      rooms.set(code, room);
    }

    role = room.addClient(ws)!;
    console.log(
      `[+] ${role} seated in room ${room.code}` +
        (room.vsCpu ? " (vs CPU)" : ` (${room.clients.size}/2)`),
    );
    // The local referee dissolves rooms on disconnect, so seat tokens are
    // never actually redeemed here — issued only to satisfy the protocol.
    sendMsg({
      type: "role",
      player: role,
      room: room.code,
      vsCpu: room.vsCpu,
      seatToken: Math.random().toString(36).slice(2),
    });

    if (room.isFull()) {
      console.log(`[${room.code}] match starting — opening flip-off`);
      room.startOpening();
    } else {
      sendMsg({ type: "waiting", reason: "Waiting for opponent" });
    }
  };

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      sendMsg({ type: "error", message: "Invalid JSON" });
      return;
    }

    // If our room was dissolved (opponent left), this connection is back in
    // the lobby and free to join something new.
    if (room && !rooms.has(room.code)) {
      room = null;
      role = null;
    }

    if (msg.type === "join") {
      handleJoin(msg);
    } else if (msg.type === "rejoin") {
      // Local rooms die with their sockets — a rejoin can never succeed here.
      sendMsg({ type: "error", message: "Room not found" });
    } else if (!room || !role) {
      sendMsg({ type: "error", message: "Join a room first" });
    } else if (msg.type === "openingFlip") {
      room.handleOpeningFlip(role);
    } else if (msg.type === "chooseMove") {
      room.handleChooseMove(role, msg.moveIndex);
    } else if (msg.type === "newMatch") {
      room.handleNewMatch(role);
    } else {
      sendMsg({
        type: "error",
        message: `Unknown message type: ${(msg as { type: string }).type}`,
      });
    }
  });

  ws.on("close", () => {
    if (!room || !role) return;
    if (rooms.has(room.code)) {
      console.log(`[-] ${role} left room ${room.code} — dissolving`);
      room.removeClient(role);
      // Any human leaving dissolves the room. The remaining player keeps
      // their connection, gets told, and returns to the menu to rejoin.
      room.broadcast({ type: "opponentLeft" });
      rooms.delete(room.code);
    }
    room = null;
    role = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`Regatta server listening on port ${PORT}`);
  console.log(`  http://localhost:${PORT}/    (Stage — Vite build from stage/dist)`);
  console.log(`  ws://localhost:${PORT}       (Referee WebSocket)`);
});
