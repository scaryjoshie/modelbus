import type { Grid, Rect } from "../screen.ts";
import { promptLabel, type State } from "../state.ts";
import { truncate, width } from "../text.ts";

/**
 * The one-line prompt over the status row: a label in `dim`, the text, and a
 * cursor cell in `selected` after it. Serves the filter, the group name and
 * the rename; `promptLabel` says which. Only drawing happens here: `update`
 * owns the text and answers Enter and Esc. When the text is wider than the
 * row, the start is cut so the end, where typing happens, stays in view.
 */

/** Between the label and the text. */
const SEPARATOR = ": ";
/** The cursor is one blank cell in inverse video. */
const CURSOR_COLS = 1;
const ELLIPSIS = "…";

/** The last `w` cells of `s`, starting with an ellipsis when something was cut. */
export function tail(s: string, w: number): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s;
  if (w === 1) return ELLIPSIS;
  const chars = [...s];
  let out = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] ?? "";
    const cw = width(ch);
    if (used + cw > w - 1) break;
    out = ch + out;
    used += cw;
  }
  return ELLIPSIS + out;
}

export function drawPrompt(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0 || !state.prompt) return;
  grid.fill(rect);
  const label = truncate(`${promptLabel(state.prompt)}${SEPARATOR}`, rect.w);
  const x = rect.x + grid.put(rect.x, rect.y, label, "dim", rect.w);
  const room = rect.x + rect.w - x;
  if (room < CURSOR_COLS) return;
  const text = tail(state.prompt.text, room - CURSOR_COLS);
  const used = grid.put(x, rect.y, text, "plain", room - CURSOR_COLS);
  grid.put(x + used, rect.y, " ", "selected", CURSOR_COLS);
}
