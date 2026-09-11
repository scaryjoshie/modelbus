import { describe, expect, test } from "bun:test";
import { active, label } from "../bindings.ts";
import { Grid } from "../screen.ts";
import { initialState, type State } from "../state.ts";
import { drawHelp } from "./help.ts";

const COLS = 60;
const base = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: COLS, rows: 40 }, 0),
  help: true,
  ...extra,
});

const draw = (state: State, h: number) => {
  const g = new Grid(COLS, h + 1);
  // Something underneath, so a test can tell whether the overlay cleared it.
  for (let y = 0; y < g.rows; y++) g.put(0, y, "#".repeat(COLS));
  drawHelp(state, { x: 0, y: 0, w: COLS, h }, g);
  return g;
};
const rows = (g: Grid) => Array.from({ length: g.rows }, (_, y) => g.text(y).trimEnd());

describe("drawHelp", () => {
  test("a plain title, then one row per binding of the screen underneath, in table order", () => {
    const state = base();
    const entries = active({ ...state, help: false });
    const g = draw(state, 30);
    const lines = rows(g);
    expect(lines[0]).toBe("keys");
    expect(g.cells[0]?.[0]?.style).toBe("plain");
    entries.forEach((b, i) => {
      const line = lines[i + 1] ?? "";
      expect(line.trimStart().startsWith(label(b))).toBe(true);
      expect(line.endsWith(b.help)).toBe(true);
    });
  });

  test("covers the whole body: nothing underneath shows through, and nothing outside is touched", () => {
    const state = base();
    const entries = active({ ...state, help: false });
    const g = draw(state, 30);
    const lines = rows(g);
    for (let y = entries.length + 1; y < 30; y++) expect(lines[y]).toBe("");
    expect(lines[30]).toBe("#".repeat(COLS));
    for (let y = 0; y < 30; y++) expect(g.text(y)).not.toContain("#");
  });

  test("keys are right-aligned in one plain column; help text is dim", () => {
    const state = base();
    const entries = active({ ...state, help: false });
    const g = draw(state, 30);
    const keyW = Math.max(...entries.map((b) => label(b).length));
    entries.forEach((b, i) => {
      const line = g.text(i + 1);
      expect(line.slice(0, keyW).trimStart()).toBe(label(b));
      expect(g.cells[i + 1]?.[keyW - 1]?.style).toBe("plain");
      expect(g.cells[i + 1]?.[keyW + 2]?.style).toBe("dim");
    });
  });

  test("lists the keys of the screen underneath, not only the few that work while it is open", () => {
    const lines = rows(draw(base(), 30));
    expect(lines.some((l) => l.trimStart().startsWith("q  quit"))).toBe(true);
    expect(lines.some((l) => l.includes("↑/↓"))).toBe(true);
    expect(lines.some((l) => l.includes("filter"))).toBe(true);
    expect(lines.some((l) => l.includes("mark pending"))).toBe(true);
    expect(lines.some((l) => l.includes("esc"))).toBe(true);
    expect(lines.some((l) => l.includes("ctrl+c"))).toBe(true);
  });

  test("follows the tab: the Chats tab reads messages and does not rename or mark", () => {
    const chats = rows(draw(base({ tab: "chats" }), 30));
    expect(chats.some((l) => l.includes("read messages"))).toBe(true);
    expect(chats.some((l) => l.includes("rename"))).toBe(false);
    expect(chats.some((l) => l.includes("mark pending"))).toBe(false);
    // With the arrows already in the messages pane, Enter has nothing left to do.
    const reading = rows(draw(base({ tab: "chats", focus: "messages" }), 30));
    expect(reading.some((l) => l.includes("read messages"))).toBe(false);
  });

  test("too short: shows what fits and says how many are hidden", () => {
    const state = base();
    const total = active({ ...state, help: false }).length;
    const g = draw(state, 3);
    const lines = rows(g);
    expect(lines[0]).toBe("keys");
    expect(lines[1]?.endsWith("switch tab")).toBe(true);
    expect(lines[2]).toBe(`${total - 1} more, not shown at this height`);
    expect(g.cells[2]?.[0]?.style).toBe("dim");
    expect(lines[3]).toBe("#".repeat(COLS));
  });

  test("a body with no room draws nothing", () => {
    const g = draw(base(), 0);
    expect(rows(g)).toEqual(["#".repeat(COLS)]);
  });
});
