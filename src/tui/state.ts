import type { Result } from "../client.ts";
import { type Action, lookup } from "./bindings.ts";
import { visibleAgents, visibleMessages } from "./filter.ts";
import { type Key, keyId } from "./keys.ts";
import { bodyRows, layout, type Size } from "./layout.ts";
import { detailLines } from "./views/detail.ts";

/**
 * The whole TUI as one value and one pure function over it. `update` never
 * touches the terminal or the network; `index.ts` feeds it messages and draws
 * whatever comes out.
 */

export type Agent = Result<"who">["agents"][number];
export type Message = Result<"log">["rows"][number];

export type View = "agents" | "log";
export type Focus = "list" | "detail" | "filter";

export interface State {
  view: View;
  focus: Focus;
  help: boolean;
  /** Filter text; narrows the current view's list. */
  filter: string;
  /** Last successful `who` and `log`, kept through errors. */
  agents: Agent[];
  messages: Message[];
  /** Selection by identity, so a poll cannot move the cursor to a different agent. */
  selectedAgentId: string | undefined;
  selectedSeq: number | undefined;
  /** First visible row of each scrolling region. */
  scroll: { agents: number; log: number; detail: number };
  lastPollAt: number | undefined;
  /** The last poll's failure; cleared by the next success. */
  error: string | undefined;
  size: Size;
  now: number;
  quit: boolean;
}

export type Msg =
  | { type: "key"; key: Key }
  | { type: "resize"; size: Size }
  | { type: "poll"; agents: Agent[]; messages: Message[]; at: number }
  | { type: "pollError"; error: string; at: number }
  | { type: "tick"; now: number };

export function initialState(size: Size, now: number): State {
  return {
    view: "agents",
    focus: "list",
    help: false,
    filter: "",
    agents: [],
    messages: [],
    selectedAgentId: undefined,
    selectedSeq: undefined,
    scroll: { agents: 0, log: 0, detail: 0 },
    lastPollAt: undefined,
    error: undefined,
    size,
    now,
    quit: false,
  };
}

