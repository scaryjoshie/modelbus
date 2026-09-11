import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { initialState, type Prompt, type State } from "../state.ts";
import { drawPrompt, tail } from "./prompt.ts";

const COLS = 30;
const base = (prompt: Prompt | undefined): State => ({
  ...initialState({ cols: COLS, rows: 10 }, 0),
  prompt,
});

const draw = (prompt: Prompt | undefined, w = COLS) => {
  const g = new Grid(w, 1);
  g.put(0, 0, "#".repeat(w));
  drawPrompt(base(prompt), { x: 0, y: 0, w, h: 1 }, g);
  return g;
};
const styleAt = (g: Grid, x: number) => g.cells[0]?.[x]?.style;

describe("tail", () => {
  test("keeps a string that fits, cuts the start of one that does not", () => {
    expect(tail("abc", 3)).toBe("abc");
    expect(tail("abcdef", 4)).toBe("…def");
    expect(tail("abcdef", 1)).toBe("…");
    expect(tail("abcdef", 0)).toBe("");
  });

  test("measures in cells: a wide character is never split", () => {
    // Two cells for content at width 3: the wide character is dropped whole, not halved.
    expect(tail("a漢字b", 3)).toBe("…b");
    expect(tail("a漢字b", 4)).toBe("…字b");
    expect(tail("a漢字b", 6)).toBe("a漢字b");
  });
});

describe("drawPrompt", () => {
  test("label dim, text plain, one selected cursor cell after it", () => {
    const g = draw({ kind: "filter", text: "ab" });
    expect(g.text(0)).toBe(`filter: ab ${" ".repeat(COLS - 11)}`);
    expect(styleAt(g, 0)).toBe("dim");
    expect(styleAt(g, 7)).toBe("dim");
    expect(styleAt(g, 8)).toBe("plain");
    expect(styleAt(g, 9)).toBe("plain");
    expect(styleAt(g, 10)).toBe("selected");
    expect(styleAt(g, 11)).toBe("plain");
  });

  test("each prompt kind has its label", () => {
    expect(draw({ kind: "filter", text: "" }).text(0).trimEnd()).toBe("filter:");
    expect(
      draw({ kind: "group", text: "", members: ["a", "b", "c"] })
        .text(0)
        .trimEnd(),
    ).toBe("group name:");
    expect(draw({ kind: "rename", text: "", agent: "beta" }).text(0).trimEnd()).toBe(
      "rename beta:",
    );
  });

  test("an empty text puts the cursor right after the label", () => {
    const g = draw({ kind: "filter", text: "" });
    expect(styleAt(g, 8)).toBe("selected");
    expect(styleAt(g, 9)).toBe("plain");
  });

  test("text wider than the row is cut from the left so the end stays visible", () => {
    const g = draw({ kind: "filter", text: "0123456789abcdefghijklmnopqrstuvwxyz" });
    // 30 cells: "filter: " (8), then 21 cells of text ending at the newest character, then the cursor.
    expect(g.text(0)).toBe("filter: …ghijklmnopqrstuvwxyz ");
    expect(styleAt(g, 8)).toBe("plain");
    expect(styleAt(g, COLS - 1)).toBe("selected");
  });

  test("a row narrower than the label truncates the label and drops the text", () => {
    const g = draw({ kind: "rename", text: "x", agent: "somebody" }, 8);
    expect(g.text(0)).toBe("rename …");
    expect(g.cells[0]?.every((c) => c.style === "dim")).toBe(true);
  });

  test("draws nothing without a prompt or without room", () => {
    expect(draw(undefined).text(0)).toBe("#".repeat(COLS));
    const g = new Grid(10, 1);
    g.put(0, 0, "#".repeat(10));
    drawPrompt(base({ kind: "filter", text: "a" }), { x: 0, y: 0, w: 0, h: 1 }, g);
    expect(g.text(0)).toBe("#".repeat(10));
  });
});
