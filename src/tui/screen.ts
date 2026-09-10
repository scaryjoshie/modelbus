import { type Depth, SGR_RESET, type Style, sgr } from "./style.ts";
import { width } from "./text.ts";

/**
 * A grid of cells that views draw into, and the diff that turns two grids into
 * the bytes that move the terminal from one to the other. Views never write to
 * the terminal; they write here.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  /** One grapheme, "" for the second cell of a wide character. */
  ch: string;
  style: Style;
}

const BLANK: Cell = { ch: " ", style: "plain" };

export class Grid {
  readonly cells: Cell[][];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, (): Cell => ({ ...BLANK })),
    );
  }

  private set(x: number, y: number, cell: Cell): void {
    const row = this.cells[y];
    if (row && x >= 0 && x < this.cols) row[x] = cell;
  }

  /** Write `text` at a position, clipped to the grid and to `maxWidth` cells. Returns cells used. */
  put(x: number, y: number, text: string, style: Style = "plain", maxWidth = Infinity): number {
    if (y < 0 || y >= this.rows) return 0;
    let cx = x;
    for (const ch of text) {
      const w = width(ch);
      if (w === 0) continue;
      if (cx + w > x + maxWidth || cx + w > this.cols) break;
      this.set(cx, y, { ch, style });
      if (w === 2) this.set(cx + 1, y, { ch: "", style });
      cx += w;
    }
    return cx - x;
  }

  /** Fill a rectangle with spaces in one style; a full-width selected row is `fill` then `put`. */
  fill(r: Rect, style: Style = "plain"): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, { ch: " ", style });
    }
  }

  /** The plain text of one row, for tests. */
  text(y: number): string {
    return (this.cells[y] ?? []).map((c) => c.ch).join("");
  }
}

const cellsEqual = (a: Cell, b: Cell) => a.ch === b.ch && a.style === b.style;

const rowsEqual = (a: Cell[], b: Cell[]) =>
  a.length === b.length && a.every((c, i) => cellsEqual(c, b[i] ?? BLANK));

/** One row as bytes: styles open where they change and close at the end. */
function renderRow(row: Cell[], depth: Depth): string {
  let out = "";
  let current: Style = "plain";
  for (const cell of row) {
    if (cell.style !== current) {
      out += (current === "plain" ? "" : SGR_RESET) + sgr(cell.style, depth);
      current = cell.style;
    }
    out += cell.ch;
  }
  return current === "plain" ? out : out + SGR_RESET;
}

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/**
 * Bytes that turn the terminal showing `prev` into one showing `next`. Without a
 * `prev` (first frame, after a resize) every row is written. Empty when nothing changed.
 */
export function render(prev: Grid | undefined, next: Grid, depth: Depth): string {
  const same = prev !== undefined && prev.cols === next.cols && prev.rows === next.rows;
  let out = "";
  for (let y = 0; y < next.rows; y++) {
    const row = next.cells[y] ?? [];
    if (same && rowsEqual(prev.cells[y] ?? [], row)) continue;
    out += `\x1b[${y + 1};1H${renderRow(row, depth)}`;
  }
  return out ? SYNC_START + out + SYNC_END : "";
}
