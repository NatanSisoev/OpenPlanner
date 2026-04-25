export {
	applyMove,
	createGame,
	currentPlayer,
	type ApplyMoveResult,
	type GameState,
	type GameStatus,
	type MoveError,
} from "./model.js";
export {
	isBoardFull,
	outcomeForPlayer,
	resolveStatusAfterMove,
	winningMark,
	type LastMove,
	type PublicStatus,
	type SideOutcome,
} from "./rules.js";
export type { Board, Cell, Mark } from "./types.js";
