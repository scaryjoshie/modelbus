import { layout } from "./layout.ts";
import { Grid } from "./screen.ts";
import type { State } from "./state.ts";
import { drawAgents } from "./views/agents.ts";
import { drawDetail } from "./views/detail.ts";
import { drawHelp } from "./views/help.ts";
import { drawLog } from "./views/log.ts";
import { drawStatus } from "./views/status.ts";

/** One frame: every region drawn into a fresh grid. Pure; nothing here touches the terminal. */
export function view(state: State): Grid {
  const grid = new Grid(state.size.cols, state.size.rows);
  const rects = layout(state.size);
  (state.view === "agents" ? drawAgents : drawLog)(state, rects.list, grid);
  drawDetail(state, rects.detail, grid);
  drawStatus(state, rects.status, grid);
  if (state.help) drawHelp(state, rects.body, grid);
  return grid;
}
