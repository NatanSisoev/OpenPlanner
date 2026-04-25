export type Mark = "X" | "O";

/** A cell is empty, X, or O. */
export type Cell = Mark | null;

/** Nine cells, row-major (indices 0–2 row 0, 3–5 row 1, 6–8 row 2). */
export type Board = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];
