// ============================================================================
// protocol.ts — message shapes shared by Referee (server) and Stage (client).
//
// Both sides import from here so wire messages can't drift.
// ============================================================================

import type { GameState, Move, PlayerId } from "./rulebook";

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
    }
  | {
      type: "waiting";
      reason: string;
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
