import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { providerStyle } from "../style.ts";
import { type Line, lineWidth, memberLine, nameStyle, putLine, truncateLine } from "./spans.ts";

const line: Line = [
  { text: "ada", style: "provider0" },
  { text: ", ", style: "dim" },
  { text: "bo", style: "provider1" },
];

describe("truncateLine", () => {
  test("a line that fits is returned as is", () => {
    expect(lineWidth(line)).toBe(7);
    expect(truncateLine(line, 7)).toBe(line);
  });

  test("a cut line keeps whole spans and ends the cut one with an ellipsis in its style", () => {
    expect(truncateLine(line, 6)).toEqual([
      { text: "ada", style: "provider0" },
      { text: ", ", style: "dim" },
      { text: "…", style: "provider1" },
    ]);
    expect(truncateLine(line, 4)).toEqual([
      { text: "ada", style: "provider0" },
      { text: "…", style: "dim" },
    ]);
    expect(truncateLine(line, 2)).toEqual([{ text: "a…", style: "provider0" }]);
    expect(truncateLine(line, 1)).toEqual([{ text: "…", style: "provider0" }]);
    expect(truncateLine(line, 0)).toEqual([]);
  });

  test("wide characters are never split by the cut", () => {
    const cjk: Line = [{ text: "漢字漢", style: "plain" }];
    expect(truncateLine(cjk, 4)).toEqual([{ text: "漢…", style: "plain" }]);
    expect(truncateLine(cjk, 5)).toEqual([{ text: "漢字…", style: "plain" }]);
  });
});

describe("putLine", () => {
  test("draws each span in its style and stops at the width", () => {
    const g = new Grid(10, 1);
    expect(putLine(g, 1, 0, line, 9)).toBe(7);
    expect(g.text(0)).toBe(" ada, bo  ");
    expect(g.cells[0]?.[1]?.style).toBe("provider0");
    expect(g.cells[0]?.[4]?.style).toBe("dim");
    expect(g.cells[0]?.[6]?.style).toBe("provider1");
    expect(g.cells[0]?.[8]?.style).toBe("plain");
  });

  test("an override paints every cell in one style", () => {
    const g = new Grid(10, 1);
    putLine(g, 0, 0, line, 5, "selected");
    expect(g.text(0)).toBe("ada,…     ");
    for (let x = 0; x < 5; x++) expect(g.cells[0]?.[x]?.style).toBe("selected");
  });
});

describe("memberLine and nameStyle", () => {
  const members = [
    { id: "id-ada", name: "ada" },
    { id: "id-bo", name: "bo" },
    { id: "id-cy", name: "cy" },
  ];
  const roster = [
    { id: "id-ada", provider: "north-shell" },
    { id: "id-bo", provider: "zephyr" },
  ];

  test("names take their host's hue from the roster, plain off it, a dim comma between", () => {
    expect(memberLine(members, roster)).toEqual([
      { text: "ada", style: providerStyle(roster, "north-shell") },
      { text: ", ", style: "dim" },
      { text: "bo", style: providerStyle(roster, "zephyr") },
      { text: ", ", style: "dim" },
      { text: "cy", style: "plain" },
    ]);
    expect(memberLine([], roster)).toEqual([]);
  });

  test("a name without an id resolves through the known agents to a provider, or stays plain", () => {
    expect(nameStyle("bo", members, roster)).toBe(providerStyle(roster, "zephyr"));
    expect(nameStyle("cy", members, roster)).toBe("plain");
    expect(nameStyle("dee", members, roster)).toBe("plain");
  });
});
