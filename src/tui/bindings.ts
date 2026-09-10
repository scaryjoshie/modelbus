import type { State } from "./state.ts";

/**
 * Every key the TUI answers to, in one table. `update` dispatches from it, the
 * status row shows the entries marked `hint`, and the help overlay lists all of
 * it, so the documentation cannot drift from the behavior.
 */

export type Action =
  | "quit"
  | "back"
  | "help"
  | "viewAgents"
  | "viewLog"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "top"
  | "bottom"
  | "open"
  | "focusNext"
  | "filter";

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

const listFocused = (s: State) => s.focus === "list" && !s.help;
const noOverlay = (s: State) => !s.help;

export const BINDINGS: readonly Binding[] = [
  { keys: ["q"], action: "quit", help: "quit", when: listFocused, hint: true },
  { keys: ["q"], action: "back", help: "close", when: (s) => s.help || s.focus === "detail" },
  { keys: ["ctrl+c"], action: "quit", help: "quit from anywhere" },
  { keys: ["escape"], action: "back", help: "back out one level" },
  { keys: ["?"], action: "help", help: "help", hint: true },
  { keys: ["1"], action: "viewAgents", help: "agents", when: noOverlay, hint: true },
  { keys: ["2"], action: "viewLog", help: "log", when: noOverlay, hint: true },
  { keys: ["j", "down"], action: "down", help: "down", when: noOverlay, hint: true },
  { keys: ["k", "up"], action: "up", help: "move up", when: noOverlay },
  { keys: ["pagedown", "ctrl+d"], action: "pageDown", help: "page down", when: noOverlay },
  { keys: ["pageup", "ctrl+u"], action: "pageUp", help: "page up", when: noOverlay },
  { keys: ["g", "home"], action: "top", help: "first row", when: noOverlay },
  { keys: ["G", "end"], action: "bottom", help: "last row", when: noOverlay },
  { keys: ["enter"], action: "open", help: "open", when: listFocused, hint: true },
  { keys: ["tab"], action: "focusNext", help: "pane", when: noOverlay, hint: true },
  { keys: ["/"], action: "filter", help: "filter", when: noOverlay, hint: true },
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
  pageup: "pgup",
  pagedown: "pgdn",
  home: "home",
  end: "end",
};

/** "j/↓" for a binding, the way the status row and help overlay show it. */
export function label(b: Binding): string {
  return b.keys.map((k) => k.replace(/[a-z]+$/, (name) => GLYPHS[name] ?? name)).join("/");
}
