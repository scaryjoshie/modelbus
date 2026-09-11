import type { Grid, Rect } from "../screen.ts";
import { truncate } from "../text.ts";

/**
 * A region with nothing to list: one dim line saying so, centered vertically,
 * and under it, when there is one, the command that would change that.
 * The list and detail views call this with one of the texts below.
 */

/** The one way to put an agent on an empty bus. */
export const REGISTER_HINT = "modelbus register --name <name>";

export const EMPTY = {
  /** Nothing has been learned yet: no poll has succeeded. */
  noData: "waiting for the daemon",
  noAgents: "no agents on the bus",
  noMatch: "nothing matches the filter",
  noChats: "no chats yet",
  /** A conversation is selected and its page has not arrived. */
  loading: "loading",
  noMessages: "no messages yet",
  nothingSelected: "nothing selected",
} as const;

export function drawEmpty(rect: Rect, grid: Grid, message: string, hint?: string): void {
  if (rect.h <= 0 || rect.w <= 0) return;
  const lines = hint === undefined ? 1 : 2;
  // Center the block; when the rect is a single row the hint is what gets cut.
  const top = rect.y + Math.max(0, Math.floor((rect.h - lines) / 2));
  grid.put(rect.x, top, truncate(message, rect.w), "dim", rect.w);
  if (hint !== undefined && top + 1 < rect.y + rect.h)
    grid.put(rect.x, top + 1, truncate(hint, rect.w), "dim", rect.w);
}
