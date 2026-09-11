import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import { type Agent, initialState, type State } from "../state.ts";
import { hostStyle, type Style } from "../style.ts";
import { columns, drawAgents, PENDING_MARK } from "./agents.ts";

const MINUTE_MS = 60_000;
const NOW = 100 * MINUTE_MS;

const agent = (name: string, host: string, extra: Partial<Agent> = {}): Agent => ({
  id: `id-${name}`,
  name,
  host,
  cwd: `/home/someone/work/${name}`,
  lastSeen: NOW - 5 * MINUTE_MS,
  reachable: true,
  ...extra,
});

/** Listed by host then name: writer (apex), planner (north-shell), tester (zephyr). */
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
/** Style of the cell where `word` starts on row `y`. */
const styleOf = (grid: Grid, word: string, y: number): Style | undefined => {
  const x = grid.text(y).indexOf(word);
  expect(x).toBeGreaterThanOrEqual(0);
  return styleAt(grid, x, y);
};

describe("drawAgents", () => {
  test("title on row 0, plain: no pane has focus, only the active tab is bold", () => {
    const { grid } = draw(stateWith(roster), 60, 6);
    expect(grid.text(0).trimEnd()).toBe("agents");
    expect(styleAt(grid, 0, 0)).toBe("plain");
  });

  test("one row per agent in host-then-name order, under the title, after the mark column", () => {
    const { grid } = draw(stateWith(roster), 60, 6, 2, 1);
    expect(grid.text(1).trimEnd()).toBe("  agents");
    expect(grid.text(2)).toMatch(/^ {4}writer\s+apex\s+up\s+5m$/);
    expect(grid.text(3)).toMatch(/^ {4}planner\s+north-shell\s+up\s+idle\s+5m$/);
    expect(grid.text(4)).toMatch(/^ {4}tester\s+zephyr\s+down\s+busy\s+5m$/);
    expect(grid.text(5).trim()).toBe("");
    // Every row fills the pane's width and none spills past it.
    for (const y of [2, 3, 4]) expect(grid.text(y).length).toBe(62);
  });

  test("a name and its host tag share the host's hue; the hue comes from the host, not the id", () => {
    const { grid } = draw(stateWith(roster, { selectedAgentId: undefined }), 60, 6);
    expect(styleOf(grid, "writer", 1)).toBe(hostStyle(roster, "apex"));
    expect(styleOf(grid, "apex", 1)).toBe(hostStyle(roster, "apex"));
    expect(styleOf(grid, "planner", 2)).toBe(hostStyle(roster, "north-shell"));
    expect(styleOf(grid, "north-shell", 2)).toBe(hostStyle(roster, "north-shell"));
    expect(styleOf(grid, "tester", 3)).toBe(hostStyle(roster, "zephyr"));
    expect(styleOf(grid, "zephyr", 3)).toBe(hostStyle(roster, "zephyr"));
    expect(styleOf(grid, "idle", 2)).toBe("plain");
  });

  test("ages sit at the right edge of the age column, dim", () => {
    const { grid } = draw(stateWith(roster), 60, 6);
    const row = grid.text(1);
    expect(row.endsWith("5m")).toBe(true);
    expect(styleAt(grid, row.length - 1, 1)).toBe("dim");
    expect(styleAt(grid, row.length - 3, 1)).toBe("dim");
  });

  test("reachability is ok or bad", () => {
    const { grid } = draw(stateWith(roster, { selectedAgentId: undefined }), 60, 6);
    expect(styleOf(grid, "up", 1)).toBe("ok");
    expect(styleOf(grid, "down", 3)).toBe("bad");
  });

  test("the selected row is inverse across the whole pane, every cell", () => {
    const { grid } = draw(stateWith(roster, {}, "id-tester"), 60, 6);
    expect(new Set(styles(grid, 3))).toEqual(new Set(["selected"]));
    expect(grid.text(3)).toMatch(/^ {2}tester\s+zephyr\s+down/);
    expect(styles(grid, 2)).not.toContain("selected");
  });

  test("a pending agent carries the mark in accent at the row's left; others leave the cell blank", () => {
    const s = stateWith(roster, {
      pending: ["id-tester", "id-writer"],
      selectedAgentId: undefined,
    });
    const { grid } = draw(s, 60, 6);
    expect(grid.text(1).startsWith(`${PENDING_MARK} writer`)).toBe(true);
    expect(styleAt(grid, 0, 1)).toBe("accent");
    expect(grid.text(3).startsWith(`${PENDING_MARK} tester`)).toBe(true);
    expect(styleAt(grid, 0, 3)).toBe("accent");
    // The unmarked row keeps the column so its name lines up with the marked ones.
    expect(grid.text(2).startsWith("  planner")).toBe(true);
    expect(styleAt(grid, 0, 2)).toBe("plain");
    expect(styles(grid, 2)).not.toContain("accent");
  });

  test("a pending row under the cursor is inverse, mark included", () => {
    const s = stateWith(roster, { pending: ["id-tester"] }, "id-tester");
    const { grid } = draw(s, 60, 6);
    expect(grid.text(3).startsWith(`${PENDING_MARK} tester`)).toBe(true);
    expect(new Set(styles(grid, 3))).toEqual(new Set(["selected"]));
  });

  test("rows start at the scroll offset and stop at the pane's bottom", () => {
    const many = Array.from({ length: 10 }, (_, i) => agent(`a${i}`, "h"));
    const s = stateWith(many, { scroll: { agents: 4, chats: 0, messages: 0 } }, "id-a5");
    const { grid } = draw(s, 40, 4);
    expect(grid.text(1)).toMatch(/^ {2}a4\b/);
    expect(grid.text(2)).toMatch(/^ {2}a5\b/);
    expect(styleAt(grid, 0, 2)).toBe("selected");
    expect(grid.text(3)).toMatch(/^ {2}a6\b/);
    expect(grid.rows).toBe(4);
  });

  test("column widths come from the whole list, so scrolling shifts nothing", () => {
    const many = [
      ...Array.from({ length: 6 }, (_, i) => agent(`a${i}`, "h")),
      agent("z-with-a-far-longer-name", "h", { status: "thinking" }),
    ];
    const top = draw(stateWith(many, { scroll: { agents: 0, chats: 0, messages: 0 } }), 50, 4).grid;
    const scrolled = draw(
      stateWith(many, { scroll: { agents: 3, chats: 0, messages: 0 } }),
      50,
      4,
    ).grid;
    expect(top.text(1).indexOf("up")).toBe(scrolled.text(1).indexOf("up"));
    expect(top.text(1).indexOf("h ")).toBe(scrolled.text(1).indexOf("h "));
  });

  test("narrow panes drop the age, then the status, then the host, and truncate names", () => {
    const rows = [agent("a-very-long-agent-name-indeed", "north-shell", { status: "idle" })];
    // The mark column takes 2; host, reach, status and age with their gaps take 31 more.
    const wide = columns(60, rows);
    expect(wide).toEqual({ name: 60 - 2 - 31, host: 11, reach: 4, status: 4, age: 4 });
    // Under 10 cells of name the rightmost remaining column goes, one at a time.
    expect(columns(38, rows)).toEqual({ name: 11, host: 11, reach: 4, status: 4, age: 0 });
    expect(columns(32, rows)).toEqual({ name: 11, host: 11, reach: 4, status: 0, age: 0 });
    expect(columns(12, rows)).toEqual({ name: 4, host: 0, reach: 4, status: 0, age: 0 });

    const { grid } = draw(stateWith(rows), 32, 3);
    expect(grid.text(1).trimEnd()).toBe("  a-very-lon…  north-shell  up");
    expect(grid.text(1).length).toBe(32);
    expect(styleAt(grid, 2, 1)).toBe("selected");
  });

  test("an unreachable agent shows its note only when names keep their room", () => {
    const rows = [
      agent("planner", "north-shell"),
      agent("tester", "zephyr", { reachable: false, note: "no window" }),
    ];
    const roomy = draw(stateWith(rows, { selectedAgentId: undefined }), 70, 4).grid;
    expect(roomy.text(2)).toMatch(/down no window/);
    expect(styleOf(roomy, "no window", 2)).toBe("bad");
    expect(columns(70, rows).reach).toBe("down no window".length);
    const cramped = draw(stateWith(rows), 40, 4).grid;
    expect(cramped.text(2)).toMatch(/down\s/);
    expect(cramped.text(2)).not.toMatch(/no window/);
  });

  test("a filter narrows the rows; the count lives in the tab row, not the title", () => {
    const s = stateWith(roster, { filter: "TER" });
    const { grid } = draw(s, 40, 6);
    expect(grid.text(0).trimEnd()).toBe("agents");
    expect(styleAt(grid, 0, 0)).toBe("plain");
    expect(grid.text(1)).toMatch(/^ {2}writer/);
    expect(grid.text(2)).toMatch(/^ {2}tester/);
    expect(grid.text(3).trim()).toBe("");
    expect(draw(stateWith(roster), 40, 6).grid.text(0).trimEnd()).toBe("agents");
  });

  test("empty states tell no data, no agents and no match apart", () => {
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
    expect(noMatch.text(0).trimEnd()).toBe("agents");
    expect(body(noMatch).join("\n")).toMatch(/nothing matches/);
    expect(body(noMatch).join("\n")).not.toMatch(/modelbus register/);
  });

  test("nothing is drawn outside the rect: a one-row pane is its title only", () => {
    const grid = new Grid(40, 3);
    drawAgents(stateWith(roster), { x: 0, y: 0, w: 40, h: 1 }, grid);
    expect(grid.text(0).trimEnd()).toBe("agents");
    expect(grid.text(1).trim()).toBe("");
    drawAgents(stateWith(roster), { x: 0, y: 2, w: 40, h: 0 }, grid);
    expect(grid.text(2).trim()).toBe("");
  });
});
