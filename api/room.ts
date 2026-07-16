// ============================================================================
// api/room.ts — Regatta's referee as ONE Vercel HTTP function (polling).
//
// This replaces the WebSocket function (api/ws.ts). Why: Vercel time-boxes a
// held-open socket at maxDuration, which recycled every PvP connection like
// clockwork. Polling holds nothing open — every request is a short
// load → applyAction/tick → CAS-commit → view round-trip over the same
// versioned Redis doc the WS version used, so there is nothing left to
// recycle. The turn brain lives in room-engine.ts (pure, shared verbatim
// with the local referee); this file is only transport:
//
//   - POST /api/room  body = RoomRequest (protocol.ts)
//       op:"join"  -> seat the caller (create/join/cpu), mint a seat token
//       op:"poll"  -> long-poll: hold until seq advances or ~20s, then view
//       other ops  -> validate token, applyAction, tick, commit, view
//
//   - Concurrency: optimistic CAS on doc.version (same Lua as before). A
//     lost race reloads and re-runs the pure step — ticks converge (a fired
//     deadline is no longer due) and actions re-validate ("not your turn").
//
//   - Liveness: seatLastSeen heartbeats ride the requests themselves;
//     viewFor() derives opponentAway/opponentLeft from them. No sockets, no
//     close events, no rejoin handshake — a reload polls and resumes.
// ============================================================================

import Redis from "ioredis";
import { randomUUID } from "crypto";
import type { PlayerId } from "../rulebook";
import type { RoomRequest, RoomJoinResponse, RoomResponse, RoomListResponse } from "../protocol";
import {
  createRoomDoc,
  startRoom,
  applyAction,
  tick,
  viewFor,
  type RoomDoc,
  type RoomActionInput,
} from "../room-engine";

export const config = { maxDuration: 60 };

const ROOM_TTL_S = 4 * 60 * 60; // idle rooms evaporate after 4h
const LONG_POLL_CAP_MS = 20_000; // hold ceiling, well under maxDuration
const LONG_POLL_STEP_MS = 500; // re-check cadence while holding
const LASTSEEN_WRITE_THROTTLE_MS = 5_000; // don't CAS-write on every quiet poll

const REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;

// One client per instance, reused across invocations (Fluid Compute keeps
// instances warm) — polling needs no per-request pub/sub connections.
let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) redis = new Redis(REDIS_URL!);
  return redis;
}

const roomKey = (code: string) => `room:${code}`;
/** Set of codes for PUBLIC PvP rooms still waiting for an opponent — the
 *  lobby list. Self-healing: listRooms prunes members whose room is gone,
 *  full, or whose host stopped polling. */
const OPEN_ROOMS_KEY = "rooms:open";
/** Hosts poll while they wait, so a fresh heartbeat means a live lobby. */
const LOBBY_HOST_FRESH_MS = 45_000;

/** Compare-and-set on the doc's version field (same contract as the WS era). */
const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local doc = cjson.decode(cur)
if tostring(doc.version) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

async function loadDoc(code: string): Promise<RoomDoc | null> {
  const raw = await getRedis().get(roomKey(code));
  return raw ? (JSON.parse(raw) as RoomDoc) : null;
}

async function casStore(prevVersion: number, next: RoomDoc): Promise<boolean> {
  next.version = prevVersion + 1;
  const ok = (await getRedis().eval(
    CAS_LUA,
    1,
    roomKey(next.code),
    String(prevVersion),
    JSON.stringify(next),
    String(ROOM_TTL_S),
  )) as number;
  return ok === 1;
}

/** Load → pure step → CAS, retrying the WHOLE step on a lost race. The step
 *  must be pure over the doc (engine calls are), so re-running is safe; steps
 *  that no longer apply return the doc unchanged and we skip the write. */
async function withDoc(
  code: string,
  step: (doc: RoomDoc) => { doc: RoomDoc; error?: string },
): Promise<{ doc: RoomDoc; error?: string } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await loadDoc(code);
    if (!doc) return null;
    const r = step(doc);
    if (r.doc === doc) return r; // nothing changed — no write needed
    if (await casStore(doc.version, r.doc)) return r;
  }
  // Contended beyond reason — surface latest truth without a write.
  const doc = await loadDoc(code);
  return doc ? { doc, error: "Busy — try again" } : null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// No ambiguous glyphs (0/O, 1/I) — codes get read aloud and typed on phones.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRoomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

/** Stamp this seat's heartbeat; cheap no-op when written recently. */
function touchSeat(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  if (now - doc.seatLastSeen[seat] < LASTSEEN_WRITE_THROTTLE_MS) return doc;
  return { ...doc, seatLastSeen: { ...doc.seatLastSeen, [seat]: now } };
}

