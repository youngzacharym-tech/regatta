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
      lastMove: Move | null;
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
        safeTokens: number[];
        /** Valid Push targets for the CURRENT player, if they're an Archer
         *  with a charge and it's their turn — empty otherwise. */
        pushTargets: number[];
      };
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
        | { kind: "reflip" }
        | { kind: "charge"; moveIndex: number };
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
    };
