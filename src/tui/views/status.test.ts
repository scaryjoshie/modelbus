import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { type Agent, initialState, type State } from "../state.ts";
import { clock } from "../text.ts";
import { drawStatus } from "./status.ts";

const agent = (name: string, host = "h"): Agent => ({
  id: name,
  name,
  host,
  lastSeen: 0,
  reachable: true,
});

const COLS = 120;
const rect = { x: 0, y: 0, w: COLS, h: 1 };

const base = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: COLS, rows: 10 }, 0),
  agents: [agent("alpha"), agent("beta"), agent("gamma")],
  ...extra,
});

const draw = (state: State, w = COLS) => {
  const g = new Grid(w, 1);
  drawStatus(state, { ...rect, w }, g);
  return g;
};
const styleAt = (g: Grid, x: number) => g.cells[0]?.[x]?.style;

describe("drawStatus", () => {
  test("hints for the list: key plain, label dim, two spaces between", () => {
    const g = draw(base());
    const text = g.text(0);
    expect(text.startsWith("q quit  ? help  1 agents  2 log  j/↓ down")).toBe(true);
    expect(styleAt(g, 0)).toBe("plain");
    expect(styleAt(g, 2)).toBe("dim");
    expect(styleAt(g, 6)).toBe("plain");
  });

  test("hints follow the focus: no quit while the detail pane has focus", () => {
    const text = draw(base({ focus: "detail" })).text(0);
    expect(text.startsWith("? help")).toBe(true);
    expect(text).not.toContain("q quit");
  });

  test("hints are dropped whole when the row is too narrow", () => {
    const text = draw(base(), 15).text(0).trimEnd();
    expect(text).toBe("q quit  ? help");
  });

  test("the last good poll shows as a clock on the right", () => {
    const at = Date.UTC(2026, 8, 10, 12, 34, 56);
    const g = draw(base({ lastPollAt: at }));
    expect(g.text(0).endsWith(clock(at))).toBe(true);
    expect(styleAt(g, COLS - 1)).toBe("dim");
    expect(draw(base()).text(0).trimEnd().endsWith("/ filter")).toBe(true);
  });

  test("a filter adds the count for the current view", () => {
    expect(
      draw(base({ filter: "a" }))
        .text(0)
        .endsWith("3 of 3"),
    ).toBe(true);
    expect(
      draw(base({ filter: "et" }))
        .text(0)
        .endsWith("1 of 3"),
    ).toBe(true);
    expect(
      draw(base({ filter: "zz", view: "log" }))
        .text(0)
        .endsWith("0 of 0"),
    ).toBe(true);
    expect(draw(base()).text(0)).not.toContain(" of ");
  });

  test("the filter box takes the row as a prompt with the count", () => {
    const g = draw(base({ focus: "filter", filter: "be", lastPollAt: 0 }));
    const text = g.text(0);
    expect(text.startsWith("/be▏")).toBe(true);
    expect(text).not.toContain("quit");
    expect(text.trimEnd().endsWith(`1 of 3  ${clock(0)}`)).toBe(true);
    expect(
      draw(base({ focus: "filter" }))
        .text(0)
        .startsWith("/▏"),
    ).toBe(true);
    expect(
      draw(base({ focus: "filter" }))
        .text(0)
        .endsWith("3 of 3"),
    ).toBe(true);
  });

  test("an error replaces the hints in bad and keeps the socket path", () => {
    const error = "modelbus is not running (/tmp/mb/daemon.sock); start it with: modelbus start";
    const g = draw(base({ error, lastPollAt: 0 }));
    expect(g.text(0).startsWith(error)).toBe(true);
    expect(g.text(0)).toContain("/tmp/mb/daemon.sock");
    expect(g.text(0).endsWith(clock(0))).toBe(true);
    expect(styleAt(g, 0)).toBe("bad");
    expect(g.text(0)).not.toContain("quit");
  });

  test("a long error is truncated short of the clock", () => {
    const g = draw(base({ error: "x".repeat(200), lastPollAt: 0 }), 40);
    const text = g.text(0);
    expect(text).toHaveLength(40);
    expect(text.endsWith(`  ${clock(0)}`)).toBe(true);
    expect(text).toContain("…");
  });

  test("a rect with no room draws nothing", () => {
    const g = new Grid(10, 1);
    drawStatus(base(), { x: 0, y: 0, w: 0, h: 1 }, g);
    expect(g.text(0).trim()).toBe("");
  });
});
