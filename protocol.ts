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
        /** Cleric (2026-07-21): Bless / Heal pools for the CURRENT player
         *  (affordability baked in — empty = not castable) and
         *  Benediction's would-change pool (gated on ultimateReady like
         *  every ultimate list). */
        blessTargets?: number[];
        healTargets?: number[];
        benedictionTargets?: number[];
        /** Every token's blessed/wounded state — public table-state, the
         *  same visibility rule as bulwarkedTokenIds (the rings are
         *  visible board truth for both seats). */
        vitality?: Record<number, "blessed" | "wounded">;
        /** Rogue (2026-07-21, Vanish added 2026-07-22): Pickpocket pool for
         *  the CURRENT player (affordability baked in), Vanish's own
         *  OWN-stone pool (affordability NOT baked in, Bulwark's own
         *  convention), and Grand Heist's ultimate pool (gated on
         *  ultimateReady like every ultimate list). */
        pickpocketTargets?: number[];
        vanishTargets?: number[];
        /** Rogue's Backstab pool (restored 2026-09-13; affordability baked in). */
        backstabTargets?: number[];
        grandHeistTargets?: number[];
        /** Mage's Blink: legal destination TILES for the current player
         *  (affordability baked in; the stone is server-selected). */
        blinkTiles?: number[];
        /** Warlock (2026-07-26): Curse / Sacrifice pools for the CURRENT
         *  player (affordability baked into both oracles — empty = not
         *  castable) and Fel Storm's victim pool (gated on ultimateReady
         *  like every ultimate list). */
        curseTargets?: number[];
        sacrificeTargets?: number[];
        felStormTargets?: number[];
        /** Every live curse (token id -> the VICTIM's turn-starts
         *  remaining) — public table-state, the same visibility rule as
         *  bulwarkedTokenIds. */
        cursed?: Record<number, number>;
        /** Hunter (2026-07-26): Snare's legal TILE pool (the one ability
         *  that targets a square, not a stone), Hamstring's enemy pool,
         *  and Wild Hunt's (gated on ultimateReady like every ultimate
         *  list). Plus the public board truth both seats render: each
         *  hunter's armed trap tile, the tile their wolf guards, and every
         *  frozen stone's remaining victim-turns. */
        snareTiles?: number[];
        /** At most ONE id — the arrow's path picks the victim, so this is a
         *  castability signal plus a highlight, not a choice. */
        piercingShotTargets?: number[];
        wildHuntTargets?: number[];
        traps?: Record<PlayerId, number | null>;
        wolfGuard?: Record<PlayerId, number | null>;
        hamstrung?: Record<number, number>;
        /** Barbarian (2026-07-27): Reckless Swing / Whirlwind / Bloodbath
         *  pools, plus each player's live Rage bonus (derived from visible
         *  reserve counts, so public to both seats). */
        recklessSwingTargets?: number[];
        whirlwindTargets?: number[];
        bloodbathTargets?: number[];
        rage?: Record<PlayerId, number>;
        /** Bard (2026-07-27): Inspire's own-stone pool and the two payoff
         *  pools, plus every lit stone's remaining bard-turns. */
        inspireTargets?: number[];
        songOfHasteTargets?: number[];
        crescendoTargets?: number[];
        inspired?: Record<number, number>;
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
      lastUltimate?: {
        kind: "blinkStrike" | "warpath" | "grandHeist" | "rainOfArrows";
        targetTokenId: number;
        sweptTokenIds: number[];
        /** Grand Heist only: how much of the target owner's bank was
         *  actually drained (server-computed). Absent for blinkStrike/
         *  warpath — they don't touch charges at all. */
        drained?: number;
      } | null;
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
      /** Master Killer mode only: Cleric's Bless / Heal just resolved on
       *  this broadcast — same one-token announce lifecycle as lastBulwark. */
      lastBless?: { tokenId: number } | null;
      lastHeal?: { tokenId: number } | null;
      /** Master Killer mode only: Cleric's Benediction ultimate — the ids
       *  it blessed. Server-computed from the shared oracle. */
      lastBenediction?: { tokenIds: number[] } | null;
      /** Master Killer mode only: one or more blessings BROKE on this
       *  broadcast — a capture/knockback resolved as a wound instead of a
       *  kill (any path). Positions are already in `state`; this is the
       *  authoritative "announce the survival" signal, never re-derived
       *  client-side. */
      lastWound?: { tokenIds: number[] } | null;
      /** Master Killer mode only: Sanctified Ground fired — the cleric's
       *  shield landing mended these wounded stones back to blessed. */
      lastMend?: { tokenIds: number[] } | null;
      /** Master Killer mode only: Rogue's Pickpocket just resolved on this
       *  broadcast — bank-level, not board-level: no token moved, but the
       *  target owner's charges dropped by `stolen`. */
      lastPickpocket?: { targetTokenId: number; stolen: number } | null;
      /** Master Killer mode only: Rogue's Backstab just resolved on this
       *  broadcast — a guaranteed hit; the victim is either gone (`state`
       *  shows it home) or wounded (`vitality`). */
      lastBackstab?: { targetTokenId: number } | null;
      /** Master Killer mode only: Mage's Blink just resolved — which stone
       *  jumped, from where, to where (positions already in `state`). */
      lastBlink?: { tokenId: number; from: number; to: number } | null;
      /** Master Killer mode only: Rogue's Vanish just resolved on this
       *  broadcast — same shape/lifecycle as lastBulwark, since it IS
       *  Bulwark's mechanic under a Rogue cast. */
      lastVanish?: { tokenId: number } | null;
      /** Master Killer mode only: Warlock's Curse of Chains just resolved
       *  — same turn-continues lifecycle as lastReflip/lastBless. */
      lastCurse?: { targetTokenId: number } | null;
      /** Master Killer mode only: a curse ran out at the start of this
       *  broadcast's turn (lastThrallExpired's lifecycle). */
      lastCurseExpired?: { tokenId: number } | null;
      /** Master Killer mode only: Warlock's Sacrifice resolved — the enemy
       *  killed and the mover's OWN stone given for it (server-selected,
       *  never re-derived client-side). */
      lastSacrifice?: { sacrificedTokenId: number; targetTokenId: number } | null;
      /** Master Killer mode only: Warlock's Fel Storm ultimate resolved —
       *  who it dragged, and the rare thrall-only crumble deaths. */
      lastFelStorm?: { struckTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Master Killer mode only: Hunter's Snare was ARMED this broadcast
       *  (turn-keeping, lastCurse's lifecycle). */
      lastSnare?: { tile: number } | null;
      /** A trap SPRUNG on this broadcast's landing, and/or the Wolf
       *  Companion bit the mover — both resolved inside resolveTurn and
       *  server-computed, never re-derived client-side. */
      lastTrapSprung?: { tile: number; tokenId: number; sentHome: boolean } | null;
      lastWolfBite?: { tokenId: number; sentHome: boolean } | null;
      /** Hunter's Piercing Shot resolved this broadcast — the arrow's own
       *  path picked the victim, so the result is reported rather than
       *  echoed back from a client-named target. A Blessing absorbs it
       *  (mortal weapon), hence the kill/wound split. */
      lastPiercingShot?: { killedTokenId: number | null; woundedTokenId: number | null } | null;
      /** Freezes that ran out at the start of this broadcast's turn. */
      lastThaw?: { tokenIds: number[] } | null;
      /** Hunter's Wild Hunt ultimate — who froze, and what the wolf took. */
      lastWildHunt?: { frozenTokenIds: number[]; killedTokenId: number | null } | null;
      /** Master Killer mode only: Barbarian's Reckless Swing resolved —
       *  the whole trade, including whether the recoil sent the swinger
       *  home as well. */
      lastRecklessSwing?: {
        swingerTokenId: number;
        killedTokenId: number | null;
        woundedTokenId: number | null;
        swingerSentHome: boolean;
      } | null;
      /** Barbarian's Whirlwind — captured vs merely shoved. */
      lastWhirlwind?: { capturedTokenIds: number[]; knockedTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Barbarian's Bloodbath ultimate — everything the charge ran down
       *  and the tile it finished on. */
      lastBloodbath?: { killedTokenIds: number[]; endedOn: number } | null;
      /** Master Killer mode only: the bard's slots. Inspire is
       *  turn-keeping (lastCurse's lifecycle); the two payoffs report which
       *  stones marched and anything they ran over. */
      lastInspire?: { tokenId: number } | null;
      lastInspireFaded?: { tokenIds: number[] } | null;
      lastSongOfHaste?: { movedIds: number[]; capturedIds: number[] } | null;
      lastCrescendo?: { inspiredIds: number[]; movedIds: number[]; capturedIds: number[] } | null;
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
        | { kind: "rainOfArrows"; targetTokenId: number }
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
        | { kind: "exhume"; targetTokenId: number }
        /** Cleric's Bless / Heal: target one of the caster's OWN stones —
         *  the client gates on power.blessTargets / power.healTargets;
         *  the server re-validates against the same shared oracles. */
        | { kind: "bless"; targetTokenId: number }
        | { kind: "heal"; targetTokenId: number }
        /** Cleric's Benediction: no payload — the client gates on
         *  power.benedictionTargets being non-empty. */
        | { kind: "benediction" }
        /** Rogue's Pickpocket: targets an enemy in shared water, but the
         *  effect is bank-level — the client gates on
         *  power.pickpocketTargets; the server re-validates against the
         *  same shared oracle. */
        | { kind: "pickpocket"; targetTokenId: number }
        /** Rogue's Backstab: an enemy in shared water — the client gates on
         *  power.backstabTargets; the server re-validates against the same
         *  shared oracle. */
        | { kind: "backstab"; targetTokenId: number }
        /** Mage's Blink: a TILE (Snare's shape) — the client gates on
         *  power.blinkTiles; the server re-validates against the same
         *  shared oracle and picks the stone itself. */
        | { kind: "blink"; tile: number }
        /** Rogue's Vanish: targets one of the caster's OWN stones, same
         *  shape as Bulwark's tokenId — the client gates on
         *  power.vanishTargets; the server re-validates against the same
         *  shared oracle. */
        | { kind: "vanish"; tokenId: number }
        | { kind: "grandHeist"; targetTokenId: number }
        /** Warlock's Curse of Chains / Sacrifice: both target an enemy in
         *  shared water — the client gates on power.curseTargets /
         *  power.sacrificeTargets; the server re-validates against the
         *  same shared oracles. Sacrifice's OWN cost (the mover's
         *  MOST-advanced stone) is server-selected, never client-named. */
        | { kind: "curse"; targetTokenId: number }
        | { kind: "sacrifice"; targetTokenId: number }
        /** Warlock's Fel Storm: no payload — the whole shared row is the
         *  target; the client gates on power.felStormTargets being
         *  non-empty. */
        | { kind: "felStorm" }
        /** Hunter's Snare: the ONLY action carrying a tile index rather
         *  than a token id — the client gates on power.snareTiles; the
         *  server re-validates against the same shared oracle. */
        | { kind: "snare"; tile: number }
        /** Hunter's Piercing Shot: no payload — the arrow's path picks the
         *  victim; the client gates on power.piercingShotTargets being
         *  non-empty and the server re-derives the victim itself. */
        | { kind: "piercingShot" }
        /** Hunter's Wild Hunt: no payload — the whole row is the target
         *  and the wolf picks its own quarry. */
        | { kind: "wildHunt" }
        /** Barbarian's Reckless Swing: names the enemy only — the striker
         *  is whichever of the caster's stones stands directly behind it,
         *  determined by the board and never client-supplied. */
        | { kind: "recklessSwing"; targetTokenId: number }
        /** Whirlwind / Bloodbath: no payload — everything in reach is the
         *  target; the client gates on the matching pool being non-empty. */
        | { kind: "whirlwind" }
        | { kind: "bloodbath" }
        /** Bard's Inspire: targets one of the caster's OWN stones. */
        | { kind: "inspire"; targetTokenId: number }
        /** Song of Haste / Crescendo: no payload — every lit stone (or the
         *  whole army) marches; the client gates on the matching pool. */
        | { kind: "songOfHaste" }
        | { kind: "crescendo" };
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
