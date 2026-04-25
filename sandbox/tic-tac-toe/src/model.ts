import { resolveStatusAfterMove, type PublicStatus, type Mark } from "./rules.js";
import type { Board, Cell } from "./types.js";

export type { Mark, Board, Cell } from "./types.js";

export type GameStatus = PublicStatus;

export type GameState =
	| { board: Board; status: "ongoing"; nextPlayer: Mark }
	| { board: Board; status: Exclude<PublicStatus, "ongoing"> };

export type MoveError =
	| { code: "not_ongoing"; status: Exclude<PublicStatus, "ongoing"> }
	| { code: "out_of_bounds"; row: number; col: number }
	| { code: "not_empty"; row: number; col: number; cell: Mark }
	| { code: "wrong_player"; expected: Mark; received: Mark };

export type ApplyMoveResult =
	| { ok: true; state: GameState }
	| { ok: false; error: MoveError };

const emptyBoard = (): Board =>
	[null, null, null, null, null, null, null, null, null] as const as unknown as Board;

export function createGame(): Extract<GameState, { status: "ongoing" }> {
	return { board: emptyBoard(), status: "ongoing", nextPlayer: "X" };
}

function toIndex(row: number, col: number): number {
	return row * 3 + col;
}

/**
 * Returns the mark whose turn it is, or `null` if the game is finished.
 */
export function currentPlayer(state: GameState): Mark | null {
	if (state.status === "ongoing") {
		return state.nextPlayer;
	}
	return null;
}

/**
 * Apply a move for `player` at `row` / `col` (0–2). The player must match
 * `state.nextPlayer` on ongoing games. Turn order alternates X → O → …
 */
export function applyMove(
	state: GameState,
	row: number,
	col: number,
	player: Mark
): ApplyMoveResult {
	if (state.status !== "ongoing") {
		return { ok: false, error: { code: "not_ongoing", status: state.status } };
	}
	if (player !== state.nextPlayer) {
		return { ok: false, error: { code: "wrong_player", expected: state.nextPlayer, received: player } };
	}
	if (row < 0 || row > 2 || col < 0 || col > 2) {
		return { ok: false, error: { code: "out_of_bounds", row, col } };
	}
	const i = toIndex(row, col);
	const cell = state.board[i];
	if (cell !== null) {
		return { ok: false, error: { code: "not_empty", row, col, cell } };
	}
	const nextBoard = [...state.board] as unknown as [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];
	nextBoard[i] = player;
	const board = nextBoard as Board;
	const lastMove = { row, col, player, index: i };
	const status = resolveStatusAfterMove(board, lastMove);

	if (status === "ongoing") {
		const nextPlayer: Mark = player === "X" ? "O" : "X";
		return { ok: true, state: { board, status: "ongoing", nextPlayer } };
	}
	return { ok: true, state: { board, status } };
}
