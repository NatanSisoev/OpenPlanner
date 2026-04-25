# Tic Tac Toe (sandbox)

## State model

- **Board**: 9 cells in row-major order (indices 0–8). Each **cell** is `null` (empty) or `X` or `O`.
- **Turn order**: `X` moves first; valid moves use `state.nextPlayer` and alternate after each successful move.
- **Game end**: a line of three (rows, columns, diagonals) gives `x_wins` or `o_wins`; a full board with no line is `draw`; otherwise `ongoing`.

## API surface

- `createGame()` — empty board, `X` to play.
- `applyMove(state, row, col, player)` — bounds, non-empty, wrong-player, and terminal-game checks; updates board and status.
- `resolveStatusAfterMove`, `winningMark`, `isBoardFull` — rule checks after a move.
- `outcomeForPlayer(status, player)` — per-side `win` | `loss` | `draw` | `ongoing`.

No database; no migrations.
