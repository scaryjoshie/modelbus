import { agentMessages, conversationLabel, selectedAgent } from "../filter.ts";
import { TITLE_ROWS } from "../layout.ts";
import type { Grid, Rect } from "../screen.ts";
import type { Agent, Message, State } from "../state.ts";
import { hostStyle, hostStyleById, type Style } from "../style.ts";
import { age, clock, fit, fitRight, shortenHome } from "../text.ts";
import { EMPTY } from "./empty.ts";
import { type Line, nameStyle, putLine, SEPARATOR } from "./spans.ts";
import { wrap } from "./wrap.ts";

/**
 * The Agents tab's detail pane: the selected agent's fields, the groups it is
 * in, then its messages from the log oldest first. It follows the selection
 * and has no focus or cursor, so its title stays plain. Built as a list of
 * styled lines and drawn from the top; lines that do not fit are not shown.
 * The Chats tab's detail rect is the messages pane in `views/chat.ts`.
 */

/** "999d" is the widest age `text.age` produces. */
const AGE_COLS = 4;
/** "reachable" is the longest label, plus a gap. */
const LABEL_COLS = 10;
/** Body lines sit under their message header by this much. */
const BODY_INDENT_COLS = 2;
const ARROW = " → ";

/** One meaning per color: delivered and read are done, sent is pending, failed is wrong. */
const STATUS_STYLE: Record<Message["status"], Style> = {
  sent: "wait",
  delivered: "ok",
  read: "ok",
  failed: "bad",
};

const statusStyle = (status: Message["status"]): Style => STATUS_STYLE[status];

export function drawDetail(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.put(rect.x, rect.y, "detail", "plain", rect.w);
  const lines = detailLines(state, rect.w);
  const rows = rect.h - TITLE_ROWS;
  for (let i = 0; i < rows; i++) {
    const line = lines[i];
    if (!line) break;
    putLine(grid, rect.x, rect.y + TITLE_ROWS + i, line, rect.w);
  }
}

/** Every line the pane would show at width `w`. */
export function detailLines(state: State, w: number): Line[] {
  const agent = selectedAgent(state);
  return agent ? agentLines(state, agent, w) : [[{ text: EMPTY.nothingSelected, style: "dim" }]];
}

const field = (label: string, value: Line): Line => [
  { text: fit(label, LABEL_COLS), style: "dim" },
  ...value,
];

const plain = (s: string): Line => [{ text: s, style: "plain" }];

/** The groups the agent is a member of, each #name in the group color. */
function groupsLine(state: State, agent: Agent): Line {
  return state.conversations
    .filter((c) => c.kind === "group" && c.participants.some((p) => p.id === agent.id))
    .flatMap(
      (c, i): Line => [
        ...(i > 0 ? [{ text: SEPARATOR, style: "dim" as const }] : []),
        { text: conversationLabel(c), style: "group" },
      ],
    );
}

function agentLines(state: State, agent: Agent, w: number): Line[] {
  const reachable: Line = [
    { text: agent.reachable ? "yes" : "no", style: agent.reachable ? "ok" : "bad" },
  ];
  if (agent.note) reachable.push({ text: `  ${agent.note}`, style: "plain" });
  const lines: Line[] = [
    field("name", [{ text: agent.name, style: hostStyle(state.agents, agent.host) }]),
    field("id", plain(agent.id)),
    field("host", [{ text: agent.host, style: hostStyle(state.agents, agent.host) }]),
    field("reachable", reachable),
    field("status", plain(agent.status ?? "")),
  ];
  if (agent.title) lines.push(field("title", plain(agent.title)));
  lines.push(
    field("dir", plain(shortenHome(agent.cwd))),
    field("seen", [
      { text: `${age(agent.lastSeen, state.now)} ago`, style: "plain" },
      { text: `  ${clock(agent.lastSeen)}`, style: "dim" },
    ]),
  );
  const groups = groupsLine(state, agent);
  if (groups.length > 0) lines.push(field("in", groups));
  lines.push([]);
  const messages = agentMessages(state, agent);
  if (messages.length === 0) lines.push([{ text: EMPTY.noMessages, style: "dim" }]);
  for (const m of messages) lines.push(headerLine(state, m), ...bodyLines(m.body, w));
  return lines;
}

/** Age, "from → to", status. Both names take their host's hue: the sender by id, the recipient by name, both from the roster. */
function headerLine(state: State, m: Message): Line {
  return [
    { text: fitRight(age(m.createdAt, state.now), AGE_COLS), style: "dim" },
    { text: " ", style: "plain" },
    { text: m.fromName, style: hostStyleById(state.agents, m.fromAgentId) },
    { text: ARROW, style: "plain" },
    { text: m.toName, style: nameStyle(m.toName, state.agents, state.agents) },
    { text: " ", style: "plain" },
    { text: m.status, style: statusStyle(m.status) },
  ];
}

function bodyLines(body: string, w: number): Line[] {
  const indent = " ".repeat(BODY_INDENT_COLS);
  return wrap(body, w - BODY_INDENT_COLS).map((t) => [{ text: indent + t, style: "plain" }]);
}
