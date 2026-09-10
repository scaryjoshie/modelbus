import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { drawEmpty, EMPTY, REGISTER_HINT } from "./empty.ts";

const rows = (g: Grid) => Array.from({ length: g.rows }, (_, y) => g.text(y).trimEnd());

describe("drawEmpty", () => {
  test("one dim line, centered vertically in the rect", () => {
    const g = new Grid(30, 7);
    drawEmpty({ x: 0, y: 1, w: 30, h: 5 }, g, EMPTY.noMessages);
    expect(rows(g)).toEqual(["", "", "", "no messages", "", "", ""]);
    expect(g.cells[3]?.[0]?.style).toBe("dim");
  });

  test("the register command follows the no-agents line", () => {
    const g = new Grid(40, 6);
    drawEmpty({ x: 2, y: 0, w: 38, h: 6 }, g, EMPTY.noAgents, REGISTER_HINT);
    expect(rows(g)).toEqual(["", "", "  no agents on the bus", `  ${REGISTER_HINT}`, "", ""]);
  });

  test("every reason fits on one line and is dim", () => {
    for (const message of Object.values(EMPTY)) {
      const g = new Grid(40, 1);
      drawEmpty({ x: 0, y: 0, w: 40, h: 1 }, g, message);
      expect(g.text(0).trimEnd()).toBe(message);
      expect(g.cells[0]?.[0]?.style).toBe("dim");
    }
  });

  test("a single row shows the message and drops the hint; nothing draws outside the rect", () => {
    const g = new Grid(10, 3);
    drawEmpty({ x: 0, y: 1, w: 10, h: 1 }, g, EMPTY.noAgents, REGISTER_HINT);
    expect(rows(g)).toEqual(["", "no agents…", ""]);
    drawEmpty({ x: 0, y: 0, w: 10, h: 0 }, g, "unseen");
    expect(rows(g)).toEqual(["", "no agents…", ""]);
  });
});
