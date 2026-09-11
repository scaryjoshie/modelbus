import type { Result } from "../client.ts";
import { type Action, lookup } from "./bindings.ts";
import {
  conversationSpec,
  selectedAgent,
  selectedConversation,
  visibleAgents,
  visibleConversations,
} from "./filter.ts";
import { type Key, keyId } from "./keys.ts";
import { bodyRows, layout, type Size } from "./layout.ts";
import { chatLines } from "./views/chat.ts";

/**
 * The whole TUI as one value and one pure function over it. `update` never
 * touches the terminal or the network: when a key needs the daemon, the step
 * carries an `Effect` and `index.ts` runs it and dispatches what comes back.
 */

export type Agent = Result<"who">["agents"][number];
export type Message = Result<"log">["rows"][number];
export type Conversation = Result<"conversations">["conversations"][number];
export type ChatMessage = Result<"history">["items"][number];

export type Tab = "agents" | "chats";

/** A one-line text box over the status row; while set, the keyboard is text. */
export type Prompt =
  | { kind: "filter"; text: string }
  /** Agent names, in the order they were marked. */
  | { kind: "group"; text: string; members: string[] }
  /** The agent's current name. */
  | { kind: "rename"; text: string; agent: string };

/** On the Chats tab the arrows move the list or scroll the messages pane. */
export type Focus = "list" | "messages";

/** The newest page of one conversation, oldest first. Stale once another is selected. */
export interface History {
  id: string;
  messages: ChatMessage[];
}

export interface State {
  tab: Tab;
  /** Chats tab only; the Agents tab has one pane that takes keys. */
  focus: Focus;
  help: boolean;
  /** Narrows the active tab's list; the filter prompt edits it live. */
  filter: string;
  prompt: Prompt | undefined;
  /** Last successful poll, kept through errors. */
  agents: Agent[];
  /** The log; the agent detail pane reads it. */
  messages: Message[];
  conversations: Conversation[];
  /** Agents marked with `c`, by id, in the order they were marked. */
  pending: readonly string[];
  /** Selection by identity, so a poll cannot move the cursor to a different row. */
  selectedAgentId: string | undefined;
  selectedConversationId: string | undefined;
  /** Messages of the selected conversation, once `history` has answered for it. */
  history: History | undefined;
  /** First visible row of each list; first visible line of the messages pane. */
  scroll: { agents: number; chats: number; messages: number };
  lastPollAt: number | undefined;
  /** The last poll's failure; cleared by the next success. */
  error: string | undefined;
  /** The last action's failure; cleared by the next key. */
  notice: string | undefined;
  size: Size;
  now: number;
  quit: boolean;
}

export type Msg =
  | { type: "key"; key: Key }
  | { type: "resize"; size: Size }
  | {
      type: "poll";
      agents: Agent[];
      messages: Message[];
      conversations: Conversation[];
      at: number;
    }
  | { type: "pollError"; error: string; at: number }
  | { type: "history"; id: string; messages: ChatMessage[]; at: number }
  | {
      type: "conversationCreated";
      id: string;
      conversations: Conversation[];
      messages: ChatMessage[];
    }
  | { type: "actionFailed"; error: string }
  | { type: "tick"; now: number };

/** A daemon call `update` wants made; `actions.ts` knows how. */
export type Effect =
  | { type: "openDm"; a: string; b: string }
  | { type: "createGroup"; name: string; members: string[] }
  | { type: "rename"; agent: string; name: string }
  | { type: "loadHistory"; id: string; spec: string };

export interface Step {
  state: State;
  effect?: Effect;
}

/** Fewer marked agents than this and Enter has nothing to connect. */
const DM_SIZE = 2;

export function initialState(size: Size, now: number): State {
  return {
    tab: "agents",
    focus: "list",
    help: false,
    filter: "",
    prompt: undefined,
    agents: [],
    messages: [],
    conversations: [],
    pending: [],
    selectedAgentId: undefined,
    selectedConversationId: undefined,
    history: undefined,
    scroll: { agents: 0, chats: 0, messages: 0 },
    lastPollAt: undefined,
    error: undefined,
    notice: undefined,
    size,
    now,
    quit: false,
  };
}

/** What the prompt view writes before the text. */
export function promptLabel(prompt: Prompt): string {
  switch (prompt.kind) {
    case "filter":
      return "filter";
    case "group":
      return "group name";
    case "rename":
      return `rename ${prompt.agent}`;
  }
}

const step = (state: State, effect?: Effect): Step => (effect ? { state, effect } : { state });

