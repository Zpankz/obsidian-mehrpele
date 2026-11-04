/**
 * Arrow-key moves in a popover of rows (pure): Left/Right step through the
 * items in reading order, wrapping between rows; Up/Down keep the column
 * (clamped to a shorter row) and wrap top ↔ bottom; Home/End go to the first
 * and last item. Null for any other key.
 */
export interface Cell {
  row: number;
  col: number;
}

export function gridMove(rowLengths: readonly number[], at: Cell, key: string): Cell | null {
  const rows = rowLengths.length;
  if (!rows) return null;
  const flat = (c: Cell) => rowLengths.slice(0, c.row).reduce((a, b) => a + b, 0) + c.col;
  const total = rowLengths.reduce((a, b) => a + b, 0);
  const fromFlat = (i: number): Cell => {
    let n = ((i % total) + total) % total;
    for (let r = 0; r < rows; r++) {
      if (n < rowLengths[r]) return { row: r, col: n };
      n -= rowLengths[r];
    }
    return { row: 0, col: 0 };
  };
  switch (key) {
    case "ArrowRight":
      return fromFlat(flat(at) + 1);
    case "ArrowLeft":
      return fromFlat(flat(at) - 1);
    case "ArrowDown":
    case "ArrowUp": {
      const row = (at.row + (key === "ArrowDown" ? 1 : -1) + rows) % rows;
      return { row, col: Math.min(at.col, rowLengths[row] - 1) };
    }
    case "Home":
      return { row: 0, col: 0 };
    case "End":
      return fromFlat(total - 1);
    default:
      return null;
  }
}
