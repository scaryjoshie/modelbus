import { visibleMessages } from "../filter.ts";
import { TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Message, State } from "../state.ts";
import type { Style } from "../style.ts";
import { age, firstLine, fit, fitRight, truncate, width } from "../text.ts";
import { drawEmpty, EMPTY } from "./empty.ts";

/**
 * The message log: one row per delivery (age, from, to, status, first line of
 * the body), status colored by role, the cursor row inverse. Columns are sized
 * from every listed message, not just the window, so nothing shifts on scroll.
 */

/** "999d" is the widest age `text.age` produces. */
export const AGE_COLS = 4;
/** "delivered" is the longest delivery status. */
const STATUS_COLS = 9;
const NAME_MAX_COLS = 16;
const NAME_MIN_COLS = 4;
/** Below this the body column is noise, so names give way first. */
const BODY_MIN_COLS = 12;
/** Cells between columns: age|from, the arrow, to|status, status|body. */
const ARROW = " → ";
const SEPARATOR_COLS = 1 + width(ARROW) + 1 + 1;

/** One meaning per color: delivered and read are done, sent is pending, failed is wrong. */
const STATUS_STYLE: Record<Message["status"], Style> = {
  sent: "wait",
  delivered: "ok",
  read: "ok",
  failed: "bad",
};

export const statusStyle = (status: Message["status"]): Style => STATUS_STYLE[status];

export interface LogColumns {
  age: number;
  /** Shared by from and to. */
  name: number;
  status: number;
  /** Whatever is left; zero hides the body. */
  body: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Column widths for a pane `w` cells wide listing `messages`. Body gets the slack. */
export function logColumns(w: number, messages: Message[]): LogColumns {
  const longest = messages.reduce((n, m) => Math.max(n, width(m.fromName), width(m.toName)), 0);
  const fixed = AGE_COLS + STATUS_COLS + SEPARATOR_COLS;
  let name = clamp(longest, NAME_MIN_COLS, NAME_MAX_COLS);
  if (w - fixed - 2 * name < BODY_MIN_COLS) {
    name = clamp(Math.floor((w - fixed - BODY_MIN_COLS) / 2), NAME_MIN_COLS, name);
  }
  return { age: AGE_COLS, name, status: STATUS_COLS, body: Math.max(0, w - fixed - 2 * name) };
}

export function drawLog(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.put(rect.x, rect.y, "messages", state.focus === "list" ? "title" : "plain", rect.w);
  const body: Rect = { x: rect.x, y: rect.y + TITLE_ROWS, w: rect.w, h: rect.h - TITLE_ROWS };
  const rows = visibleMessages(state);
  if (rows.length === 0) {
    drawEmpty(body, grid, state.messages.length === 0 ? EMPTY.noMessages : EMPTY.noMatch);
    return;
  }
  const cols = logColumns(rect.w, rows);
  for (let i = 0; i < body.h; i++) {
    const m = rows[state.scroll.log + i];
    if (!m) break;
    drawRow(state, m, cols, { x: rect.x, y: body.y + i, w: rect.w, h: 1 }, grid);
  }
}

function drawRow(state: State, m: Message, cols: LogColumns, row: Rect, grid: Grid): void {
  const selected = m.seq === state.selectedSeq;
  // The cursor row is inverse throughout; color would fight the inverse.
  const style = (s: Style): Style => (selected ? "selected" : s);
  if (selected) grid.fill(row, "selected");
  const end = row.x + row.w;
  let x = row.x;
  x += grid.put(x, row.y, fitRight(age(m.createdAt, state.now), cols.age), style("dim"), end - x);
  const names = ` ${fit(m.fromName, cols.name)}${ARROW}${fit(m.toName, cols.name)} `;
  x += grid.put(x, row.y, names, style("plain"), end - x);
  x += grid.put(x, row.y, fit(m.status, cols.status), style(statusStyle(m.status)), end - x);
  if (cols.body > 0) {
    grid.put(x + 1, row.y, truncate(firstLine(m.body), cols.body), style("plain"), end - x - 1);
  }
}
