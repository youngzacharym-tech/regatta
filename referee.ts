// ============================================================================
// referee.ts — Regatta's local/dev server: static files + the /api/room
// polling endpoint in one Node process.
//
// This is the SAME transport contract as the Vercel function (api/room.ts) —
// the client cannot tell them apart — but over an in-memory Map instead of
// Redis. All game behavior lives in room-engine.ts, shared verbatim, so the
// two servers cannot drift.
//
// Concurrency note: every handler step (load → applyAction/tick → store) is
// synchronous between awaits, so Node's single thread makes each step atomic
// — no CAS needed here. Long-polls re-read the Map on a short cadence, which
// also drives bot turns and auto-skips while a client holds.
//
// Rooms have no sockets to die with; a room is reaped only when every human
// seat has been silent past OPPONENT_LEFT_MS (mobile-backgrounding safe).
//
// Run:
//   npm run referee
//   PORT=9000 npm run referee   <- override port
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile, stat } from "fs/promises";
import { extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { PlayerId } from "./rulebook.ts";
import type { RoomRequest, RoomJoinResponse, RoomResponse } from "./protocol.ts";
import {
  createRoomDoc,
  startRoom,
  applyAction,
  tick,
  viewFor,
  OPPONENT_LEFT_MS,
  type RoomDoc,
  type RoomActionInput,
} from "./room-engine.ts";

const PORT = Number(process.env.PORT ?? 8080);
const LONG_POLL_CAP_MS = 20_000;
const LONG_POLL_STEP_MS = 300;
const REAP_SWEEP_MS = 60_000;

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
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// Rooms — in-memory docs, keyed by shareable code.
// ---------------------------------------------------------------------------

const rooms = new Map<string, RoomDoc>();

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

function touchSeat(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  return { ...doc, seatLastSeen: { ...doc.seatLastSeen, [seat]: now } };
}

/** Reap rooms whose every human seat has gone silent. */
setInterval(() => {
  const now = Date.now();
  for (const [code, doc] of rooms) {
    const humanSeats: PlayerId[] = doc.vsCpu ? ["p1"] : ["p1", "p2"];
    const allGone = humanSeats.every((s) => now - doc.seatLastSeen[s] > OPPONENT_LEFT_MS);
    if (allGone) {
      console.log(`[${code}] reaped (idle)`);
      rooms.delete(code);
    }
  }
}, REAP_SWEEP_MS).unref();

// ---------------------------------------------------------------------------
// /api/room — same request/response contract as the Vercel function.
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function handleJoin(msg: Extract<RoomRequest, { op: "join" }>, res: ServerResponse): void {
  const now = Date.now();
  if (msg.mode === "join") {
    const code = (msg.room ?? "").trim().toUpperCase();
    const doc = rooms.get(code);
    if (!doc) return sendJson(res, { error: `Room ${code || "?"} not found` }, 404);
    if (doc.seats.p2 !== null) return sendJson(res, { error: `Room ${code} is already full` }, 409);
    const token = randomUUID();
    const next = tick(startRoom({ ...doc, seats: { ...doc.seats, p2: token } }, now), now);
    rooms.set(code, next);
    console.log(`[+] p2 seated in room ${code} (${next.variant})`);
    const body: RoomJoinResponse = {
      player: "p2",
      room: code,
      vsCpu: next.vsCpu,
      variant: next.variant,
      seatToken: token,
      view: viewFor(next, "p2", 0, now),
    };
    return sendJson(res, body);
  }

  const vsCpu = msg.mode === "cpu";
  const variant = msg.variant === "masterKiller" ? "masterKiller" : "classic";
  const token = randomUUID();
  const code = newRoomCode();
  const doc = tick(createRoomDoc(code, vsCpu, variant, token, now), now);
  rooms.set(code, doc);
  console.log(`[+] p1 seated in room ${code} (${variant})${vsCpu ? " (vs CPU)" : ""}`);
  const body: RoomJoinResponse = {
    player: "p1",
    room: code,
    vsCpu,
    variant,
    seatToken: token,
    view: viewFor(doc, "p1", 0, now),
  };
  sendJson(res, body);
}

async function handleRoomApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(200, { "Cache-Control": "no-store" });
    res.end("Regatta room API — POST RoomRequest JSON here.");
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let msg: RoomRequest;
  try {
    msg = JSON.parse(Buffer.concat(chunks).toString()) as RoomRequest;
  } catch {
    return sendJson(res, { error: "Invalid JSON" }, 400);
  }

  if (msg.op === "join") return handleJoin(msg, res);

  const { room, seat, seatToken } = msg;
  const doc0 = rooms.get(room ?? "");
  if (!doc0) return sendJson(res, { error: "Room not found" }, 404);
  if (doc0.seats[seat] !== seatToken) return sendJson(res, { error: "Bad seat token" }, 403);

  if (msg.op === "poll") {
    const since = msg.since ?? 0;
    const deadline = Date.now() + (msg.wait === false ? 0 : LONG_POLL_CAP_MS);
    for (;;) {
      const now = Date.now();
      const cur = rooms.get(room);
      if (!cur) return sendJson(res, { error: "Room not found" }, 404);
      const ticked = tick(touchSeat(cur, seat, now), now);
      rooms.set(room, ticked);
      if (ticked.seq > since || now >= deadline || res.writableEnded) {
        const view: RoomResponse = viewFor(ticked, seat, since, now);
        return sendJson(res, view);
      }
      await new Promise((r) => setTimeout(r, LONG_POLL_STEP_MS));
    }
  }

  // A game action — synchronous step, atomic on the event loop. Tick FIRST
  // so overdue deadlines land before the action, like the old timers did.
  const now = Date.now();
  const cur = rooms.get(room);
  if (!cur) return sendJson(res, { error: "Room not found" }, 404);
  const pre = tick(touchSeat(cur, seat, now), now);
  const stepped = applyAction(pre, seat, msg as RoomActionInput, now);
  const ticked = tick(stepped.doc, now);
  rooms.set(room, ticked);
  if (stepped.error) console.log(`[${room}] ${seat} ${msg.op} rejected: ${stepped.error}`);
  // Action replies carry no replay (since = latest): the poll loop delivers
  // the new events, exactly once, ordered by seq.
  const view: RoomResponse = { ...viewFor(ticked, seat, ticked.seq, now), error: stepped.error };
  sendJson(res, view);
}

// ---------------------------------------------------------------------------
// Static file server — serves the built Vite bundle from stage/dist.
// ---------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const urlPath = url.split("?")[0].split("#")[0];
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
        "Static build not found. Run `npm run build` first, " +
          "or use the Vite dev server for local development.",
      );
    }
  }
}

// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  const handler = urlPath === "/api/room" ? handleRoomApi(req, res) : serveStatic(req, res);
  handler.catch((err) => {
    console.error("handler error", err);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  });
});

httpServer.listen(PORT, () => {
  console.log(`Regatta server listening on port ${PORT}`);
  console.log(`  http://localhost:${PORT}/          (Stage — Vite build from stage/dist)`);
  console.log(`  http://localhost:${PORT}/api/room  (polling referee API)`);
});
