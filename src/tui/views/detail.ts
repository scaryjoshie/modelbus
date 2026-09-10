import { agentMessages, selectedAgent, selectedMessage } from "../filter.ts";
import { TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Agent, Message, State } from "../state.ts";
import type { Style } from "../style.ts";
import { age, clock, fit, fitRight, shortenHome, truncate, width } from "../text.ts";
import { EMPTY } from "./empty.ts";
import { AGE_COLS, statusStyle } from "./log.ts";

/**
 * The selected agent (agents view): its fields, then its messages oldest first.
 * Or the selected message (log view): header and full body. The pane is built
 * as a list of styled lines and drawn from `scroll.detail`, so scrolling is a
 * slice. This is the one place the TUI wraps text: bodies are read here, not
 * skimmed, and a body cut to one row would hide what the reader opened it for.
 */

/** "reachable" is the longest label, plus a gap. */
const LABEL_COLS = 10;
/** Body lines sit under their message header by this much. */
const BODY_INDENT_COLS = 2;
/** Names in a message header are cut here so the status stays on screen. */
const NAME_MAX_COLS = 16;
const ARROW = " → ";

interface Span {
  text: string;
  style: Style;
}

type Line = Span[];

export function drawDetail(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.put(rect.x, rect.y, "detail", state.focus === "detail" ? "title" : "plain", rect.w);
  const lines = detailLines(state, rect.w);
  const rows = rect.h - TITLE_ROWS;
  for (let i = 0; i < rows; i++) {
    const line = lines[state.scroll.detail + i];
    if (!line) break;
    const y = rect.y + TITLE_ROWS + i;
    let x = rect.x;
    for (const span of line) x += grid.put(x, y, span.text, span.style, rect.x + rect.w - x);
  }
}

/** Every line the pane would show at width `w`, before scrolling. */
export function detailLines(state: State, w: number): Line[] {
  if (state.view === "agents") {
    const agent = selectedAgent(state);
    return agent ? agentLines(state, agent, w) : [[{ text: EMPTY.nothingSelected, style: "dim" }]];
  }
  const m = selectedMessage(state);
  return m ? messageLines(state, m, w) : [[{ text: EMPTY.nothingSelected, style: "dim" }]];
}

const field = (label: string, value: Line): Line => [
  { text: fit(label, LABEL_COLS), style: "dim" },
  ...value,
];

function agentLines(state: State, agent: Agent, w: number): Line[] {
  const valueW = Math.max(1, w - LABEL_COLS);
  const plain = (s: string): Line => [{ text: truncate(s, valueW), style: "plain" }];
  const reachable: Line = [
    { text: agent.reachable ? "yes" : "no", style: agent.reachable ? "ok" : "bad" },
  ];
  if (agent.note) reachable.push({ text: `  ${truncate(agent.note, valueW - 5)}`, style: "plain" });
  const lines: Line[] = [
    field("name", plain(agent.name)),
    field("id", plain(agent.id)),
    field("host", plain(agent.host)),
    field("reachable", reachable),
    field("status", plain(agent.status ?? "")),
  ];
  if (agent.title) lines.push(field("title", plain(agent.title)));
  lines.push(
    field("dir", plain(shortenHome(agent.cwd))),
    field("seen", plain(`${age(agent.lastSeen, state.now)} ago  ${clock(agent.lastSeen)}`)),
    [],
  );
  const messages = agentMessages(state, agent);
  if (messages.length === 0) lines.push([{ text: EMPTY.noMessages, style: "dim" }]);
  for (const m of messages) lines.push(headerLine(m, state.now), ...bodyLines(m.body, w));
  return lines;
}

function headerLine(m: Message, now: number): Line {
  const names = ` ${truncate(m.fromName, NAME_MAX_COLS)}${ARROW}${truncate(m.toName, NAME_MAX_COLS)} `;
  return [
    { text: fitRight(age(m.createdAt, now), AGE_COLS), style: "dim" },
    { text: names, style: "plain" },
    { text: m.status, style: statusStyle(m.status) },
  ];
}

function bodyLines(body: string, w: number): Line[] {
  const indent = " ".repeat(BODY_INDENT_COLS);
  return wrap(body, w - BODY_INDENT_COLS).map((t) => [{ text: indent + t, style: "plain" }]);
}

function messageLines(state: State, m: Message, w: number): Line[] {
  const valueW = Math.max(1, w - LABEL_COLS);
  const plain = (s: string): Line => [{ text: truncate(s, valueW), style: "plain" }];
  const status: Line = [{ text: m.status, style: statusStyle(m.status) }];
  if (m.detail) {
    status.push({ text: `  ${truncate(m.detail, valueW - m.status.length - 2)}`, style: "plain" });
  }
  return [
    field("from", plain(m.fromName)),
    field("to", plain(m.toName)),
    field("state", status),
    field("sent", plain(`${clock(m.createdAt)}  ${age(m.createdAt, state.now)} ago`)),
    [],
    ...wrap(m.body, w).map((t): Line => [{ text: t, style: "plain" }]),
  ];
}

/**
 * Break `text` into lines of at most `w` cells: on newlines first, then between
 * words, then inside a word only when the word alone is wider than the line.
 * Widths are terminal cells, so a CJK character or an emoji counts as two and
 * is never split across lines.
 */
export function wrap(text: string, w: number): string[] {
  const cols = Math.max(1, w);
  return text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, cols));
}

function wrapParagraph(paragraph: string, cols: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
    if (/^\s+$/.test(token)) {
      // Whitespace that does not fit is what the line break stands in for.
      if (width(line) + width(token) <= cols) line += token;
      continue;
    }
    for (const piece of breakWord(token, cols)) {
      if (width(line) + width(piece) <= cols) line += piece;
      // Only indentation so far: replacing it beats emitting a blank line.
      else if (line.trim() === "") line = piece;
      else {
        lines.push(line.trimEnd());
        line = piece;
      }
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

/** A word wider than a line, cut into pieces that each fit; anything else as is. */
function breakWord(word: string, cols: number): string[] {
  if (width(word) <= cols) return [word];
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const ch of word) {
    const cw = width(ch);
    if (used + cw > cols && piece !== "") {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += ch;
    used += cw;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}
