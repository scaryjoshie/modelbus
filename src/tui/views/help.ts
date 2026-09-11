import { active, type Binding, label } from "../bindings.ts";
import type { Grid, Rect } from "../screen.ts";
import type { State } from "../state.ts";
import { fitRight, width } from "../text.ts";

/**
 * The `?` overlay: every binding of the screen underneath, in table order, with
 * its keys right-aligned in one plain column and its help text in `dim`. It
 * clears the whole body first so nothing shows through; when the body is too
 * short for the table, the last row says how many bindings are hidden. The
 * title is plain: `title` marks the active tab and nothing else.
 */

const TITLE = "keys";
/** Cells between the key column and the help text. */
const COLUMN_GAP = 2;

/** Rows for the table and, when not all fit, the "more" line in the last slot. */
function shown(entries: Binding[], available: number): { rows: Binding[]; hidden: number } {
  if (entries.length <= available) return { rows: entries, hidden: 0 };
  const rows = entries.slice(0, Math.max(0, available - 1));
  return { rows, hidden: entries.length - rows.length };
}

export function drawHelp(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  // With the overlay up most keys are paused; the reader wants the table for
  // the screen underneath, which is what the keys do once it is down.
  const entries = active({ ...state, help: false });
  const { rows, hidden } = shown(entries, rect.h - 1);
  // The whole body, not only the rows used: the list must not show through.
  grid.fill(rect);
  grid.put(rect.x, rect.y, TITLE, "plain", rect.w);

  const keyW = Math.max(0, ...rows.map((b) => width(label(b))));
  rows.forEach((b, i) => {
    const y = rect.y + 1 + i;
    const used = grid.put(rect.x, y, fitRight(label(b), keyW), "plain", rect.w);
    const helpX = rect.x + used + COLUMN_GAP;
    grid.put(helpX, y, b.help, "dim", Math.max(0, rect.x + rect.w - helpX));
  });
  if (hidden > 0) {
    const y = rect.y + 1 + rows.length;
    grid.put(rect.x, y, `${hidden} more, not shown at this height`, "dim", rect.w);
  }
}
