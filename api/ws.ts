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
// Master Killer mode — additive only. Everything below is inert in classic
// rooms (variant === "classic" guards every branch that touches it).
import {
  applyBlinkStrike,
  applyBulwark,
  applyCharge as mkApplyCharge,
  applyChargedShot as mkApplyChargedShot,
  applyPowerMove,
  applyPush as mkApplyPush,
  applyReflip as mkApplyReflip,
  applyWarpath,
  breakShieldStreak,
  CHARGE_CAP,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getLegalPowerMoves,
  getPushTargets,
  getWarpathTargets,
  grantZeroFlipCharge,
  initialPowerState,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  type PlayerClass,
  type PowerAction,
  type PowerMove,
  type PowerState,
} from "../master-killer";
import { pickBotPowerAction } from "../master-killer-bot";

export const config = { maxDuration: 300 };

const ROOM_TTL_S = 4 * 60 * 60; // idle rooms evaporate after 4h
const AUTO_SKIP_DELAY_MS = 500;
const BOT_THINK_MS = 900;
/** Master Killer only: a CPU Mage's zero-move rescue check must beat
 *  AUTO_SKIP_DELAY_MS, or the skip always wins the race and Re-flip never
 *  gets a chance to run — deliberately shorter than BOT_THINK_MS. */
const BOT_RESCUE_THINK_MS = 300;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MK_CLASSES: PlayerClass[] = ["archer", "mage", "warrior"];

const REDIS_URL =
  process.env.REDIS_URL ?? process.env.KV_URL ?? process.env.UPSTASH_REDIS_URL;

/** Redis storage round-trips every RoomDoc through JSON.stringify/parse —
 *  and JSON.stringify(new Set(...)) silently produces "{}", losing the
 *  data. PowerState's safeTokens is a Set, so it can NEVER be stored
 *  directly; this is the JSON-safe wire form (a plain array instead),
 *  converted to/from a real PowerState right at the master-killer.ts
 *  call boundary via toWirePower()/fromWirePower() below. */
type WirePowerState = Omit<PowerState, "safeTokens"> & { safeTokens: number[] };

function toWirePower(p: PowerState): WirePowerState {
  return { ...p, safeTokens: [...p.safeTokens] };
}
function fromWirePower(w: WirePowerState): PowerState {
  return { ...w, safeTokens: new Set(w.safeTokens) };
}

interface RoomDoc {
  code: string;
  vsCpu: boolean;
  seats: { p1: string | null; p2: string | null }; // seat tokens ("BOT" for cpu p2)
  started: boolean;
  /** Every match opens with a flip-off (higher count moves first, ties
   *  re-flip). No turns happen until phase flips to "play". Master Killer
   *  rooms insert "classPick" before "opening". */
  phase: "classPick" | "opening" | "play";
  openingFlips: { p1: number | null; p2: number | null };
  state: GameState;
  currentFlip: number | null;
  turns: number;
  captures: { p1: number; p2: number };
  lastMove: Move | PowerMove | null;
  lastMovePlayer: PlayerId | null;
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
  version: number;

