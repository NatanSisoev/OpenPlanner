import type { Board, Cell, Mark } from "./types.js";

export type { Mark };

/** X wins, O wins, no winner yet, or the game continues. */
export type PublicStatus = "x_wins" | "o_wins" | "draw" | "ongoing";

/** Result for a given side: win, loss, draw, or not finished. */
export type SideOutcome = "win" | "loss" | "draw" | "ongoing";

const LINES: readonly (readonly [number, number, number])[] = [
	[0, 1, 2],
	[3, 4, 5],
	[6, 7, 8],
	[0, 3, 6],
	[1, 4, 7],
	[2, 5, 8],
	[0, 4, 8],
	[2, 4, 6],
] as const;

function sameMark(a: Cell, b: Cell, c: Cell): a is Mark {
	if (a === null || a !== b || b !== c) {
		return false;
	}
	return a === b && b === c;
}

/**
 * The mark that completes a line, or `null` if no line is filled by one mark.
 */
export function winningMark(board: Board): Mark | null {
	for (const [i, j, k] of LINES) {
		const a = board[i];
		const b = board[j];
		const c = board[k];
		if (sameMark(a, b, c)) {
			return a;
		}
	}
	return null;
}

export function isBoardFull(board: Board): boolean {
	return board.every((c) => c !== null);
}

export type LastMove = {
	index: number;
	row: number;
	col: number;
	player: Mark;
};

/**
 * After a move, determine match status: win (either side), draw, or ongoing.
 * Win is checked first, then draw (full board with no line).
 */
export function resolveStatusAfterMove(board: Board, _last: LastMove): PublicStatus {
	const w = winningMark(board);
	if (w === "X") {
		return "x_wins";
	}
	if (w === "O") {
		return "o_wins";
	}
	if (isBoardFull(board)) {
		return "draw";
	}
	return "ongoing";
}

/**
 * Classify a public status for one player: win, loss, draw, or still playing.
 */
export function outcomeForPlayer(status: PublicStatus, player: Mark): SideOutcome {
	if (status === "ongoing") {
		return "ongoing";
	}
	if (status === "draw") {
		return "draw";
	}
	if (status === "x_wins") {
		return player === "X" ? "win" : "loss";
	}
	return player === "O" ? "win" : "loss";
}
