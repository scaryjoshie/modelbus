import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import { type Agent, initialState, type State } from "../state.ts";
import type { Style } from "../style.ts";
import { columns, drawAgents } from "./agents.ts";

const MINUTE_MS = 60_000;
const NOW = 100 * MINUTE_MS;

const agent = (name: string, host: string, extra: Partial<Agent> = {}): Agent => ({
  id: `id-${name}`,
  name,
  host,
  lastSeen: NOW - 5 * MINUTE_MS,
  reachable: true,
  ...extra,
});

const roster = [
  agent("planner", "north-shell", { status: "idle" }),
  agent("tester", "zephyr", { reachable: false, note: "no window", status: "busy" }),
  agent("writer", "apex"),
];

const stateWith = (
  agents: Agent[],
  extra: Partial<State> = {},
  selected: string | undefined = agents[0]?.id,
): State => ({
  ...initialState({ cols: 80, rows: 24 }, NOW),
  agents,
  selectedAgentId: selected,
  ...extra,
});

/** Draw into a grid exactly the pane's size; a wider grid would hide overruns. */
function draw(state: State, w: number, h: number, x = 0, y = 0): { grid: Grid; rect: Rect } {
  const grid = new Grid(x + w, y + h);
  const rect = { x, y, w, h };
  drawAgents(state, rect, grid);
  return { grid, rect };
}

const styles = (grid: Grid, y: number): Style[] => (grid.cells[y] ?? []).map((c) => c.style);
const styleAt = (grid: Grid, x: number, y: number): Style | undefined => grid.cells[y]?.[x]?.style;