export function update(state: State, msg: Msg): Step {
  switch (msg.type) {
    case "tick":
      return step({ ...state, now: msg.now });
    case "resize":
      return step(settle({ ...state, size: msg.size }, state));
    case "pollError":
      return step({ ...state, error: msg.error, now: msg.at });
    case "poll":
      return step(
        settle(
          {
            ...state,
            agents: msg.agents,
            messages: msg.messages,
            conversations: msg.conversations,
            lastPollAt: msg.at,
            error: undefined,
            now: msg.at,
          },
          state,
        ),
      );
    case "history":
      // A page for something no longer selected is stale; the next tick asks again.
      if (msg.id !== state.selectedConversationId) return step(state);
      return step(settle({ ...state, history: { id: msg.id, messages: msg.messages } }, state));
    case "conversationCreated":
      // The filter goes too: the new conversation must be the row that gets selected.
      return step(
        settle(
          {
            ...state,
            tab: "chats",
            focus: "list",
            filter: "",
            prompt: undefined,
            pending: [],
            conversations: msg.conversations,
            selectedConversationId: msg.id,
            history: { id: msg.id, messages: msg.messages },
          },
          state,
        ),
      );
    case "actionFailed":
      return step({ ...state, notice: msg.error });
    case "key":
      return onKey({ ...state, notice: undefined }, msg.key);
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
 * Keep the selection if it is still listed, else take the first row. Falling to
 * the row at the old index put the cursor on an unrelated agent as a filter
 * narrowed the list, and a mark then landed on it.
 */
function reselect<T>(rows: T[], id: (row: T) => string, selected: string | undefined): number {
  const index = rows.findIndex((r) => id(r) === selected);
  if (index >= 0 || rows.length === 0) return index;
  return 0;
}

/**
 * After data, size, filter or selection changed: settle both lists, the pending
 * set, and the messages pane, which follows the newest message while it shows
 * the tail and stays put otherwise.
 */
function settle(next: State, prev: State): State {
  const rects = layout(next.size);
  const listRows = bodyRows(rects.list);
  const agents = visibleAgents(next);
  const agentIndex = reselect(agents, (a) => a.id, next.selectedAgentId);
  const chats = visibleConversations(next);
  const chatIndex = reselect(chats, (c) => c.id, next.selectedConversationId);
  const known = new Set(next.agents.map((a) => a.id));
  const settled: State = {
    ...next,
    selectedAgentId: agents[agentIndex]?.id,
    selectedConversationId: chats[chatIndex]?.id,
    pending: next.pending.filter((id) => known.has(id)),
  };
  const sameChat = settled.selectedConversationId === prev.selectedConversationId;
  const wasAtTail = prev.scroll.messages >= messageRows(prev);
  const maxMessages = messageRows(settled);
  return {
    ...settled,
    scroll: {
      agents: keepVisible(next.scroll.agents, agentIndex, listRows, agents.length),
      chats: keepVisible(next.scroll.chats, chatIndex, listRows, chats.length),
      messages: !sameChat || wasAtTail ? maxMessages : clamp(next.scroll.messages, 0, maxMessages),
    },
  };
}

/**
 * How far the messages pane can scroll: its last line stays on screen. The view
 * decides what the lines are (wrapping depends on the pane width), so the clamp
 * asks it rather than guessing.
 */
function messageRows(state: State): number {
  const rect = layout(state.size).detail;
  return Math.max(0, chatLines(state, rect.w).length - bodyRows(rect));
}

const isText = (k: Key) => !k.ctrl && !k.alt && (k.name === "space" || [...k.name].length === 1);

/** The prompt owns the keyboard while it is up; only quit gets through. */
function onPromptKey(state: State, prompt: Prompt, key: Key): Step {
  const id = keyId(key);
  if (id === "ctrl+c") return step({ ...state, quit: true });
  if (id === "escape") return step(cancelPrompt(state, prompt));
  if (id === "enter") return confirmPrompt(state, prompt);
  if (id === "ctrl+u") return step(editPrompt(state, prompt, ""));
  if (id === "backspace")
    return step(editPrompt(state, prompt, [...prompt.text].slice(0, -1).join("")));
  if (isText(key))
    return step(editPrompt(state, prompt, prompt.text + (key.name === "space" ? " " : key.name)));
  return step(state);
}

/** New text for the prompt; the filter prompt narrows the list as it goes. */
function editPrompt(state: State, prompt: Prompt, text: string): State {
  const next = { ...state, prompt: { ...prompt, text } };
  return prompt.kind === "filter" ? settle({ ...next, filter: text }, state) : next;
}

function cancelPrompt(state: State, prompt: Prompt): State {
  const next = { ...state, prompt: undefined };
  return prompt.kind === "filter" ? settle({ ...next, filter: "" }, state) : next;
}

/** Enter: keep the filter; name a group; rename an agent. An empty name is a no-op. */
function confirmPrompt(state: State, prompt: Prompt): Step {
  const name = prompt.text.trim();
  switch (prompt.kind) {
    case "filter":
      return step({ ...state, prompt: undefined });
    case "group":
      if (name === "") return step(state);
      return step(
        { ...state, prompt: undefined, pending: [] },
        { type: "createGroup", name, members: prompt.members },
      );
    case "rename":
      if (name === "") return step(state);
      return step({ ...state, prompt: undefined }, { type: "rename", agent: prompt.agent, name });
  }
}

function onKey(state: State, key: Key): Step {
  if (state.prompt) return onPromptKey(state, state.prompt, key);
  const binding = lookup(state, keyId(key));
  return binding ? withHistory(state, act(state, binding.action, key)) : step(state);
}

/**
 * A key that put a different conversation on screen asks for its page at once
 * rather than waiting for the next tick. Never overrides an effect the key
 * itself produced.
 */
function withHistory(before: State, after: Step): Step {
  const { state } = after;
  const c = selectedConversation(state);
  if (after.effect || state.tab !== "chats" || !c || state.history?.id === c.id) return after;
  const changed = c.id !== before.selectedConversationId || before.tab !== "chats";
  return changed
    ? step(state, { type: "loadHistory", id: c.id, spec: conversationSpec(c) })
    : after;
}

/** Esc: close help; on Agents clear pending, on Chats leave the messages pane; else clear the filter. */
function back(state: State): State {
  if (state.help) return { ...state, help: false };
  if (state.tab === "agents" && state.pending.length > 0) return { ...state, pending: [] };
  if (state.tab === "chats" && state.focus === "messages") return { ...state, focus: "list" };
  if (state.filter !== "") return settle({ ...state, filter: "" }, state);
  return state;
}

/** Move the cursor by `delta` rows in the active list or the open chat, clamped. */
function move(state: State, delta: number): State {
  if (state.tab === "agents") {
    const rows = visibleAgents(state);
    if (rows.length === 0) return state;
    const i = rows.findIndex((a) => a.id === state.selectedAgentId);
    const target = clamp(i < 0 ? 0 : i + delta, 0, rows.length - 1);
    return settle({ ...state, selectedAgentId: rows[target]?.id }, state);
  }
  if (state.focus === "messages") {
    const messages = clamp(state.scroll.messages + delta, 0, messageRows(state));
    return { ...state, scroll: { ...state.scroll, messages } };
  }
  const rows = visibleConversations(state);
  if (rows.length === 0) return state;
  const i = rows.findIndex((c) => c.id === state.selectedConversationId);
  const target = clamp(i < 0 ? 0 : i + delta, 0, rows.length - 1);
  return settle({ ...state, selectedConversationId: rows[target]?.id }, state);
}

/** `c`: toggle the selected agent's mark, keeping mark order for the others. */
function mark(state: State): State {
  const id = state.selectedAgentId;
  if (id === undefined) return state;
  const pending = state.pending.includes(id)
    ? state.pending.filter((p) => p !== id)
    : [...state.pending, id];
  return { ...state, pending };
}

/** Enter on Agents: two marked agents make a DM; more need a name first. */
function connect(state: State): Step {
  const names = state.pending
    .map((id) => state.agents.find((a) => a.id === id)?.name)
    .filter((n): n is string => n !== undefined);
  const [a, b] = names;
  if (a === undefined || b === undefined) return step(state);
  if (names.length === DM_SIZE) return step(state, { type: "openDm", a, b });
  return step({ ...state, prompt: { kind: "group", text: "", members: names } });
}

function act(state: State, action: Action, key: Key): Step {
  switch (action) {
    case "quit":
      return step({ ...state, quit: true });
    case "back":
      return step(back(state));
    case "help":
      return step({ ...state, help: !state.help });
    case "switchTab":
      return step(
        settle(
          { ...state, tab: state.tab === "agents" ? "chats" : "agents", focus: "list" },
          state,
        ),
      );
    case "move":
      return step(move(state, key.name === "up" ? -1 : 1));
    case "filter":
      return step({ ...state, prompt: { kind: "filter", text: state.filter } });
    case "mark":
      return step(mark(state));
    case "connect":
      return connect(state);
    case "focusMessages":
      return step(selectedConversation(state) ? { ...state, focus: "messages" } : state);
    case "rename": {
      const agent = selectedAgent(state);
      if (!agent) return step(state);
      return step({ ...state, prompt: { kind: "rename", text: "", agent: agent.name } });
    }
  }
}
