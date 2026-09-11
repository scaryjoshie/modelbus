import { conversationLabel, selectedConversation } from "../filter.ts";
import { TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { ChatMessage, Conversation, State } from "../state.ts";
import { hostStyle } from "../style.ts";
import { clock } from "../text.ts";
import { EMPTY } from "./empty.ts";
import { type Line, memberLine, putLine } from "./spans.ts";
import { wrap } from "./wrap.ts";

/**
 * The messages pane of the Chats tab: always the selected conversation. The
 * title row names it (kind color) and its members (host hues), bold while
 * the arrows are in this pane. Below, `chatLines` from `scroll.messages`: the
 * page from `history` oldest to newest, each message a header line (sender in
 * its host's hue, time dim) and its body wrapped to the pane and indented, a
 * blank line between messages. No cursor: `update` clamps the offset against
 * `chatLines` so the pane and the clamp agree on what a line is.
 */

/** Body lines sit under their message header by this much. */
const BODY_INDENT_COLS = 2;
/** Cells between the label and the members in the title, and between a sender and its time. */
const GAP = "  ";
/** The pane's name while no conversation is selected. */
const NO_CHAT_TITLE = "chat";

const dimLine = (text: string): Line => [{ text, style: "dim" }];

function headerLine(m: ChatMessage, roster: State["agents"]): Line {
  return [
    { text: m.fromName, style: hostStyle(roster, m.fromHost) },
    { text: `${GAP}${clock(m.createdAt)}`, style: "dim" },
  ];
}

function bodyLines(body: string, w: number): Line[] {
  const indent = " ".repeat(BODY_INDENT_COLS);
  return wrap(body, w - BODY_INDENT_COLS).map((t) => [{ text: indent + t, style: "plain" }]);
}

/** The messages as lines at width `w`: a header and an indented body each, a blank line between. */
export function messageLines(messages: ChatMessage[], roster: State["agents"], w: number): Line[] {
  const lines: Line[] = [];
  messages.forEach((m, i) => {
    if (i > 0) lines.push([]);
    lines.push(headerLine(m, roster), ...bodyLines(m.body, w));
  });
  return lines;
}

/**
 * Every line the pane shows below its title at width `w`. A page for another
 * conversation is stale, so it reads as loading until the right one lands.
 */
export function chatLines(state: State, w: number): Line[] {
  const c = selectedConversation(state);
  if (!c) return [dimLine(EMPTY.nothingSelected)];
  const history = state.history;
  if (!history || history.id !== c.id) return [dimLine(EMPTY.loading)];
  if (history.messages.length === 0) return [dimLine(EMPTY.noMessages)];
  return messageLines(history.messages, state.agents, w);
}

function titleLine(c: Conversation | undefined, agents: State["agents"]): Line {
  if (!c) return [{ text: NO_CHAT_TITLE, style: "plain" }];
  return [
    { text: conversationLabel(c), style: c.kind === "group" ? "group" : "dm" },
    { text: GAP, style: "plain" },
    ...memberLine(c.participants, agents),
  ];
}

export function drawChat(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  // Bold is one role; while the pane has the arrows its title gives up its colors for it.
  const override = state.focus === "messages" ? "title" : undefined;
  putLine(
    grid,
    rect.x,
    rect.y,
    titleLine(selectedConversation(state), state.agents),
    rect.w,
    override,
  );
  const lines = chatLines(state, rect.w);
  const rows = rect.h - TITLE_ROWS;
  for (let i = 0; i < rows; i++) {
    const line = lines[state.scroll.messages + i];
    if (!line) break;
    putLine(grid, rect.x, rect.y + TITLE_ROWS + i, line, rect.w);
  }
}