  // ---- Master Killer mode only (null/unused in classic rooms) ----------
  variant: "classic" | "masterKiller";
  mk: WirePowerState | null;
  classesPicked: { p1: boolean; p2: boolean };
  currentPowerMoves: PowerMove[] | null;
  /** Push doesn't produce a Move-shaped lastMove — its own "how did we get
   *  here" slot, same lifecycle as lastMove/lastMovePlayer. */
  lastPush: { targetTokenId: number } | null;
  /** Charged Shot doesn't produce a Move-shaped lastMove either — own "how
   *  did we get here" slot, same lifecycle as lastPush. */
  lastChargedShot: { targetTokenId: number } | null;
  /** Net charge change for one player from whatever this broadcast is
   *  reporting — a real before/after diff, never re-derived client-side. */
  lastChargeEvent: { player: PlayerId; delta: number } | null;
  /** Bridges a zero-flip's charge grant (dealt in commitTurnFlip) to the
   *  auto-skip broadcast that announces it — the two are separate RoomDoc
   *  commits, and the announcement fields get cleared between them, so this
   *  can't just be lastChargeEvent itself. Persisted (not an in-memory
   *  field) since this architecture round-trips RoomDoc through Redis. */
  zeroFlipChargeBefore: number | null;
  /** Archer's Rain of Arrows ultimate — non-null exactly on the broadcast
   *  where a 3rd consecutive shield landing resolved. targetTokenId is null
   *  when it fired into an empty eligible pool (streak still consumed).
   *  Same lifecycle as lastPush. */
  lastRainOfArrows: { targetTokenId: number | null } | null;
  /** Mage's Blink Strike or Warrior's Warpath — non-null exactly on the
   *  broadcast where one of those resolved. Same lifecycle as lastPush. */
  lastUltimate: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
  /** Warrior's Bulwark was just CAST — same lifecycle as lastPush. */
  lastBulwark: { tokenId: number } | null;
  /** Bulwark actually BLOCKED one or more captures this commit — set by
   *  tickBulwarkForNewTurn/tickBulwarkForReflip, independent of
   *  lastMovePlayer (see protocol.ts's lastBulwarkBlock doc). */
  lastBulwarkBlock: { tokenIds: number[] } | null;
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

function freshMatchFields(
  variant: "classic" | "masterKiller",
): Pick<
  RoomDoc,
  | "phase" | "openingFlips"
  | "state" | "currentFlip" | "turns" | "captures"
  | "lastMove" | "lastMovePlayer" | "wasSkipped" | "skippedPlayer" | "skipReason"
  | "mk" | "classesPicked" | "currentPowerMoves" | "lastPush" | "lastChargedShot" | "lastChargeEvent"
  | "zeroFlipChargeBefore" | "lastRainOfArrows" | "lastUltimate" | "lastBulwark" | "lastBulwarkBlock"
> {
  // currentPlayer is decided by the opening flip-off, not randomized here.
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
    lastChargedShot: null,
    lastChargeEvent: null,
    zeroFlipChargeBefore: null,
    lastRainOfArrows: null,
    lastUltimate: null,
    lastBulwark: null,
    lastBulwarkBlock: null,
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
    /** Last phase this connection rendered — the opening->play transition
     *  (and classPick->opening->play, in Master Killer rooms) is where the
     *  "X goes first" reveal gets sent, exactly once. */
    let prevPhase: "classPick" | "opening" | "play" | null = null;
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

    /** Run `fn` after `ms` — but only if the room doc hasn't moved on since
     *  `doc` (version check on reload). Multiple connections can schedule
     *  the same action; the CAS in commit() lets exactly one land. */
    const scheduleVersioned = (
      doc: RoomDoc,
      ms: number,
      fn: (cur: RoomDoc) => Promise<void>,
    ) => {
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

    /** Derive and send THIS seat's view of a doc. */
    const sendStateView = (doc: RoomDoc) => {
      if (!mySeat || !doc.started) return;

      // Master Killer: class pick comes before anything else.
      if (doc.phase === "classPick" && doc.mk) {
        prevPhase = "classPick";
        send({
          type: "classPick",
          classes: {
            p1: doc.classesPicked.p1 ? doc.mk.classes.p1 : null,
            p2: doc.classesPicked.p2 ? doc.mk.classes.p2 : null,
          },
          ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu),
        });
        return;
      }

      // Opening flip-off: send the opening view instead of a game state.
      // The tie flag is derivable (both set + equal); the "first" reveal is
      // the opening->play transition, tracked per connection via prevPhase.
      if (doc.phase === "opening") {
        prevPhase = "opening";
        const { p1, p2 } = doc.openingFlips;
        send({
          type: "opening",
          flips: { ...doc.openingFlips },
          first: null,
          tie: p1 !== null && p2 !== null && p1 === p2,
        });
        return;
      }
      if (prevPhase === "opening" || prevPhase === "classPick") {
        // Just resolved — announce who moves first before normal flow.
        prevPhase = "play";
        send({
          type: "opening",
          flips: { ...doc.openingFlips },
          first: doc.state.currentPlayer,
          tie: false,
        });
      }
      // A doc without a winner means a fresh match — re-arm gameOver delivery.
      if (doc.state.winner === null) lastAnnouncedWinner = null;

      const legalMoves =
        doc.variant === "classic" && doc.currentFlip !== null && doc.state.currentPlayer === mySeat
          ? getLegalMoves(doc.state, doc.currentFlip)
          : null;
      const powerMoves =
        doc.variant === "masterKiller" && doc.state.currentPlayer === mySeat
          ? doc.currentPowerMoves
          : null;
      const power = doc.mk
        ? {
            classes: { ...doc.mk.classes },
            charges: { ...doc.mk.charges },
            safeTokens: [...doc.mk.safeTokens],
            pushTargets:
              doc.mk.classes[doc.state.currentPlayer] === "archer"
                ? getPushTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer)
                : [],
            // No charges===CHARGE_CAP check needed here — getChargedShotTargets
            // self-gates on that now (see its doc comment), so the class
            // check is the only thing this ternary needs, same shape as
            // pushTargets.
            chargedShotTargets:
              doc.mk.classes[doc.state.currentPlayer] === "archer"
                ? getChargedShotTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer)
                : [],
            ultimateReady: { ...doc.mk.ultimateReady },
            blinkStrikeTargets:
              doc.mk.classes[doc.state.currentPlayer] === "mage" && doc.mk.ultimateReady[doc.state.currentPlayer]
                ? getBlinkStrikeTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer)
                : [],
            warpathTargets:
              doc.mk.classes[doc.state.currentPlayer] === "warrior" && doc.mk.ultimateReady[doc.state.currentPlayer]
                ? getWarpathTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer)
                : [],
            bulwarkTargets:
              doc.mk.classes[doc.state.currentPlayer] === "warrior" && doc.mk.charges[doc.state.currentPlayer] >= 1
                ? getBulwarkTargets(doc.state, fromWirePower(doc.mk), doc.state.currentPlayer)
                : [],
            bulwarkedTokenIds: Object.keys(doc.mk.bulwarked).map(Number),
          }
        : undefined;

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
        lastChargedShot: doc.lastChargedShot,
        lastBulwark: doc.lastBulwark,
        lastBulwarkBlock: doc.lastBulwarkBlock,
        lastChargeEvent: doc.lastChargeEvent,
        lastRainOfArrows: doc.lastRainOfArrows,
        lastUltimate: doc.lastUltimate,
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

    /** Master Killer class-pick transitions. Same self-healing shape as
     *  maybeDriveOpening below — any connection can resolve, CAS serializes
     *  racers, rejoins re-evaluate for free. */
    const maybeDriveClassPick = async (doc: RoomDoc): Promise<void> => {
      if (!mySeat || !doc.started || doc.phase !== "classPick" || !doc.mk) return;

      // CPU rooms: the human's connection auto-picks a class for the bot.
      if (doc.vsCpu && !doc.classesPicked.p2 && mySeat === "p1") {
        scheduleVersioned(doc, BOT_THINK_MS, async (cur) => {
          if (cur.phase !== "classPick" || cur.classesPicked.p2 || !cur.mk) return;
          const cls = MK_CLASSES[Math.floor(Math.random() * MK_CLASSES.length)];
          await commit({
            ...cur,
            mk: { ...cur.mk, classes: { ...cur.mk.classes, p2: cls } },
            classesPicked: { ...cur.classesPicked, p2: true },
          });
        });
      }

      if (!doc.classesPicked.p1 || (!doc.classesPicked.p2 && !doc.vsCpu)) return;

      console.log(`[${doc.code}] classes: p1=${doc.mk.classes.p1} p2=${doc.mk.classes.p2}`);
      const next: RoomDoc = { ...doc, phase: "opening" };
      if (await commit(next)) await maybeDriveOpening(next);
      else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDriveClassPick(reloaded);
      }
    };

    /** Opening flip-off transitions. Any connection can resolve; the CAS in
     *  commit() serializes racers, and rejoins re-evaluate — self-healing. */
    const maybeDriveOpening = async (doc: RoomDoc): Promise<void> => {
      if (!mySeat || !doc.started || doc.phase !== "opening") return;
      const { p1, p2 } = doc.openingFlips;

      // CPU rooms: the human's connection flips for the bot after a beat.
      if (doc.vsCpu && p2 === null && mySeat === "p1") {
        scheduleVersioned(doc, BOT_THINK_MS, async (cur) => {
          if (cur.phase !== "opening" || cur.openingFlips.p2 !== null) return;
          await commit({
            ...cur,
            openingFlips: { ...cur.openingFlips, p2: flipCoins() },
          });
        });
      }

      if (p1 === null || p2 === null) return;

      if (p1 === p2) {
        // Tie: leave the tying doc visible for the animation beat, then
        // clear both flips to re-arm.
        scheduleVersioned(doc, 1600, async (cur) => {
          if (cur.phase !== "opening") return;
          await commit({ ...cur, openingFlips: { p1: null, p2: null } });
        });
        return;
      }

      const first: PlayerId = p1 > p2 ? "p1" : "p2";
      console.log(`[${doc.code}] opening: p1=${p1} p2=${p2} — ${first} first`);
      const next: RoomDoc = {
        ...doc,
        phase: "play",
        state: { ...doc.state, currentPlayer: first },
      };
      if (await commit(next)) await maybeDrive(next);
    };

    /** Advance the room if it's stalled on something we're responsible for. */
    const maybeDrive = async (doc: RoomDoc): Promise<void> => {
      if (!doc.started || doc.phase !== "play" || doc.state.winner || !iDrive(doc)) return;

      // Needs a coin flip to start the turn.
      if (doc.currentFlip === null) {
        const commitTurnFlip = async (cur: RoomDoc) => {
          const flip = flipCoins();
          let mk = cur.mk;
          let currentPowerMoves: PowerMove[] | null = null;
          let zeroFlipChargeBefore: number | null = null;
          let lastBulwarkBlock: RoomDoc["lastBulwarkBlock"] = null;
          if (cur.variant === "masterKiller" && mk) {
            let power = fromWirePower(mk);
            if (flip === 0) {
              // Stash the pre-grant count — the auto-skip commit (if this
              // flip has no legal action) picks it up to show "+1 charge"
              // alongside "flipped 0 — skip" as ONE message.
              zeroFlipChargeBefore = power.charges[cur.state.currentPlayer];
              power = grantZeroFlipCharge(power, cur.state.currentPlayer);
            }
            currentPowerMoves = getLegalPowerMoves(cur.state, power, flip);
            // Warrior Bulwark: tick the mover's own countdown, and consume
            // any Bulwark this exact flip's moves reveal as blocked for the
            // opponent (announced on THIS commit, before the mover has even
            // chosen an action — see tickBulwarkForNewTurn's doc comment).
            const bulwarkResult = tickBulwarkForNewTurn(cur.state, power, flip);
            power = bulwarkResult.power;
            if (bulwarkResult.blockedIds.length > 0) lastBulwarkBlock = { tokenIds: bulwarkResult.blockedIds };
            mk = toWirePower(power);
          }
          const next: RoomDoc = {
            ...cur,
            currentFlip: flip,
            mk,
            currentPowerMoves,
            turns: cur.turns + 1,
            // A fresh flip consumes the previous announcement.
            lastMove: null,
            lastMovePlayer: null,
            lastPush: null,
            lastChargedShot: null,
            lastBulwark: null,
            lastBulwarkBlock,
            lastChargeEvent: null,
            lastRainOfArrows: null,
            lastUltimate: null,
            wasSkipped: false,
            skippedPlayer: null,
            skipReason: null,
            zeroFlipChargeBefore,
          };
          if (await commit(next)) await maybeDrive(next);
          else {
            const reloaded = await loadDoc(cur.code);
            if (reloaded) await maybeDrive(reloaded);
          }
        };
        if (doc.turns === 0) {
          // First turn after the flip-off: let the "goes first" reveal land.
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

      const moves =
        doc.variant === "masterKiller" ? (doc.currentPowerMoves ?? []) : getLegalMoves(doc.state, doc.currentFlip);
      const isBotTurn = doc.vsCpu && doc.state.currentPlayer === "p2";

      // Master Killer CPU turn: always get a chance to act, even with zero
      // moves — a Mage bot might rescue via Re-flip. Scheduled FASTER than
      // AUTO_SKIP_DELAY_MS below so it always gets first crack (whichever
      // commits first bumps the version, which the other's check catches).
      if (isBotTurn && doc.variant === "masterKiller" && moves.length === 0) {
        const versionAtSchedule = doc.version;
        scheduleVersioned(doc, BOT_RESCUE_THINK_MS, async (cur) => {
          if (cur.version !== versionAtSchedule || !cur.mk || cur.currentFlip === null) return;
          if (cur.state.currentPlayer !== "p2") return;
          const power = fromWirePower(cur.mk);
          const action = pickBotPowerAction(cur.state, power, cur.currentPowerMoves ?? [], cur.currentFlip, Math.random);
          if (action) await applyBotPowerAction(cur, "p2", action);
          // action === null: nothing to do — the auto-skip below handles it.
        });
      }

      // No legal move: auto-skip after a beat so clients can show the flip.
      if (moves.length === 0) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return; // superseded
          const skipped = cur.state.currentPlayer;
          const skipReason = cur.currentFlip === 0 ? "flip-zero" : "no-legal-move";
          let lastChargeEvent: RoomDoc["lastChargeEvent"] = null;
          if (skipReason === "flip-zero" && cur.mk && cur.zeroFlipChargeBefore !== null) {
            const delta = cur.mk.charges[skipped] - cur.zeroFlipChargeBefore;
            lastChargeEvent = delta !== 0 ? { player: skipped, delta } : null;
          }
          // applyNoMove only touches GameState — the turn is genuinely
          // ending here without a shield landing, so the shield-streak
          // combo breaks.
          const mk = cur.mk ? toWirePower(breakShieldStreak(fromWirePower(cur.mk), skipped)) : cur.mk;
          const next: RoomDoc = {
            ...cur,
            state: applyNoMove(cur.state),
            mk,
            currentFlip: null,
            currentPowerMoves: null,
            wasSkipped: true,
            skippedPlayer: skipped,
            skipReason,
            lastChargeEvent,
            // The flip commit's own broadcast already showed a Bulwark-block
            // announcement (if any) — don't repeat it on the skip broadcast
            // too (referee.ts's equivalent already clears these via
            // clearAnnouncement() before its auto-skip timer fires).
            lastBulwark: null,
            lastBulwarkBlock: null,
            zeroFlipChargeBefore: null,
          };
          if (await commit(next)) await maybeDrive(next);
        }, AUTO_SKIP_DELAY_MS);
        return;
      }

      // Bot's turn, and there's something on the table: think, then act.
      if (isBotTurn) {
        const versionAtSchedule = doc.version;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(async () => {
          const cur = await loadDoc(doc.code);
          if (!cur || cur.version !== versionAtSchedule) return;
          if (cur.currentFlip === null || cur.state.currentPlayer !== "p2") return;

          if (cur.variant === "masterKiller" && cur.mk) {
            const power = fromWirePower(cur.mk);
            const botMoves = cur.currentPowerMoves ?? [];
            const action = pickBotPowerAction(cur.state, power, botMoves, cur.currentFlip, Math.random);
            if (action) await applyBotPowerAction(cur, "p2", action);
            return;
          }
          const botMoves = getLegalMoves(cur.state, cur.currentFlip);
          if (botMoves.length === 0) return;
          await applyChosenMove(cur, "p2", pickBotMove(cur.state, botMoves));
        }, BOT_THINK_MS);
        return;
      }
      // Otherwise: our own human turn — wait for the client's chooseMove/usePower.
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

    // ---- Master Killer: turn-ending actions (shared by human + CPU paths) -

    const applyMasterKillerMove = async (
      doc: RoomDoc,
      seat: PlayerId,
      move: PowerMove,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyPowerMove(doc.state, fromWirePower(doc.mk), move, seat, Math.random);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
      const captureCount = move.captures.length + move.bonusCaptures.length + rainHit;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + captureCount },
        lastMove: move,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: null,
        lastChargedShot: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: r.rainOfArrows,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(
          `[${doc.code}] [MOVE] ${seat} tok${move.tokenId} ${move.from}->${move.to} caps=${captureCount} snipe=${move.bonusCaptures.length > 0} win=${move.causesWin} rainOfArrows=${rainHit === 1}`,
        );
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const applyMasterKillerCharge = async (
      doc: RoomDoc,
      seat: PlayerId,
      move: PowerMove,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = mkApplyCharge(doc.state, fromWirePower(doc.mk), move, seat, Math.random);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
      const captureCount = move.captures.length + move.bonusCaptures.length + move.chargeSweepCaptures.length + rainHit;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + captureCount },
        lastMove: move,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: null,
        lastChargedShot: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: r.rainOfArrows,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [CHARGE] ${seat} tok${move.tokenId} ${move.from}->${move.to} caps=${captureCount} win=${move.causesWin}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const applyMasterKillerPush = async (
      doc: RoomDoc,
      seat: PlayerId,
      targetTokenId: number,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = mkApplyPush(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        lastMove: null,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: { targetTokenId },
        lastChargedShot: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [PUSH] ${seat} -> tok${targetTokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    /** Archer's Charged Shot: spends both charges for a flat, fixed
     *  knockback against any legal target (a Warded target is fully immune —
     *  see getChargedShotTargets/applyChargedShot). Doesn't produce a
     *  Move-shaped lastMove — its own "how did we get here" slot, same
     *  lifecycle as lastPush. */
    const applyMasterKillerChargedShot = async (
      doc: RoomDoc,
      seat: PlayerId,
      targetTokenId: number,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = mkApplyChargedShot(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        lastMove: null,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: null,
        lastChargedShot: { targetTokenId },
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [CHARGED SHOT] ${seat} -> tok${targetTokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const applyMasterKillerBlinkStrike = async (
      doc: RoomDoc,
      seat: PlayerId,
      targetTokenId: number,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyBlinkStrike(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + 1 + r.sweptTokenIds.length },
        lastMove: null,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: null,
        lastChargedShot: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: { kind: "blinkStrike", targetTokenId, sweptTokenIds: r.sweptTokenIds },
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [BLINK STRIKE] ${seat} -> tok${targetTokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const applyMasterKillerWarpath = async (
      doc: RoomDoc,
      seat: PlayerId,
      targetTokenId: number,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyWarpath(doc.state, fromWirePower(doc.mk), targetTokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + 1 + r.sweptTokenIds.length },
        lastMove: null,
        lastMovePlayer: seat,
        lastBulwark: null,
        lastBulwarkBlock: null,
        lastPush: null,
        lastChargedShot: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: { kind: "warpath", targetTokenId, sweptTokenIds: r.sweptTokenIds },
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [WARPATH] ${seat} -> tok${targetTokenId} swept=${r.sweptTokenIds.length}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    /** Warrior's Bulwark: flags one of the mover's own on-board tokens
     *  Bulwarked (see applyBulwark). Doesn't produce a Move-shaped
     *  lastMove — its own "how did we get here" slot, same lifecycle as
     *  lastPush. */
    const applyMasterKillerBulwark = async (
      doc: RoomDoc,
      seat: PlayerId,
      tokenId: number,
    ): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      const r = applyBulwark(doc.state, fromWirePower(doc.mk), tokenId, seat);
      const chargeDelta = r.power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        state: r.state,
        mk: toWirePower(r.power),
        currentFlip: null,
        currentPowerMoves: null,
        lastMove: null,
        lastMovePlayer: seat,
        lastPush: null,
        lastChargedShot: null,
        lastBulwark: { tokenId },
        lastBulwarkBlock: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
        lastRainOfArrows: null,
        lastUltimate: null,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] [BULWARK] ${seat} -> tok${tokenId}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    /** Re-flip does NOT end the turn — it replaces the flip and re-commits,
     *  same player still to act. maybeDrive() re-derives from the fresh
     *  currentPowerMoves, so it naturally re-arms the auto-skip timer if the
     *  new flip is still a dead end. */
    const applyMasterKillerReflip = async (doc: RoomDoc, seat: PlayerId): Promise<void> => {
      if (!doc.mk) return;
      const chargesBefore = doc.mk.charges[seat];
      let power = mkApplyReflip(fromWirePower(doc.mk), seat);
      const flip = flipCoins();
      // A re-rolled zero also grants a charge, right here in the same
      // synchronous step — report the NET delta across both the spend and
      // the possible grant, since only one lastChargeEvent field exists.
      if (flip === 0) power = grantZeroFlipCharge(power, seat);
      // Bulwark: this is a fresh flip within the SAME turn (not a new turn —
      // no expiry tick, see tickBulwarkForReflip), but it can reveal a
      // fresh block the original flip didn't.
      const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
      power = bulwarkResult.power;
      const lastBulwarkBlock: RoomDoc["lastBulwarkBlock"] =
        bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null;
      const chargeDelta = power.charges[seat] - chargesBefore;
      const next: RoomDoc = {
        ...doc,
        mk: toWirePower(power),
        currentFlip: flip,
        currentPowerMoves: getLegalPowerMoves(doc.state, power, flip),
        lastMove: null,
        lastPush: null,
        lastChargedShot: null,
        lastBulwark: null,
        lastBulwarkBlock,
        lastRainOfArrows: null,
        lastUltimate: null,
        lastChargeEvent: chargeDelta !== 0 ? { player: seat, delta: chargeDelta } : null,
      };
      if (await commit(next)) {
        console.log(`[${doc.code}] ${seat} re-flipped -> ${flip}`);
        await maybeDrive(next);
      } else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDrive(reloaded);
      }
    };

    const applyBotPowerAction = async (
      doc: RoomDoc,
      seat: PlayerId,
      action: PowerAction,
    ): Promise<void> => {
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
        case "chargedShot":
          await applyMasterKillerChargedShot(doc, seat, action.targetTokenId);
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
        case "bulwark":
          await applyMasterKillerBulwark(doc, seat, action.tokenId);
          break;
      }
    };

    const handlePickClass = async (
      doc: RoomDoc,
      seat: PlayerId,
      cls: PlayerClass,
    ): Promise<void> => {
      if (doc.phase !== "classPick" || !doc.mk || doc.classesPicked[seat]) return;
      const next: RoomDoc = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, [seat]: cls } },
        classesPicked: { ...doc.classesPicked, [seat]: true },
      };
      if (await commit(next)) await maybeDriveClassPick(next);
      else {
        const reloaded = await loadDoc(doc.code);
        if (reloaded) await maybeDriveClassPick(reloaded);
      }
    };

    const handleUsePower = async (
      doc: RoomDoc,
      seat: PlayerId,
      action: Extract<ClientMessage, { type: "usePower" }>["action"],
    ): Promise<void> => {
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

      if (action.kind === "chargedShot") {
        if (cls !== "archer") return send({ type: "error", message: "Only an Archer can Charged Shot" });
        if (doc.mk.charges[seat] !== CHARGE_CAP) {
          return send({ type: "error", message: "Charged Shot needs a full charge bank" });
        }
        if (!getChargedShotTargets(doc.state, fromWirePower(doc.mk), seat).includes(action.targetTokenId)) {
          return send({ type: "error", message: "Invalid Charged Shot target" });
        }
        await applyMasterKillerChargedShot(doc, seat, action.targetTokenId);
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

      if (action.kind === "bulwark") {
        if (cls !== "warrior") return send({ type: "error", message: "Only a Warrior can Bulwark" });
        if (doc.mk.charges[seat] < 1) return send({ type: "error", message: "No charge available" });
        if (!getBulwarkTargets(doc.state, fromWirePower(doc.mk), seat).includes(action.tokenId)) {
          return send({ type: "error", message: "Invalid Bulwark target" });
        }
        await applyMasterKillerBulwark(doc, seat, action.tokenId);
        return;
      }

      // charge
      if (cls !== "warrior") return send({ type: "error", message: "Only a Warrior can Charge" });
      if (doc.mk.charges[seat] < 1) return send({ type: "error", message: "No charge available" });
      if (!doc.currentPowerMoves || action.moveIndex < 0 || action.moveIndex >= doc.currentPowerMoves.length) {
        return send({ type: "error", message: "Invalid move index" });
      }
      const move = doc.currentPowerMoves[action.moveIndex];
      if (!move.chargeAvailable) return send({ type: "error", message: "Charge not available for that move" });
      await applyMasterKillerCharge(doc, seat, move);
    };

    const subscribeToRoom = async (code: string) => {
      await sub.subscribe(roomChannel(code));
      sub.on("message", async (_channel, payload) => {
        const doc = JSON.parse(payload) as RoomDoc;
        sendStateView(doc);
        await maybeDriveClassPick(doc);
        await maybeDriveOpening(doc);
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
        variant: doc.variant,
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
        // Room just filled — Master Killer rooms start with class pick,
        // classic rooms go straight into the flip-off. Both no-op if the
        // doc's phase doesn't match, so it's safe to call both.
        await maybeDriveClassPick(next);
        await maybeDriveOpening(next);
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
        const variant: "classic" | "masterKiller" = msg.variant === "masterKiller" ? "masterKiller" : "classic";
        const doc: RoomDoc = {
          code,
          vsCpu: msg.mode === "cpu",
          seats: { p1: token, p2: msg.mode === "cpu" ? "BOT" : null },
          started: msg.mode === "cpu",
          variant,
          ...freshMatchFields(variant),
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
          if (doc.started) {
            // CPU room: creation doesn't publish, so paint the opening
            // prompt directly and arm the bot's class pick / opening flip.
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
      // Resume anything that stalled while we were away (any phase).
      await maybeDriveClassPick(doc);
      await maybeDriveOpening(doc);
      await maybeDrive(doc);
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
        } else if (msg.type === "openingFlip") {
          const doc = await loadDoc(myRoom);
          if (!doc || doc.phase !== "opening" || doc.openingFlips[mySeat] !== null) {
            return; // out of phase or already flipped — silently ignore
          }
          const next: RoomDoc = {
            ...doc,
            openingFlips: { ...doc.openingFlips, [mySeat]: flipCoins() },
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
          const next: RoomDoc = { ...doc, ...freshMatchFields(doc.variant) };
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
      redis.quit().catch(() => {});
      sub.quit().catch(() => {});
    });
  });
}
