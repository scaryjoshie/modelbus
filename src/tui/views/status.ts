import { hints, label } from "../bindings.ts";
import type { Grid, Rect } from "../screen.ts";
import type { State } from "../state.ts";
import { clock, truncate, width } from "../text.ts";
import type { Span } from "./spans.ts";

/**
 * The bottom row. Left: key hints for the active tab, dropped whole from the
 * right when they do not fit; or, in `bad`, the last action's failure (until
 * the next key) or else the last poll's error (until the next good poll). The
 * error carries the socket path, so it stays on screen whole when it fits.
 * Right: "N pending" in `accent` while agents are marked, then the time of
 * the last good poll in `dim`. The filter count lives in the tab bar, not
 * here. A prompt takes this row instead; `view.ts` chooses, and
 * `views/prompt.ts` draws it.
 */

/** Cells between the left and right halves, between hints, and between the right-hand parts. */
const GAP = "  ";

/** "2 pending" while agents are marked; the mark is an Agents-tab notion, so only there. */
function pending(state: State): Span | undefined {
  if (state.tab !== "agents" || state.pending.length === 0) return undefined;
  return { text: `${state.pending.length} pending`, style: "accent" };
}

function lastPoll(state: State): Span | undefined {
  if (state.lastPollAt === undefined) return undefined;
  return { text: clock(state.lastPollAt), style: "dim" };
}

/** The right half: pending count and clock, gaps between, or nothing. */
function rightSpans(state: State): Span[] {
  const parts = [pending(state), lastPoll(state)].filter((p) => p !== undefined);
  return parts.flatMap((p, i) => (i === 0 ? [p] : [{ text: GAP, style: "plain" }, p]));
}

/** How many hints at the end of the list are kept when room runs out: help and quit. */
const KEPT_TAIL_HINTS = 2;

/**
 * Draw hints left to right, whole ones only. When they do not all fit, the
 * middle ones go first: the last two (help and quit) are the ones a lost
 * reader needs, so room is reserved for them before the rest are placed.
 */
function drawHints(state: State, rect: Rect, grid: Grid, maxWidth: number): void {
  const all = hints(state);
  const cost = (b: (typeof all)[number], first: boolean) =>
    (first ? 0 : width(GAP)) + width(label(b)) + 1 + width(b.help);
  const tail = all.slice(-KEPT_TAIL_HINTS);
  const head = all.slice(0, Math.max(0, all.length - KEPT_TAIL_HINTS));
  const tailWidth = tail.reduce((w, b) => w + cost(b, false), 0);
  let x = rect.x;
  const limit = rect.x + maxWidth;
  const draw = (b: (typeof all)[number]) => {
    if (x !== rect.x) x += grid.put(x, rect.y, GAP, "plain");
    x += grid.put(x, rect.y, label(b), "plain");
    x += grid.put(x, rect.y, " ", "plain");
    x += grid.put(x, rect.y, b.help, "dim");
  };
  for (const b of head) {
    if (x + cost(b, x === rect.x) + tailWidth > limit) break;
    draw(b);
  }
  for (const b of tail) {
    if (x + cost(b, x === rect.x) > limit) break;
    draw(b);
  }
}

export function drawStatus(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.fill(rect);
  const right = rightSpans(state);
  const rightW = right.reduce((w, s) => w + width(s.text), 0);
  let x = rect.x + rect.w - rightW;
  for (const s of right) x += grid.put(x, rect.y, s.text, s.style, rect.x + rect.w - x);
  // The left half stops a gap short of the right half, or takes the row when there is none.
  const leftW = Math.max(0, rect.w - (rightW > 0 ? rightW + width(GAP) : 0));

  // A failed action answers the key just pressed, so it wins over a standing poll error.
  const problem = state.notice ?? state.error;
  if (problem !== undefined) {
    grid.put(rect.x, rect.y, truncate(problem, leftW), "bad", leftW);
    return;
  }
  drawHints(state, rect, grid, leftW);
}
