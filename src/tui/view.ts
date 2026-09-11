import { layout } from "./layout.ts";
import { Grid } from "./screen.ts";
import type { State } from "./state.ts";
import { drawAgents } from "./views/agents.ts";
import { drawChat } from "./views/chat.ts";
import { drawChats } from "./views/chats.ts";
import { drawDetail } from "./views/detail.ts";
import { drawHelp } from "./views/help.ts";
import { drawPrompt } from "./views/prompt.ts";
import { drawStatus } from "./views/status.ts";
import { drawTabs } from "./views/tabs.ts";

/** One frame: every region drawn into a fresh grid. Pure; nothing here touches the terminal. */
export function view(state: State): Grid {
  const grid = new Grid(state.size.cols, state.size.rows);
  const rects = layout(state.size);
  drawTabs(state, rects.tabs, grid);
  // The two tabs share one shape: a list on the left, what it selects on the right.
  (state.tab === "agents" ? drawAgents : drawChats)(state, rects.list, grid);
  (state.tab === "agents" ? drawDetail : drawChat)(state, rects.detail, grid);
  (state.prompt ? drawPrompt : drawStatus)(state, rects.status, grid);
  if (state.help) drawHelp(state, rects.body, grid);
  return grid;
}