export function update(state: State, msg: Msg): State {
  switch (msg.type) {
    case "tick":
      return { ...state, now: msg.now };
    case "resize":
      return settle({ ...state, size: msg.size }, state);
    case "pollError":
      return { ...state, error: msg.error, now: msg.at };
    case "poll":
      return settle(
        {
          ...state,
          agents: msg.agents,
          messages: msg.messages,
          lastPollAt: msg.at,
          error: undefined,
          now: msg.at,
        },
        state,
      );
    case "key":
      return onKey(state, msg.key);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** The smallest change to `offset` that keeps row `index` inside a window of `rows`. */
function keepVisible(offset: number, index: number, rows: number, count: number): number {
  const max = Math.max(0, count - rows);
  if (index < 0) return clamp(offset, 0, max);
  if (index < offset) return index;
  if (index >= offset + rows) return index - rows + 1;
  return clamp(offset, 0, max);
}

/**
 * After data, size or filter changed: keep the selection if it is still listed,
 * otherwise take the row that now sits where it was, then keep it on screen.
 * The log follows new messages while the cursor is on the last row.
 */
function settle(next: State, prev: State): State {
  const rects = layout(next.size);
  const agents = visibleAgents(next);
  const prevAgents = visibleAgents(prev);
  const prevAgentIndex = prevAgents.findIndex((a) => a.id === prev.selectedAgentId);
  let agentIndex = agents.findIndex((a) => a.id === next.selectedAgentId);
  if (agentIndex < 0 && agents.length > 0)
    agentIndex = clamp(Math.max(prevAgentIndex, 0), 0, agents.length - 1);

  const messages = visibleMessages(next);
  const prevMessages = visibleMessages(prev);
  const prevSeqIndex = prevMessages.findIndex((m) => m.seq === prev.selectedSeq);
  let seqIndex = messages.findIndex((m) => m.seq === next.selectedSeq);
  const wasAtEnd = prevSeqIndex < 0 || prevSeqIndex === prevMessages.length - 1;
  if (messages.length > 0) {
    if (seqIndex < 0)
      seqIndex = wasAtEnd ? messages.length - 1 : clamp(prevSeqIndex, 0, messages.length - 1);
    else if (wasAtEnd && next.messages !== prev.messages) seqIndex = messages.length - 1;
  }

  const selectedAgentId = agents[agentIndex]?.id;
  const selectedSeq = messages[seqIndex]?.seq;
  const listRows = bodyRows(rects.list);
  return {
    ...next,
    selectedAgentId,
    selectedSeq,
    scroll: {
      agents: keepVisible(next.scroll.agents, agentIndex, listRows, agents.length),
      log: keepVisible(next.scroll.log, seqIndex, listRows, messages.length),
      detail:
        selectedAgentId === prev.selectedAgentId && selectedSeq === prev.selectedSeq
          ? clamp(next.scroll.detail, 0, detailRows(next))
          : 0,
    },
  };
}

/**
 * How far the detail pane can scroll: its last line stays on screen. The view
 * decides what the lines are (wrapping depends on the pane width), so the clamp
 * asks it rather than guessing.
 */
function detailRows(state: State): number {
  const rect = layout(state.size).detail;
  return Math.max(0, detailLines(state, rect.w).length - bodyRows(rect));
}

const isText = (k: Key) => !k.ctrl && !k.alt && (k.name === "space" || [...k.name].length === 1);

/** The filter box owns the keyboard while it has focus; only quit gets through. */
function onFilterKey(state: State, key: Key): State {
  const id = keyId(key);
  if (id === "ctrl+c") return { ...state, quit: true };
  if (id === "escape") return settle({ ...state, filter: "", focus: "list" }, state);
  if (id === "enter") return { ...state, focus: "list" };
  if (id === "ctrl+u") return settle({ ...state, filter: "" }, state);
  if (id === "backspace")
    return settle({ ...state, filter: [...state.filter].slice(0, -1).join("") }, state);
  if (isText(key))
    return settle(
      { ...state, filter: state.filter + (key.name === "space" ? " " : key.name) },
      state,
    );
  return state;
}

function onKey(state: State, key: Key): State {
  if (state.focus === "filter") return onFilterKey(state, key);
  const binding = lookup(state, keyId(key));
  return binding ? act(state, binding.action) : state;
}

function back(state: State): State {
  if (state.help) return { ...state, help: false };
  if (state.focus === "detail") return { ...state, focus: "list" };
  if (state.filter !== "") return settle({ ...state, filter: "" }, state);
  return state;
}

/** Move the cursor by `delta` rows in the focused region, clamped. */
function move(state: State, delta: number): State {
  if (state.focus === "detail") {
    return {
      ...state,
      scroll: { ...state.scroll, detail: clamp(state.scroll.detail + delta, 0, detailRows(state)) },
    };
  }
  if (state.view === "agents") {
    const rows = visibleAgents(state);
    if (rows.length === 0) return state;
    const i = rows.findIndex((a) => a.id === state.selectedAgentId);
    const target = clamp(i < 0 ? 0 : i + delta, 0, rows.length - 1);
    return settle({ ...state, selectedAgentId: rows[target]?.id }, state);
  }
  const rows = visibleMessages(state);
  if (rows.length === 0) return state;
  const i = rows.findIndex((m) => m.seq === state.selectedSeq);
  const target = clamp(i < 0 ? 0 : i + delta, 0, rows.length - 1);
  return settle({ ...state, selectedSeq: rows[target]?.seq }, state);
}

const FAR = 1_000_000;

function act(state: State, action: Action): State {
  const page = bodyRows(
    state.focus === "detail" ? layout(state.size).detail : layout(state.size).list,
  );
  switch (action) {
    case "quit":
      return { ...state, quit: true };
    case "back":
      return back(state);
    case "help":
      return { ...state, help: !state.help };
    case "viewAgents":
      return settle({ ...state, view: "agents", focus: "list" }, state);
    case "viewLog":
      return settle({ ...state, view: "log", focus: "list" }, state);
    case "up":
      return move(state, -1);
    case "down":
      return move(state, 1);
    case "pageUp":
      return move(state, -page);
    case "pageDown":
      return move(state, page);
    case "top":
      return move(state, -FAR);
    case "bottom":
      return move(state, FAR);
    case "open":
      return { ...state, focus: "detail" };
    case "focusNext":
      return { ...state, focus: state.focus === "list" ? "detail" : "list" };
    case "filter":
      return { ...state, focus: "filter", help: false };
  }
}
