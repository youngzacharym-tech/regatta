// ============================================================================
// protocol.ts — message shapes shared by Referee (server) and Stage (client).
//
// Both sides import from here so wire messages can't drift.
// ============================================================================

import type { GameState, Move, PlayerId } from "./rulebook";
// Master Killer mode's message shapes below are ADDITIVE ONLY — every field
// they touch on existing message types is optional and populated only in
// masterKiller rooms. Classic-mode broadcasts are byte-identical to before.
import type { PlayerClass, PowerMove } from "./master-killer";

/** One line of in-match chat. `seat` is the sender's protocol seat (the
 *  client maps it to "You"/"Opponent"); `text` is already trimmed and
 *  length-capped server-side. */
export interface ChatMsg {
  seat: PlayerId;
  text: string;
}

// ============================================================================
// HTTP-POLLING TRANSPORT (the current wire protocol)
//
// One POST endpoint (/api/room). The client polls with `op:"poll"` (long-poll:
// the server holds until something new lands or a ~20s cap) and sends actions
// as their own ops. RoomActionInput and RoomView are defined next to the
// engine that produces them — see room-engine.ts.
//
// The WebSocket ServerMessage/ClientMessage types below this block are the
// LEGACY protocol, kept only until the old transports are deleted.
// ============================================================================

import type { RoomActionInput, RoomView } from "./room-engine";

export type RoomRequest =
  | {
      /** Take a seat: create/join/cpu. Replies with RoomJoinResponse. */
      op: "join";
      mode: "cpu" | "create" | "join";
      /** Room code, required for mode "join". */
      room?: string;
      /** Ruleset for a NEW room; ignored for mode "join". */
      variant?: "classic" | "masterKiller";
      /** Create a PRIVATE room: joinable by code, hidden from the lobby. */
      unlisted?: boolean;
      /** CPU opponent strength for mode "cpu"; ignored otherwise. ADDITIVE:
       *  the server whitelists it and treats absent/garbage as "standard"
       *  (the pre-difficulty behavior). Fixed for the room's lifetime at
       *  creation — never changeable mid-game. */
      difficulty?: "easy" | "standard" | "hard";
    }
  | {
      /** Browse open PvP rooms (no seat required). Replies with
       *  RoomListResponse. */
      op: "listRooms";
    }
  | ({
      room: string;
      seat: PlayerId;
      seatToken: string;
    } & (
      | {
          op: "poll";
          /** Highest event seq the client has fully rendered. */
          since: number;
          /** True = long-poll (server holds until news or its cap). */
          wait?: boolean;
        }
      | (RoomActionInput & {
          /** Same meaning as poll's `since`. When present, the action reply
           *  carries the replay window past it, so the actor renders their
           *  own move from the reply instead of waiting out the poll loop's
           *  next re-check (the tap-to-response lag). The client's seq gate
           *  keeps replay exactly-once when the poll answers too. Omitted
           *  (old clients): reply carries no events, poll delivers them. */
          since?: number;
        })
    ));

export interface RoomJoinResponse {
  player: PlayerId;
  room: string;
  vsCpu: boolean;
  variant: "classic" | "masterKiller";
  seatToken: string;
  view: RoomView;
}

/** Poll/action replies are the seat's current RoomView; action rejections
 *  carry `error` alongside the authoritative view so the client re-syncs. */
export type RoomResponse = RoomView & { error?: string };

/** One open room in the public lobby list. */
export interface LobbyRoom {
  code: string;
  variant: "classic" | "masterKiller";
  /** Seconds the host has been waiting for an opponent. */
  ageSeconds: number;
}

export interface RoomListResponse {
  rooms: LobbyRoom[];
}

