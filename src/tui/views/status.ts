import { hints, label } from "../bindings.ts";
import { visibleAgents, visibleMessages } from "../filter.ts";
import type { Grid, Rect } from "../screen.ts";
import type { State } from "../state.ts";
import { clock, truncate, width } from "../text.ts";

/**
 * The bottom row. Left: key hints for the current focus, or the last error in
 * `bad` when the daemon could not be reached (the message carries the socket
 * path). Right: "12 of 43" under a filter and the time of the last good poll.
 * While the filter box has focus the row is the prompt with the count.
 */

/** Cells between the left and right halves, and between hints. */
const GAP = "  ";
/** Drawn after the filter text so the prompt reads as a place to type. */
const CARET = "▏";

/** "12 of 43" for the view on screen; only while a filter narrows it or is being typed. */
function count(state: State): string | undefined {
  if (state.filter === "" && state.focus !== "filter") return undefined;
  const shown = state.view === "agents" ? visibleAgents(state) : visibleMessages(state);
  const total = state.view === "agents" ? state.agents : state.messages;
  return `${shown.length} of ${total.length}`;
}

/** The right half, ready to draw: count and clock, or empty. */
function rightText(state: State): string {
  const parts = [
    count(state),
    state.lastPollAt === undefined ? undefined : clock(state.lastPollAt),
  ];
  return parts.filter((p) => p !== undefined).join(GAP);
}

/** Draw hints left to right, whole ones only, until the next would not fit. */
function drawHints(state: State, rect: Rect, grid: Grid, maxWidth: number): void {
  let x = rect.x;
  const limit = rect.x + maxWidth;
  for (const b of hints(state)) {
    const key = label(b);
    const needed = (x === rect.x ? 0 : width(GAP)) + width(key) + 1 + width(b.help);
    if (x + needed > limit) break;
    if (x !== rect.x) x += grid.put(x, rect.y, GAP, "plain");
    x += grid.put(x, rect.y, key, "plain");
    x += grid.put(x, rect.y, " ", "plain");
    x += grid.put(x, rect.y, b.help, "dim");
  }
}

export function drawStatus(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.fill(rect);
  const right = rightText(state);
  const rightW = width(right);
  if (rightW > 0) grid.put(rect.x + rect.w - rightW, rect.y, right, "dim", rightW);
  // The left half stops a gap short of the right half, or takes the row when there is none.
  const leftW = Math.max(0, rect.w - (rightW > 0 ? rightW + width(GAP) : 0));

  if (state.focus === "filter") {
    grid.put(rect.x, rect.y, truncate(`/${state.filter}${CARET}`, leftW), "plain", leftW);
    return;
  }
  if (state.error !== undefined) {
    grid.put(rect.x, rect.y, truncate(state.error, leftW), "bad", leftW);
    return;
  }
  drawHints(state, rect, grid, leftW);
}