describe("drawAgents", () => {
  test("title on row 0, bold only while the list has focus", () => {
    const { grid } = draw(stateWith(roster), 60, 6);
    expect(grid.text(0).trimEnd()).toBe("agents");
    expect(styleAt(grid, 0, 0)).toBe("title");
    const blurred = draw(stateWith(roster, { focus: "detail" }), 60, 6).grid;
    expect(styleAt(blurred, 0, 0)).toBe("plain");
  });

  test("one row per agent in host-then-name order, starting under the title", () => {
    const { grid } = draw(stateWith(roster), 60, 6, 2, 1);
    expect(grid.text(1).trimEnd()).toBe("  agents");
    expect(grid.text(2)).toMatch(/^ {2}writer\s+apex\s+up\s+5m$/);
    expect(grid.text(3)).toMatch(/^ {2}planner\s+north-shell\s+up\s+idle\s+5m$/);
    expect(grid.text(4)).toMatch(/^ {2}tester\s+zephyr\s+down\s+busy\s+5m$/);
    expect(grid.text(5).trim()).toBe("");
  });

  test("ages sit at the right edge of the age column, dim", () => {
    const { grid } = draw(stateWith(roster), 60, 6);
    const row = grid.text(1);
    expect(row.endsWith("5m")).toBe(true);
    expect(styleAt(grid, row.length - 1, 1)).toBe("dim");
    expect(styleAt(grid, row.length - 3, 1)).toBe("dim");
  });

  test("reachability is ok or bad; the selected row is inverse across the whole pane", () => {
    const s = stateWith(roster, {}, "id-tester");
    const { grid } = draw(s, 60, 6);
    expect(styleAt(grid, grid.text(2).indexOf("up"), 2)).toBe("ok");
    expect(new Set(styles(grid, 3))).toEqual(new Set(["selected"]));
    expect(grid.text(3)).toMatch(/^tester\s+zephyr\s+down/);
    const blurred = draw({ ...s, focus: "detail" }, 60, 6).grid;
    expect(new Set(styles(blurred, 3))).toEqual(new Set(["selected"]));
    const unselected = draw(stateWith(roster, {}, "id-planner"), 60, 6).grid;
    expect(styleAt(unselected, grid.text(3).indexOf("down"), 3)).toBe("bad");
  });

  test("rows start at the scroll offset and stop at the pane's bottom", () => {
    const many = Array.from({ length: 10 }, (_, i) => agent(`a${i}`, "h"));
    const s = stateWith(many, { scroll: { agents: 4, log: 0, detail: 0 } }, "id-a5");
    const { grid } = draw(s, 40, 4);
    expect(grid.text(1)).toMatch(/^a4\b/);
    expect(grid.text(2)).toMatch(/^a5\b/);
    expect(styleAt(grid, 0, 2)).toBe("selected");
    expect(grid.text(3)).toMatch(/^a6\b/);
    expect(grid.rows).toBe(4);
  });

  test("narrow panes drop the age, then the status, and truncate names with an ellipsis", () => {
    const rows = [agent("a-very-long-agent-name-indeed", "north-shell", { status: "idle" })];
    const wide = columns(60, rows);
    expect(wide).toEqual({
      name: 60 - (11 + 4 + 4 + 4) - 4 * 2,
      host: 11,
      reach: 4,
      status: 4,
      age: 4,
    });
    // Host, reach, status and age with their gaps take 31 cells; the name needs 10 more.
    const noAge = columns(36, rows);
    expect(noAge).toEqual({ name: 11, host: 11, reach: 4, status: 4, age: 0 });
    const noStatus = columns(30, rows);
    expect(noStatus).toEqual({ name: 11, host: 11, reach: 4, status: 0, age: 0 });
    const tiny = columns(12, rows);
    expect(tiny).toEqual({ name: 6, host: 0, reach: 4, status: 0, age: 0 });

    const { grid } = draw(stateWith(rows), 30, 3);
    expect(grid.text(1).trimEnd()).toBe("a-very-lon…  north-shell  up");
    expect(grid.text(1).length).toBe(30);
  });

  test("an unreachable agent shows its note only when names keep their room", () => {
    const rows = [
      agent("planner", "north-shell"),
      agent("tester", "zephyr", { reachable: false, note: "no window" }),
    ];
    const roomy = draw(stateWith(rows), 70, 4).grid;
    expect(roomy.text(2)).toMatch(/down no window/);
    expect(columns(70, rows).reach).toBe("down no window".length);
    const cramped = draw(stateWith(rows), 40, 4).grid;
    expect(cramped.text(2)).toMatch(/down\s/);
    expect(cramped.text(2)).not.toMatch(/no window/);
  });

  test("a filter puts the count at the right edge of the title row", () => {
    const s = stateWith(roster, { filter: "TER" });
    const { grid } = draw(s, 40, 6);
    expect(grid.text(0)).toBe(`agents${" ".repeat(40 - 6 - 6)}2 of 3`);
    expect(styleAt(grid, 39, 0)).toBe("dim");
    expect(styleAt(grid, 0, 0)).toBe("title");
    expect(grid.text(1)).toMatch(/^writer/);
    expect(grid.text(2)).toMatch(/^tester/);
    expect(draw(stateWith(roster), 40, 6).grid.text(0).trimEnd()).toBe("agents");
  });

  test("empty states tell no agents apart from no match", () => {
    // `drawEmpty` places its lines inside the body; where exactly is its call.
    const body = (grid: Grid) => Array.from({ length: grid.rows - 1 }, (_, y) => grid.text(y + 1));
    // Before any poll has succeeded an empty list says nothing about the bus.
    const unknown = draw(stateWith([], {}, undefined), 60, 5).grid;
    expect(body(unknown).join("\n")).toMatch(/waiting for the daemon/);
    expect(body(unknown).join("\n")).not.toMatch(/modelbus register/);
    const none = draw(stateWith([], { lastPollAt: NOW }, undefined), 60, 5).grid;
    expect(none.text(0).trimEnd()).toBe("agents");
    expect(body(none).join("\n")).toMatch(/no agents/);
    expect(body(none).join("\n")).toMatch(/modelbus register/);
    const noMatch = draw(stateWith(roster, { filter: "zzz" }), 60, 5).grid;
    expect(noMatch.text(0)).toMatch(/0 of 3$/);
    expect(body(noMatch).join("\n")).toMatch(/nothing matches/);
    expect(body(noMatch).join("\n")).not.toMatch(/modelbus register/);
  });
});
