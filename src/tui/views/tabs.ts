import { visibleAgents, visibleConversations } from "../filter.ts";
import type { Grid, Rect } from "../screen.ts";
import type { State, Tab } from "../state.ts";

/**
 * Row 0: the tab names with a count after each, the active tab in `title`, the
 * inactive one and every count in `dim`. Under a filter the active tab's count
 * reads "12/41": rows shown of rows known. Nothing else lives in this row.
 */

/** Tab names in screen order. */
const TABS: ReadonlyArray<{ tab: Tab; name: string }> = [
  { tab: "agents", name: "Agents" },
  { tab: "chats", name: "Chats" },
];

/** Cells between one tab's count and the next tab's name. */
const GAP_COLS = 2;

/** "41", or "12/41" for the active tab while a filter narrows it; nothing before the first poll. */
export function tabCount(state: State, tab: Tab): string {
  if (state.lastPollAt === undefined) return "";
  const total = tab === "agents" ? state.agents.length : state.conversations.length;
  if (tab !== state.tab || state.filter === "") return String(total);
  const shown = tab === "agents" ? visibleAgents(state).length : visibleConversations(state).length;
  return `${shown}/${total}`;
}

export function drawTabs(state: State, rect: Rect, grid: Grid): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  grid.fill(rect);
  const limit = rect.x + rect.w;
  let x = rect.x;
  for (const { tab, name } of TABS) {
    x += grid.put(x, rect.y, name, tab === state.tab ? "title" : "dim", limit - x);
    const count = tabCount(state, tab);
    if (count !== "") x += grid.put(x, rect.y, ` ${count}`, "dim", limit - x);
    x += GAP_COLS;
  }
}
