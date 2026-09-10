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
  test("a title, then one row per binding of the screen underneath, in table order", () => {
    const state = base();
    const entries = active({ ...state, help: false });
    const g = draw(state, 30);
    const lines = rows(g);
    expect(lines[0]).toBe("keys");
    expect(g.cells[0]?.[0]?.style).toBe("title");
    entries.forEach((b, i) => {
      const line = lines[i + 1] ?? "";
      expect(line.trimStart().startsWith(label(b))).toBe(true);
      expect(line.endsWith(b.help)).toBe(true);
    });
    // The overlay covers the whole body: nothing of the list shows through below it.
    expect(lines[entries.length + 1]).toBe("");
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
    expect(lines.some((l) => l.includes("down"))).toBe(true);
    expect(lines.some((l) => l.includes("filter"))).toBe(true);
    const detail = rows(draw(base({ focus: "detail" }), 30));
    expect(detail.some((l) => l.trimStart().startsWith("q  close"))).toBe(true);
    expect(detail.some((l) => l.includes("open"))).toBe(false);
  });

  test("too short: shows what fits and says how many are hidden", () => {
    const state = base();
    const total = active({ ...state, help: false }).length;
    const g = draw(state, 3);
    const lines = rows(g);
    expect(lines[0]).toBe("keys");
    expect(lines[1]?.endsWith("quit")).toBe(true);
    expect(lines[2]).toBe(`${total - 1} more, not shown at this height`);
    expect(g.cells[2]?.[0]?.style).toBe("dim");
    expect(lines[3]).toBe("#".repeat(COLS));
  });

  test("a body with no room draws nothing", () => {
    const g = draw(base(), 0);
    expect(rows(g)).toEqual(["#".repeat(COLS)]);
  });
});
