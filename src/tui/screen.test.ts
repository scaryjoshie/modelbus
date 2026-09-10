import { describe, expect, test } from "bun:test";
import { Grid, render } from "./screen.ts";

describe("Grid", () => {
  test("put clips to the grid and to maxWidth", () => {
    const g = new Grid(5, 1);
    expect(g.put(3, 0, "abcdef")).toBe(2);
    expect(g.text(0)).toBe("   ab");
    g.put(0, 0, "xyz", "plain", 2);
    expect(g.text(0)).toBe("xy ab");
    expect(g.put(0, 5, "off")).toBe(0);
  });

  test("wide characters take two cells and never straddle the edge", () => {
    const g = new Grid(3, 1);
    expect(g.put(0, 0, "a漢字")).toBe(3);
    expect(g.text(0)).toBe("a漢");
    expect(g.cells[0]?.[2]?.ch).toBe("");
  });

  test("fill sets a style on a rectangle", () => {
    const g = new Grid(4, 2);
    g.fill({ x: 1, y: 1, w: 2, h: 1 }, "selected");
    expect(g.cells[1]?.map((c) => c.style)).toEqual(["plain", "selected", "selected", "plain"]);
  });
});

describe("render", () => {
  test("first frame writes every row inside synchronized output", () => {
    const g = new Grid(3, 2);
    g.put(0, 0, "ab");
    const out = render(undefined, g, "none");
    expect(out).toBe("\x1b[?2026h\x1b[1;1Hab \x1b[2;1H   \x1b[?2026l");
  });

  test("only changed rows are written; nothing when equal", () => {
    const a = new Grid(3, 3);
    const b = new Grid(3, 3);
    b.put(0, 2, "z");
    expect(render(a, b, "none")).toBe("\x1b[?2026h\x1b[3;1Hz  \x1b[?2026l");
    expect(render(b, b, "none")).toBe("");
  });

  test("a size change rewrites everything", () => {
    const a = new Grid(2, 1);
    const b = new Grid(3, 1);
    expect(render(a, b, "none")).toContain("\x1b[1;1H");
  });

  test("styles open where they change and close at the end of the row", () => {
    const g = new Grid(4, 1);
    g.put(0, 0, "ab", "ok");
    g.put(2, 0, "c", "bad");
    const out = render(undefined, g, "16");
    expect(out).toContain("\x1b[32mab\x1b[0m\x1b[31mc\x1b[0m ");
    expect(render(undefined, g, "none")).not.toContain("\x1b[32m");
  });
});