async function handleJoin(msg: Extract<RoomRequest, { op: "join" }>): Promise<Response> {
  const now = Date.now();
  if (msg.mode === "join") {
    const code = (msg.room ?? "").trim().toUpperCase();
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await loadDoc(code);
      if (!doc) return json({ error: `Room ${code || "?"} not found` }, 404);
      if (doc.seats.p2 !== null) return json({ error: `Room ${code} is already full` }, 409);
      const token = randomUUID();
      let next = startRoom({ ...doc, seats: { ...doc.seats, p2: token } }, now);
      next = tick(next, now);
      if (await casStore(doc.version, next)) {
        await getRedis().srem(OPEN_ROOMS_KEY, code); // room is full — leave the lobby
        const body: RoomJoinResponse = {
          player: "p2",
          room: code,
          vsCpu: next.vsCpu,
          variant: next.variant,
          seatToken: token,
          view: viewFor(next, "p2", 0, now),
        };
        return json(body);
      }
    }
    return json({ error: `Room ${code} is already full` }, 409);
  }

  // create / cpu — mint a fresh room under a unique code (NX write).
  const vsCpu = msg.mode === "cpu";
  const variant = msg.variant === "masterKiller" ? "masterKiller" : "classic";
  const token = randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = newRoomCode();
    let doc = createRoomDoc(code, vsCpu, variant, token, now, msg.unlisted === true);
    doc = tick(doc, now);
    const ok = await getRedis().set(roomKey(code), JSON.stringify(doc), "EX", ROOM_TTL_S, "NX");
    if (ok === "OK") {
      // Public PvP rooms enter the lobby list until someone takes p2.
      if (!vsCpu && !doc.unlisted) await getRedis().sadd(OPEN_ROOMS_KEY, code);
      const body: RoomJoinResponse = {
        player: "p1",
        room: code,
        vsCpu,
        variant,
        seatToken: token,
        view: viewFor(doc, "p1", 0, now),
      };
      return json(body);
    }
  }
  return json({ error: "Could not allocate a room code" }, 500);
}

export async function POST(request: Request): Promise<Response> {
  if (!REDIS_URL) return json({ error: "Server missing REDIS_URL" }, 500);

  let msg: RoomRequest;
  try {
    msg = (await request.json()) as RoomRequest;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    if (msg.op === "join") return await handleJoin(msg);

    if (msg.op === "listRooms") {
      const now = Date.now();
      const codes = await getRedis().smembers(OPEN_ROOMS_KEY);
      const rooms: RoomListResponse["rooms"] = [];
      const stale: string[] = [];
      if (codes.length > 0) {
        const raws = await getRedis().mget(codes.map(roomKey));
        codes.forEach((code, i) => {
          const raw = raws[i];
          if (!raw) return void stale.push(code); // room expired
          const doc = JSON.parse(raw) as RoomDoc;
          const hostFresh = now - doc.seatLastSeen.p1 < LOBBY_HOST_FRESH_MS;
          if (doc.started || doc.seats.p2 !== null || doc.unlisted || !hostFresh) {
            return void stale.push(code);
          }
          rooms.push({
            code,
            variant: doc.variant,
            ageSeconds: Math.max(0, Math.round((now - doc.waitingSince) / 1000)),
          });
        });
        if (stale.length > 0) await getRedis().srem(OPEN_ROOMS_KEY, ...stale);
      }
      rooms.sort((a, b) => a.ageSeconds - b.ageSeconds);
      return json({ rooms: rooms.slice(0, 20) } satisfies RoomListResponse);
    }

    const { room, seat, seatToken } = msg;
    if (!room || !seat || !seatToken) return json({ error: "Missing room/seat/seatToken" }, 400);

    // Authenticate against the seat token stored in the doc.
    const probe = await loadDoc(room);
    if (!probe) return json({ error: "Room not found" }, 404);
    if (probe.seats[seat] !== seatToken) return json({ error: "Bad seat token" }, 403);

    if (msg.op === "poll") {
      const since = msg.since ?? 0;
      const deadline = Date.now() + (msg.wait === false ? 0 : LONG_POLL_CAP_MS);
      for (;;) {
        const now = Date.now();
        const r = await withDoc(room, (doc) => ({ doc: tick(touchSeat(doc, seat, now), now) }));
        if (!r) return json({ error: "Room not found" }, 404);
        // News for this seat (or the hold expired): answer.
        if (r.doc.seq > since || now >= deadline) {
          const view: RoomResponse = { ...viewFor(r.doc, seat, since, now), error: r.error };
          return json(view);
        }
        await new Promise((res) => setTimeout(res, LONG_POLL_STEP_MS));
      }
    }

    // A game action. Tick FIRST so overdue deadlines (a bot's pick, an
    // auto-skip whose window closed) land before the action does — the same
    // order the old wall-clock timers produced.
    const now = Date.now();
    const action = msg as RoomActionInput & { room: string; seat: PlayerId; seatToken: string };
    const r = await withDoc(room, (doc) => {
      const pre = tick(touchSeat(doc, seat, now), now);
      const stepped = applyAction(pre, seat, action, now);
      return { doc: tick(stepped.doc, now), error: stepped.error };
    });
    if (!r) return json({ error: "Room not found" }, 404);
    // Action replies replay past the client's `since` so the actor's own
    // move renders immediately from this response — the poll loop's copy of
    // the same events dedupes against the client's seq gate. Old clients
    // that don't send `since` get the old contract (no replay).
    const actionSince = typeof msg.since === "number" ? msg.since : r.doc.seq;
    const view: RoomResponse = { ...viewFor(r.doc, seat, actionSince, now), error: r.error };
    return json(view);
  } catch (err) {
    console.error("room handler error", err);
    return json({ error: "Server error" }, 500);
  }
}

/** Health probe (and a gentle hint for anyone GETting the endpoint). */
export function GET(): Response {
  return new Response("Regatta room API — POST RoomRequest JSON here.", {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
