import { selectedAgent } from "./filter.ts";
import type { State } from "./state.ts";

/**
 * Every key the TUI answers to outside a prompt, in one table. `update`
 * dispatches from it, the status row shows the entries marked `hint`, and the
 * help overlay lists all of it, so the documentation cannot drift from the
 * behavior. Inside a prompt the keyboard is text; see `onPromptKey` in state.ts.
 * Enter changes nothing on screen but which pane the arrows move.
 */

export type Action =
  | "quit"
  | "back"
  | "help"
  | "switchTab"
  /** Up or down; the key that fired it says which. */
  | "move"
  | "filter"
  | "mark"
  | "connect"
  | "focusMessages"
  | "rename";

export interface Binding {
  /** Key ids as `keyId` spells them; the first is the one shown in hints. */
  keys: string[];
  action: Action;
  help: string;
  /** Applies only when true; absent means always. */
  when?: (s: State) => boolean;
  /** Worth a slot in the status row. */
  hint?: boolean;
}

const noOverlay = (s: State) => !s.help;
const agentsTab = (s: State) => s.tab === "agents" && !s.help;
const chatsTab = (s: State) => s.tab === "chats" && !s.help;
const chatsList = (s: State) => chatsTab(s) && s.focus === "list";

export const BINDINGS: readonly Binding[] = [
  { keys: ["tab"], action: "switchTab", help: "switch tab", when: noOverlay, hint: true },
  { keys: ["up", "down"], action: "move", help: "move", when: noOverlay, hint: true },
  { keys: ["f"], action: "filter", help: "filter", when: noOverlay, hint: true },
  { keys: ["c"], action: "mark", help: "mark pending", when: agentsTab, hint: true },
  {
    keys: ["enter"],
    action: "connect",
    help: "register",
    when: (s) => agentsTab(s) && s.pending.length === 0 && selectedAgent(s)?.registered === false,
    hint: true,
  },
  {
    keys: ["enter"],
    action: "connect",
    help: "connect pending",
    when: (s) => agentsTab(s) && s.pending.length > 0,
    hint: true,
  },
  { keys: ["enter"], action: "focusMessages", help: "read messages", when: chatsList, hint: true },
  { keys: ["r"], action: "rename", help: "rename", when: agentsTab, hint: true },
  { keys: ["escape"], action: "back", help: "back out one level" },
  { keys: ["?"], action: "help", help: "help", hint: true },
  { keys: ["q"], action: "quit", help: "quit", hint: true },
  { keys: ["ctrl+c"], action: "quit", help: "quit from anywhere" },
];

/** Bindings that apply in this state, in table order. */
export function active(state: State): Binding[] {
  return BINDINGS.filter((b) => b.when === undefined || b.when(state));
}

/** The status row's short list. */
export function hints(state: State): Binding[] {
  return active(state).filter((b) => b.hint === true);
}

/** The first binding that takes this key in this state. */
export function lookup(state: State, id: string): Binding | undefined {
  return active(state).find((b) => b.keys.includes(id));
}

const GLYPHS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "⏎",
  escape: "esc",
  tab: "tab",
};

/** "↑/↓" for a binding, the way the status row and help overlay show it. */
export function label(b: Binding): string {
  return b.keys.map((k) => k.replace(/[a-z]+$/, (name) => GLYPHS[name] ?? name)).join("/");
}
