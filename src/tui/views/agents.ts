import { visibleAgents } from "../filter.ts";
import { bodyRows, TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Agent, State } from "../state.ts";
import { providerStyle, type Style } from "../style.ts";
import { age, fitRight, truncate, width } from "../text.ts";
import { drawEmpty, EMPTY, REGISTER_HINT } from "./empty.ts";

/**
 * The roster: one row per agent (a mark when it is pending, then name, purpose,
 * provider, status, last active), the cursor row inverse, sorted and filtered by
 * `filter.ts`. A name and its provider tag share the provider's hue, so the color
 * says where an agent runs and the tag is its legend; the mark is accent. The
 * status cell shows what the host says the session is doing, or, when the
 * provider cannot reach it, why, in `bad`. Sessions that have not registered are
 * listed dim, so what is on the bus and what merely exists are told apart.
 * Columns are sized from the whole visible list, so scrolling never shifts one;
 * when the pane is narrow the least useful columns go first (provider, then
 * active, then status) and the purpose keeps the rest.
 */

/** The pending mark: one cell at the row's left, blank on unmarked rows. */
export const PENDING_MARK = "●";
/** The mark and the space after it; every row reserves them so names line up. */
const MARK_COLS = 2;
/** Cells between two columns. */
const GAP_COLS = 2;
/** "999d" is the widest age `text.age` produces; "now" fits too. */
const ACTIVE_COLS = 4;
/** Activity this recent reads as "now" even when the host reports no status. */
const ACTIVE_NOW_MS = 10_000;
/** Host statuses that mean the session is working right now. */
const WORKING_STATUSES = new Set(["busy", "shell"]);
/** Names are short handles; longer ones get an ellipsis so the purpose keeps its room. */
const NAME_MAX_COLS = 18;
/** A purpose column narrower than this reads worse than one column fewer. */
const PURPOSE_MIN_COLS = 12;
/** Widest a provider name may push the name column; longer ones get an ellipsis. */
const PROVIDER_MAX_COLS = 12;
/** A status, or the reason the provider cannot reach the session. */
const STATUS_MAX_COLS = 24;

const TITLE = "agents";
/** What the purpose cell says for a session that is not on the bus yet. */
const NOT_REGISTERED = "not registered";

/** Column widths in cells; 0 means the column is not drawn. */
export interface Columns {
  name: number;
  purpose: number;
  provider: number;
  status: number;
  active: number;
}

/** The purpose cell: what the agent said it is for; a candidate is told apart here. */
export const purposeText = (agent: Agent): string =>
  agent.registered ? (agent.purpose ?? "") : NOT_REGISTERED;

/** The status cell: the host's word, or why the provider cannot reach the session. */
export const statusText = (agent: Agent): string =>
  agent.reachable ? (agent.status ?? "") : (agent.note ?? "unreachable");

/** "now" while the host says the session is working or it just did something; else an age. */
export function activeText(agent: Agent, now: number): string {
  const working = agent.status !== undefined && WORKING_STATUSES.has(agent.status);
  if (working || (agent.activeAt !== undefined && now - agent.activeAt < ACTIVE_NOW_MS))
    return "now";
  return agent.activeAt === undefined ? "" : age(agent.activeAt, now);
}

const widest = (values: Array<string | undefined>): number =>
  values.reduce((w, v) => Math.max(w, v === undefined ? 0 : width(v)), 0);

/** Cells everything but the purpose takes: the mark, and each drawn column with its gap. */
const used = (c: Columns): number =>
  MARK_COLS +
  [c.name, c.provider, c.status, c.active].reduce(
    (sum, w) => (w > 0 ? sum + w + GAP_COLS : sum),
    0,
  );

/** Widths for `rows` in a pane `w` cells wide; the purpose column takes what is left. */
export function columns(w: number, rows: Agent[]): Columns {
  const c: Columns = {
    name: Math.max(1, Math.min(widest(rows.map((a) => a.name)), NAME_MAX_COLS)),
    purpose: 0,
    provider: Math.min(widest(rows.map((a) => a.provider)), PROVIDER_MAX_COLS),
    status: Math.min(widest(rows.map(statusText)), STATUS_MAX_COLS),
    active: ACTIVE_COLS,
  };
  const dropOrder: Array<keyof Columns> = ["provider", "active", "status"];
  for (const key of dropOrder) {
    if (w - used(c) >= PURPOSE_MIN_COLS) break;
    c[key] = 0;
  }
  c.purpose = Math.max(0, w - used(c));
  if (c.purpose === 0) c.name = Math.max(1, w - used({ ...c, name: 0 }));
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
  // The cursor row is inverse video and nothing else, so every cell shares one
  // style; a session not on the bus is dim throughout.
  const style = (role: Style): Style => (selected ? "selected" : agent.registered ? role : "dim");
  if (selected) grid.fill({ x: rect.x, y, w: rect.w, h: 1 }, "selected");
  let x = rect.x;
  if (row.pending) grid.put(x, y, PENDING_MARK, style("accent"), 1);
  x += MARK_COLS;
  grid.put(
    x,
    y,
    truncate(agent.name, c.name),
    style(providerStyle(roster, agent.provider)),
    c.name,
  );
  x += c.name + GAP_COLS;
  if (c.purpose > 0) {
    grid.put(x, y, truncate(purposeText(agent), c.purpose), style("plain"), c.purpose);
    x += c.purpose + GAP_COLS;
  }
  if (c.provider > 0) {
    grid.put(
      x,
      y,
      truncate(agent.provider, c.provider),
      style(providerStyle(roster, agent.provider)),
      c.provider,
    );
    x += c.provider + GAP_COLS;
  }
  if (c.status > 0) {
    const role: Style = agent.reachable ? "plain" : "bad";
    grid.put(x, y, truncate(statusText(agent), c.status), style(role), c.status);
    x += c.status + GAP_COLS;
  }
  if (c.active > 0) {
    const text = activeText(agent, now);
    grid.put(x, y, fitRight(text, c.active), style(text === "now" ? "ok" : "dim"), c.active);
  }
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
