import { conversationLabel, visibleConversations } from "../filter.ts";
import { bodyRows, TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Conversation, State } from "../state.ts";
import type { Style } from "../style.ts";
import { firstLine, fitRight, width } from "../text.ts";
import { drawEmpty, EMPTY } from "./empty.ts";
import { type Line, lineWidth, memberLine, nameStyle, putLine, SEPARATOR } from "./spans.ts";

/**
 * The chats list: one row per conversation in the daemon's order (newest
 * activity first), filtered by `filter.ts`. Kind, members, unread count and the
 * last message; the cursor row inverse across every cell. Columns are sized
 * from the whole visible list so scrolling never shifts one; the last message
 * takes the slack and is the first to go when the pane is narrow.
 */

/** Cells between two columns. */
const GAP_COLS = 2;
/** A group's #name is cut here so the members keep their room. */
const LABEL_MAX_COLS = 16;
/** Widest the member list may grow while the last message keeps its slack. */
const MEMBERS_MAX_COLS = 32;
/** A last message narrower than this reads worse than none. */
const LAST_MIN_COLS = 12;

/** Column widths in cells; 0 means the column is not drawn. */
export interface Columns {
  label: number;
  members: number;
  unread: number;
  last: number;
}

const widest = (values: number[]): number => values.reduce((w, v) => Math.max(w, v), 0);

const labelLine = (c: Conversation): Line => [
  { text: conversationLabel(c), style: c.kind === "group" ? "group" : "dm" },
];

/** "sender: first line" with the sender in its host's hue; the overview names the sender only. */
function lastLine(c: Conversation, agents: State["agents"]): Line {
  if (!c.last) return [];
  return [
    { text: c.last.fromName, style: nameStyle(c.last.fromName, c.participants, agents) },
    { text: `: ${firstLine(c.last.body)}`, style: "plain" },
  ];
}

const gaps = (widths: number[]): number =>
  widths.reduce((sum, w) => (w > 0 ? sum + w + GAP_COLS : sum), 0);

/** Widths for `rows` in a pane `w` cells wide. */
export function columns(w: number, rows: Conversation[]): Columns {
  const label = Math.min(widest(rows.map((c) => lineWidth(labelLine(c)))), LABEL_MAX_COLS);
  const unread = Math.max(1, widest(rows.map((c) => width(String(c.unread)))));
  const membersWanted = widest(
    rows.map((c) => width(c.participants.map((p) => p.name).join(SEPARATOR))),
  );
  const members = Math.min(membersWanted, MEMBERS_MAX_COLS);
  const last = w - gaps([label, members, unread]);
  if (last >= LAST_MIN_COLS) return { label, members, unread, last };
  // Too narrow for a preview: the members take what the preview would have had.
  return { label, members: Math.max(1, w - gaps([label, unread])), unread, last: 0 };
}

/** Pane title, bold while the arrows move this list. The filter count lives in the tab row. */
function drawTitle(state: State, rect: Rect, grid: Grid): void {
  grid.put(rect.x, rect.y, "chats", state.focus === "list" ? "title" : "plain", rect.w);
}

function drawRow(
  c: Conversation,
  y: number,
  rect: Rect,
  cols: Columns,
  state: State,
  grid: Grid,
  selected: boolean,
): void {
  // The cursor row is inverse video and nothing else, so every cell shares one style.
  const override: Style | undefined = selected ? "selected" : undefined;
  if (selected) grid.fill({ x: rect.x, y, w: rect.w, h: 1 }, "selected");
  let x = rect.x;
  putLine(grid, x, y, labelLine(c), cols.label, override);
  x += cols.label + GAP_COLS;
  putLine(grid, x, y, memberLine(c.participants, state.agents), cols.members, override);
  x += cols.members + GAP_COLS;
  const unread = fitRight(String(c.unread), cols.unread);
  grid.put(x, y, unread, override ?? (c.unread > 0 ? "accent" : "dim"), cols.unread);
  x += cols.unread + GAP_COLS;
  if (cols.last > 0) putLine(grid, x, y, lastLine(c, state.agents), cols.last, override);
}

export function drawChats(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  const rows = visibleConversations(state);
  drawTitle(state, rect, grid);
  const body: Rect = { x: rect.x, y: rect.y + TITLE_ROWS, w: rect.w, h: rect.h - TITLE_ROWS };
  if (rows.length === 0) {
    drawEmpty(body, grid, state.conversations.length === 0 ? EMPTY.noChats : EMPTY.noMatch);
    return;
  }
  const cols = columns(rect.w, rows);
  const first = state.scroll.chats;
  rows.slice(first, first + bodyRows(rect)).forEach((c, i) => {
    drawRow(c, body.y + i, rect, cols, state, grid, c.id === state.selectedConversationId);
  });
}