/** Server -> Client */
export type ServerMessage =
  | {
      /** Sent once the client has been seated in a room. */
      type: "role";
      player: PlayerId;
      /** Room code — share it (or a ?room=CODE link) to invite an opponent. */
      room: string;
      /** True when the opponent is the server-side bot. */
      vsCpu: boolean;
      /** Secret for this seat. Hosted WebSocket connections have a maximum
       *  lifetime, so clients reconnect and present this to resume their
       *  seat mid-game. */
      seatToken: string;
      /** Which ruleset this room plays. Classic omits this in spirit (it's
       *  always "classic" there) — clients branch their whole UI flow on it. */
      variant: "classic" | "masterKiller";
    }
  | {
      type: "waiting";
      reason: string;
    }
  | {
      /** Master Killer mode only: both players pick a class before the
       *  opening flip-off. Broadcast whenever a pick changes; `ready` flips
       *  true once both are set, at which point the normal opening flow
       *  (the existing "opening" message) takes over. */
      type: "classPick";
      classes: { p1: PlayerClass | null; p2: PlayerClass | null };
      ready: boolean;
    }
  | {
      /** The human opponent disconnected; the room is dissolved. The client
       *  should return to the mode menu. */
      type: "opponentLeft";
    }
  | {
      /** Opening flip-off: both players flip their coins, higher count moves
       *  first, ties re-flip. Broadcast whenever the opening state changes:
       *  prompt (both null), one side landed, tie (flips shown, then reset),
       *  or resolved (`first` set — normal state flow follows). */
      type: "opening";
      flips: { p1: number | null; p2: number | null };
      first: PlayerId | null;
      tie: boolean;
    }
  | {
      /** Broadcast after every state transition. Contains everything a client
       *  needs to render + decide. `legalMoves` is only populated for the
       *  current player; the opponent gets `null` so they can't cheat.
       *
       *  `lastMove` and `wasSkipped` describe how we got to this state — used
       *  by clients to show on-screen announcements ("Red got a shield —
       *  extra turn", "Blue's turn skipped", etc.) so the game feels
       *  transparent instead of just changing whose turn it is silently. */
      type: "state";
      state: GameState;
      flip: number | null;
      legalMoves: Move[] | null;
      /** Master Killer moves/Charges are broadcast here too — PowerMove is a
       *  structural superset of Move, so this is really `Move | PowerMove`
       *  at runtime for those rooms (see referee.ts's own comment on this). */
      lastMove: Move | PowerMove | null;
      lastMovePlayer: PlayerId | null;
      wasSkipped: boolean;
      skippedPlayer: PlayerId | null;
      skipReason: "flip-zero" | "no-legal-move" | null;
      /** Master Killer mode only. `powerMoves` mirrors `legalMoves`'
       *  security rule — populated only for the current player, so power
       *  info (chargeAvailable, sweep previews) can't leak to the opponent.
       *  `power` (classes/charges/safety/valid Push targets) is visible to
       *  both — it's public table-state, same as knowing whose turn it is. */
      powerMoves?: PowerMove[] | null;
      power?: {
        classes: Record<PlayerId, PlayerClass>;
        charges: Record<PlayerId, number>;
        /** Valid Push targets for the CURRENT player, if they're an Archer
         *  with a charge and it's their turn — empty otherwise. */
        pushTargets: number[];
        /** Valid Charged Shot targets for the CURRENT player, if they're an
         *  Archer at the full charge cap (this ability spends both) and
         *  it's their turn — empty otherwise. */
        chargedShotTargets: number[];
        /** True once a Mage/Warrior has completed the shield-streak combo
         *  and can spend their ultimate — public table-state, same
         *  visibility as charges (an opponent seeing "ultimate ready" is no
         *  different from them seeing a charge count). */
        ultimateReady: Record<PlayerId, boolean>;
        /** Valid Blink Strike targets for the CURRENT player, if they're a
         *  Mage with ultimateReady and it's their turn — empty otherwise. */
        blinkStrikeTargets: number[];
        /** Valid Warpath targets for the CURRENT player, if they're a
         *  Warrior with ultimateReady and it's their turn — empty otherwise. */
        warpathTargets: number[];
        /** Valid Bulwark targets for the CURRENT player, if they're a
         *  Warrior with a charge and it's their turn — empty otherwise. */
        bulwarkTargets: number[];
        /** Every currently-Bulwarked token id, across both players — public
         *  table-state (drives the client's tint, same idea as isWarded). */
        bulwarkedTokenIds: number[];
        /** Necromancer rework (2026-07-19): each player's banked corpse —
         *  the last enemy token they killed and the contested tile it died
         *  on — broadcast only while still raisable (its token waiting in
         *  reserve). Public table-state: the corpse decal is a threat BOTH
         *  seats need to see (the victim's re-entry denial play depends on
         *  knowing it's there). */
        corpse?: Record<PlayerId, { tokenId: number; tile: number } | null>;
        /** The active possession, if any: which token serves which player
         *  and for how many more of the possessor's turns — drives the
         *  possession treatment on the token and the plates' lifecycle
         *  readouts. */
        thrall?: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
        /** Where a Revive would spawn the thrall for the CURRENT player
         *  right now, or null when Revive isn't castable (no corpse, corpse
         *  denied, thrall already up, or soul bank short). THE client-side
         *  gem gate — server-validated against the same shared oracle. */
        reviveSpawnTile?: number | null;
        /** Corpse Explosion's victim list for the CURRENT player (empty =
         *  not castable) — the dock gate and blast preview. */
        corpseExplosionTargets?: number[];
        /** Valid Exhume targets (the opponent's ESCAPED token ids) for the
         *  CURRENT player, if they're a Necromancer with ultimateReady and
         *  it's their turn — empty otherwise. */
        exhumeTargets?: number[];
      };
      /** Master Killer mode only: Push doesn't produce a Move-shaped object
       *  (no token of the pusher's own moves), so it gets its own "how did
       *  we get here" field, same idea as lastMove/lastMovePlayer. The
       *  client looks up the target's resulting position in `state.tokens`
       *  itself to tell a partial shove from a send-home. */
      lastPush?: { targetTokenId: number } | null;
      /** Master Killer mode only: Archer's Charged Shot doesn't produce a
       *  Move-shaped object either — same "how did we get here" lifecycle as
       *  lastPush, its own field since a Charged Shot and a Push are
       *  mutually exclusive, distinct actions in the same turn. */
      lastChargedShot?: { targetTokenId: number } | null;
      /** Master Killer mode only: Warrior's Bulwark was just CAST this
       *  broadcast — same "how did we get here" lifecycle as lastPush
       *  (mirrors lastMovePlayer for whose action this was). `reinforced`
       *  is additive: true when it was the full-bank Reinforced cast. */
      lastBulwark?: { tokenId: number; reinforced?: boolean } | null;
      /** Master Killer mode only: Bulwark actually BLOCKED one or more
       *  captures this broadcast — independent of lastMovePlayer, since this
       *  fires the instant a fresh flip reveals the block (see
       *  tickBulwarkForNewTurn/tickBulwarkForReflip in master-killer.ts),
       *  which can be before the blocked player's opponent has even chosen
       *  a move. `tokenIds` are the Bulwarked tokens that just got consumed. */
      lastBulwarkBlock?: { tokenIds: number[] } | null;
      /** Master Killer mode only: the net charge change for one player from
       *  whatever just happened (move/charge/push/re-flip/zero-flip skip).
       *  Computed server-side as an authoritative before/after diff — never
       *  re-derived client-side — so the client can't drift from the real
       *  charge-economy rules the way a reimplementation could. Omitted/null
       *  when nothing changed. */
      lastChargeEvent?: { player: PlayerId; delta: number } | null;
      /** Master Killer mode only: Archer's Rain of Arrows ultimate. Non-null
       *  exactly on the broadcast where a 3rd consecutive shield landing
       *  resolved. `targetTokenId` is null when it fired into an empty
       *  eligible pool (streak still consumed — announce "no target," not
       *  nothing). Server-computed, never re-derived client-side, same
       *  reasoning as lastChargeEvent. */
      lastRainOfArrows?: { targetTokenId: number | null } | null;
      /** Master Killer mode only: Mage's Blink Strike or Warrior's Warpath.
       *  Non-null exactly on the broadcast where one of those resolved.
       *  `sweptTokenIds` is Warpath's extra captures along the way (always
       *  empty for Blink Strike, which never sweeps). Server-computed,
       *  never re-derived client-side. */
      lastUltimate?: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
      /** Master Killer mode only: Mage's Re-flip just resolved on this
       *  broadcast. Deliberately separate from lastChargeEvent, which nets
       *  to null when the replacement flip is a zero (the spent charge is
       *  refunded) even though a re-flip DID happen and the client owes an
       *  announcement. Server-computed, never re-derived client-side. */
      lastReflip?: { player: PlayerId } | null;
      /** Master Killer mode only: Necromancer's Revive just resolved on
       *  this broadcast. Same turn-continues lifecycle as lastReflip —
       *  the flip is unchanged and the move list was recomputed against
       *  the board the risen thrall now stands on. `tile` is the spawn
       *  the server's walk actually chose, never re-derived client-side. */
      lastRevive?: { tokenId: number; tile: number } | null;
      /** Master Killer mode only: a thrall's duration ran out at the start
       *  of this broadcast's turn — the token crumbled home to its real
       *  owner's reserve. Drives the crumble treatment + activity log. */
      lastThrallExpired?: { tokenId: number } | null;
      /** Master Killer mode only: the corpse's owner re-entered the marked
       *  token on this broadcast, reclaiming the soul — the necromancer's
       *  banked Revive is denied. Server-derived, same authority rule as
       *  every announcement here. */
      lastCorpseDenied?: { tokenId: number } | null;
      /** Master Killer mode only: a Corpse Explosion resolved on this
       *  broadcast — epicenter tile plus who was struck / sent home. */
      lastCorpseExplosion?: { tile: number; struckTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Master Killer mode only: Necromancer's Exhume ultimate. Non-null
       *  exactly on the broadcast where it resolved. `returnedTo` is the
       *  tile the occupancy walk actually landed the dragged token on —
       *  server-computed, never re-derived client-side, same reasoning as
       *  lastUltimate. */
      lastExhume?: { targetTokenId: number; returnedTo: number } | null;
    }
  | {
      type: "gameOver";
      winner: PlayerId;
      stats: {
        /** Total coin flips this match. Skipped turns count. Extra shield turns count. */
        turns: number;
        /** How many enemy tokens each player sent back to reserve during this match. */
        captures: { p1: number; p2: number };
      };
    }
  | {
      /** In-match text chat (PvP only). The server always sends the full
       *  bounded log (most recent last), so the client just re-renders it —
       *  idempotent, and a reconnecting player gets the recent history for
       *  free. Never rendered as HTML (client uses textContent). */
      type: "chat";
      log: ChatMsg[];
    }
  | {
      type: "error";
      message: string;
    };

/** Client -> Server */
export type ClientMessage =
  | {
      /** First message a client sends. Picks the game mode:
       *    cpu    — instant match vs the server bot
       *    create — open a private room, wait for a friend with the code
       *    join   — enter an existing room by code */
      type: "join";
      mode: "cpu" | "create" | "join";
      /** Required for mode "join". */
      room?: string;
      /** Ruleset for a NEW room (mode "cpu"/"create"). Ignored for mode
       *  "join" — you play whatever the room you're joining already is. */
      variant?: "classic" | "masterKiller";
      /** CPU strength for mode "cpu"; ignored otherwise (see RoomRequest's
       *  join op — same additive field, same server-side whitelist). */
      difficulty?: "easy" | "standard" | "hard";
    }
  | {
      /** Master Killer mode only: choose a class before the opening
       *  flip-off. Ignored outside class-pick phase or once already picked. */
      type: "pickClass";
      class: PlayerClass;
    }
  | {
      /** Master Killer mode only: spend a charge on an active ability
       *  instead of (Push/Charge) or before (Re-flip) a normal move.
       *  `moveIndex` indexes the last-received `powerMoves` list — never
       *  raw move data, so the server re-verifies against its own state,
       *  same trust model as chooseMove. */
      type: "usePower";
      action:
        | { kind: "push"; targetTokenId: number }
        | { kind: "chargedShot"; targetTokenId: number }
        | { kind: "reflip" }
        | { kind: "charge"; moveIndex: number }
        | { kind: "blinkStrike"; targetTokenId: number }
        | { kind: "warpath"; targetTokenId: number }
        /** `reinforced` is additive: true spends the full charge bank on
         *  the doubled (Reinforced) Bulwark; absent/false is the plain
         *  1-charge cast, unchanged. */
        | { kind: "bulwark"; tokenId: number; reinforced?: boolean }
        /** Necromancer's Revive: no payload — the server's banked corpse
         *  fully determines what rises and where. The client gates on
         *  power.reviveSpawnTile being non-null; the server re-validates
         *  against the same shared oracle. */
        | { kind: "revive" }
        /** Corpse Explosion: no payload — the marked corpse is the
         *  epicenter; the client gates on power.corpseExplosionTargets. */
        | { kind: "corpseExplosion" }
        | { kind: "exhume"; targetTokenId: number };
    }
  | {
      /** Resume a seat after a dropped connection (page reload, hosted
       *  function timeout). Server re-sends role + current state on success,
       *  or an error if the room/seat is gone. */
      type: "rejoin";
      room: string;
      seat: PlayerId;
      seatToken: string;
    }
  | {
      /** Flip my coins in the opening flip-off. Ignored outside the opening
       *  phase or if this seat already flipped this round. */
      type: "openingFlip";
    }
  | {
      /** Client picks a move by index into the last received `legalMoves` list.
       *  Index (not the full Move object) so the server can re-verify by
       *  recomputing legal moves — never trusts client-supplied move data. */
      type: "chooseMove";
      moveIndex: number;
    }
  | {
      /** Request a fresh match. Only honored when the current match has ended
       *  (state.winner !== null). Either player can trigger; both see the reset. */
      type: "newMatch";
    }
  | {
      /** Send a line of chat (PvP only). Server trims + length-caps it and
       *  rebroadcasts the whole log to both seats. Empty/whitespace ignored. */
      type: "chat";
      text: string;
    };
