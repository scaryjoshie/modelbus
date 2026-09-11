import type { Rect } from "./screen.ts";

/**
 * Where each region goes for a terminal size. A tab row, two panes and a
 * status row need no layout engine. `update` uses the same numbers as the
 * views so it can keep the selection on screen.
 */

export interface Size {
  cols: number;
  rows: number;
}

export interface Layout {
  /** Row 0: the tab bar. */
  tabs: Rect;
  /** The roster or the conversation list, with its title line. */
  list: Rect;
  /** The selected agent's fields, or the selected conversation's messages. */
  detail: Rect;
  /** The bottom row: key hints, poll time, errors, or a prompt. */
  status: Rect;
  /** Everything between the tabs and the status row; what the help overlay covers. */
  body: Rect;
}

/** Below this width the detail pane goes under the list instead of beside it. */
const SIDE_BY_SIDE_MIN_COLS = 110;
/** The list's share of the split, whichever way it goes. */
const LIST_SHARE = 0.6;
/** Every pane spends its first row on a title. */
export const TITLE_ROWS = 1;
/** The tab bar is one row. */
export const TAB_ROWS = 1;

export function layout(size: Size): Layout {
  const cols = Math.max(1, size.cols);
  const rows = Math.max(TAB_ROWS + 2, size.rows);
  const tabs: Rect = { x: 0, y: 0, w: cols, h: TAB_ROWS };
  const body: Rect = { x: 0, y: TAB_ROWS, w: cols, h: rows - TAB_ROWS - 1 };
  const status: Rect = { x: 0, y: rows - 1, w: cols, h: 1 };
  if (cols >= SIDE_BY_SIDE_MIN_COLS) {
    const listW = Math.floor(cols * LIST_SHARE);
    return {
      tabs,
      body,
      status,
      list: { x: 0, y: body.y, w: listW, h: body.h },
      detail: { x: listW + 1, y: body.y, w: cols - listW - 1, h: body.h },
    };
  }
  const listH = Math.max(TITLE_ROWS + 1, Math.ceil(body.h * LIST_SHARE));
  return {
    tabs,
    body,
    status,
    list: { x: 0, y: body.y, w: cols, h: listH },
    detail: { x: 0, y: body.y + listH, w: cols, h: Math.max(0, body.h - listH) },
  };
}

/** Rows a pane has for items after its title. */
export const bodyRows = (r: Rect): number => Math.max(1, r.h - TITLE_ROWS);
