import { visibleAgents } from "../filter.ts";
import { bodyRows, TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Agent, State } from "../state.ts";
import { hostStyle, type Style } from "../style.ts";
import { age, fitRight, truncate, width } from "../text.ts";
import { drawEmpty, EMPTY, REGISTER_HINT } from "./empty.ts";

/**
 * The roster: one row per agent (a mark when it is pending, then name, host,
 * reachability, status, age of last seen), the cursor row inverse, sorted and
 * filtered by `filter.ts`. A name and its host tag share the host's hue, so the
 * color says where an agent runs and the tag is its legend; the mark is accent.
 * Columns are sized from the whole visible list, so
 * scrolling never shifts one; when the pane is narrow the least useful columns
 * go first (age, then status, then host) and the name keeps the rest.
 */

/** The pending mark: one cell at the row's left, blank on unmarked rows. */
export const PENDING_MARK = "●";
/** The mark and the space after it; every row reserves them so names line up. */
const MARK_COLS = 2;
/** Cells between two columns. */
const GAP_COLS = 2;
/** "999d" is the widest age `text.age` produces. */
const AGE_COLS = 4;
/** "up" or "down". */
const REACH_COLS = 4;
/** A name column narrower than this reads worse than one column fewer. */
const NAME_MIN_COLS = 10;
/** Widest a host name may push the name column; longer ones get an ellipsis. */
const HOST_MAX_COLS = 12;
const STATUS_MAX_COLS = 16;
/** "down" plus its note grows the reachability column only up to this. */
const REACH_NOTE_MAX_COLS = 24;
/** Names keep at least this much before a note may take the rest. */
const NAME_ROOMY_COLS = 24;

const TITLE = "agents";
const REACHABLE = "up";
const UNREACHABLE = "down";

/** Column widths in cells; 0 means the column is not drawn. */
export interface Columns {
  name: number;
  host: number;
  reach: number;
  status: number;
  age: number;
}

const widest = (values: Array<string | undefined>): number =>
  values.reduce((w, v) => Math.max(w, v === undefined ? 0 : width(v)), 0);

/** The reachability cell: "down" with its note when the column is wide enough for one. */
function reachText(agent: Agent, cols: number): string {
  if (agent.reachable) return REACHABLE;
  const note = agent.note ?? "";
  return note !== "" && cols > REACH_COLS ? `${UNREACHABLE} ${note}` : UNREACHABLE;
}

/** Cells everything but the name takes: the mark, and each drawn column with its gap. */
const used = (c: Columns): number =>
  MARK_COLS +
  [c.host, c.reach, c.status, c.age].reduce((sum, w) => (w > 0 ? sum + w + GAP_COLS : sum), 0);

/** Widths for `rows` in a pane `w` cells wide; the name column takes what is left. */
export function columns(w: number, rows: Agent[]): Columns {
  const c: Columns = {
    name: 0,
    host: Math.min(widest(rows.map((a) => a.host)), HOST_MAX_COLS),
    reach: REACH_COLS,
    status: Math.min(widest(rows.map((a) => a.status)), STATUS_MAX_COLS),
    age: AGE_COLS,
  };
  const dropOrder: Array<keyof Columns> = ["age", "status", "host"];
  for (const key of dropOrder) {
    if (w - used(c) >= NAME_MIN_COLS) break;
    c[key] = 0;
  }
  c.name = Math.max(1, w - used(c));
  // A note is worth reading only when the names are not paying for it.
  const notes = rows.filter((a) => !a.reachable).map((a) => reachText(a, Infinity));
  const wide = Math.min(widest(notes), REACH_NOTE_MAX_COLS);
  if (wide > c.reach && c.name - (wide - c.reach) >= NAME_ROOMY_COLS) {
    c.name -= wide - c.reach;
    c.reach = wide;
  }
  return c;
}

/** Pane title, plain: no pane has focus. The filter count lives in the tab row, not here. */
function drawTitle(rect: Rect, grid: Grid): void {
  grid.put(rect.x, rect.y, TITLE, "plain", rect.w);
}

interface Row {
  agent: Agent;
  y: number;
  pending: boolean;
  selected: boolean;
}

function drawRow(row: Row, rect: Rect, c: Columns, now: number, roster: Agent[], grid: Grid): void {
  const { agent, y, selected } = row;
  // The cursor row is inverse video and nothing else, so every cell shares one style.
  const style = (role: Style): Style => (selected ? "selected" : role);
  if (selected) grid.fill({ x: rect.x, y, w: rect.w, h: 1 }, "selected");
  let x = rect.x;
  if (row.pending) grid.put(x, y, PENDING_MARK, style("accent"), 1);
  x += MARK_COLS;
  grid.put(x, y, truncate(agent.name, c.name), style(hostStyle(roster, agent.host)), c.name);
  x += c.name + GAP_COLS;
  if (c.host > 0) {
    grid.put(x, y, truncate(agent.host, c.host), style(hostStyle(roster, agent.host)), c.host);
    x += c.host + GAP_COLS;
  }
  grid.put(
    x,
    y,
    truncate(reachText(agent, c.reach), c.reach),
    style(agent.reachable ? "ok" : "bad"),
    c.reach,
  );
  x += c.reach + GAP_COLS;
  if (c.status > 0) {
    grid.put(x, y, truncate(agent.status ?? "", c.status), style("plain"), c.status);
    x += c.status + GAP_COLS;
  }
  if (c.age > 0) grid.put(x, y, fitRight(age(agent.lastSeen, now), c.age), style("dim"), c.age);
}

export function drawAgents(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  const agents = visibleAgents(state);
  drawTitle(rect, grid);
  const body: Rect = { x: rect.x, y: rect.y + TITLE_ROWS, w: rect.w, h: rect.h - TITLE_ROWS };
  if (body.h <= 0) return;
  if (state.agents.length === 0) {
    // An empty list is only a fact about the bus once a poll has succeeded.
    if (state.lastPollAt === undefined) drawEmpty(body, grid, EMPTY.noData);
    else drawEmpty(body, grid, EMPTY.noAgents, REGISTER_HINT);
    return;
  }
  if (agents.length === 0) {
    drawEmpty(body, grid, EMPTY.noMatch);
    return;
  }
  // Widths come from the whole list, not the page, so scrolling never shifts a column.
  const c = columns(rect.w, agents);
  const pending = new Set(state.pending);
  const first = state.scroll.agents;
  agents.slice(first, first + bodyRows(rect)).forEach((agent, i) => {
    const row: Row = {
      agent,
      y: body.y + i,
      pending: pending.has(agent.id),
      selected: agent.id === state.selectedAgentId,
    };
    drawRow(row, rect, c, state.now, state.agents, grid);
  });
}
