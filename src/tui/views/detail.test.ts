import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import { type Agent, initialState, type Message, type State } from "../state.ts";
import { clock } from "../text.ts";
import { detailLines, drawDetail, wrap } from "./detail.ts";
import { EMPTY } from "./empty.ts";

const NOW = 100_000;

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  host: "hostx",
  lastSeen: NOW - 5000,
  reachable: true,
  ...extra,
});

const message = (seq: number, extra: Partial<Message> = {}): Message => ({
  seq,
  id: `m${seq}`,
  conversationId: "c",
  fromAgentId: "ada",
  body: `hello ${seq}`,
  createdAt: NOW - seq * 1000,
  fromName: "ada",
  toName: "bo",
  status: "delivered",
  detail: null,
  readAt: null,
  ...extra,
});

const state = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: 120, rows: 20 }, NOW),
  agents: [agent("ada"), agent("bo"), agent("cy")],
  ...extra,
});

const rect: Rect = { x: 0, y: 0, w: 40, h: 12 };

const styleAt = (g: Grid, x: number, y: number) => g.cells[y]?.[x]?.style;
const draw = (s: State, r: Rect = rect) => {
  const g = new Grid(r.x + r.w, r.y + r.h);
  drawDetail(s, r, g);
  return g;
};
const rows = (g: Grid, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => g.text(from + i).trimEnd());

describe("wrap", () => {
  test("breaks between words and keeps newlines", () => {
    expect(wrap("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
    expect(wrap("one\ntwo three", 20)).toEqual(["one", "two three"]);
    expect(wrap("a\n\nb", 5)).toEqual(["a", "", "b"]);
    expect(wrap("", 5)).toEqual([""]);
  });

  test("a word wider than the line is cut, other words are not", () => {
    expect(wrap("abcdefghij kl", 4)).toEqual(["abcd", "efgh", "ij", "kl"]);
    expect(wrap("ab cdefgh", 4)).toEqual(["ab", "cdef", "gh"]);
  });

  test("wide characters count as two cells and never straddle a line", () => {
    expect(Bun.stringWidth("漢")).toBe(2);
    expect(wrap("漢字漢字漢", 4)).toEqual(["漢字", "漢字", "漢"]);
    expect(wrap("漢字漢", 3)).toEqual(["漢", "字", "漢"]);
    expect(wrap("🙂🙂🙂", 4)).toEqual(["🙂🙂", "🙂"]);
    expect(wrap("ok 🙂🙂", 5)).toEqual(["ok", "🙂🙂"]);
    expect(wrap("ok 🙂 🙂", 5)).toEqual(["ok 🙂", "🙂"]);
  });

  test("leading indentation survives; a width under one still makes progress", () => {
    expect(wrap("  code", 10)).toEqual(["  code"]);
    expect(wrap("漢", 0)).toEqual(["漢"]);
    expect(wrap("abc", -3)).toEqual(["a", "b", "c"]);
  });
});

describe("drawDetail in the agents view", () => {
  test("one field per row with dim labels and plain values, then the messages", () => {
    const s = state({
      agents: [agent("ada", { status: "working", cwd: "/srv/project", title: "fix tests" })],
      selectedAgentId: "ada",
      messages: [message(1, { body: "first" }), message(2, { body: "second\nline two" })],
    });
    const g = draw(s);
    expect(g.text(0)).toMatch(/^detail/);
    expect(rows(g, 1, 11)).toEqual([
      "name      ada",
      "id        ada",
      "host      hostx",
      "reachable yes",
      "status    working",
      "title     fix tests",
      "dir       /srv/project",
      `seen      5s ago  ${clock(NOW - 5000)}`,
      "",
      "  1s ada → bo delivered",
      "  first",
    ]);
    expect(styleAt(g, 0, 1)).toBe("dim");
    expect(styleAt(g, 10, 1)).toBe("plain");
    expect(styleAt(g, 10, 4)).toBe("ok");
    expect(styleAt(g, 0, 10)).toBe("dim");
    expect(styleAt(g, g.text(10).indexOf("delivered"), 10)).toBe("ok");
  });

  test("messages keep their order and multi-line bodies are indented", () => {
    const s = state({
      selectedAgentId: "ada",
      messages: [message(1, { body: "first" }), message(2, { body: "second\nline two" })],
    });
    const lines = detailLines(s, rect.w).map((l) => l.map((sp) => sp.text).join(""));
    expect(lines.slice(-5)).toEqual([
      "  1s ada → bo delivered",
      "  first",
      "  2s ada → bo delivered",
      "  second",
      "  line two",
    ]);
  });

  test("unreachable shows in bad with the provider's note; title is omitted when absent", () => {
    const s = state({
      agents: [agent("cy", { reachable: false, note: "session exited" })],
      selectedAgentId: "cy",
    });
    const g = draw(s);
    expect(g.text(4).trimEnd()).toBe("reachable no  session exited");
    expect(styleAt(g, 10, 4)).toBe("bad");
    expect(styleAt(g, 14, 4)).toBe("plain");
    expect(g.text(6)).toMatch(/^dir/);
  });

  test("the directory is shortened with ~ and long values end in an ellipsis", () => {
    const home = process.env.HOME ?? "/home/nobody";
    const s = state({
      agents: [agent("ada", { cwd: `${home}/dev/${"deep/".repeat(20)}x` })],
      selectedAgentId: "ada",
    });
    const g = draw(s);
    expect(g.text(6)).toMatch(/^dir {7}~\/dev\/deep/);
    expect(g.text(6).trimEnd().endsWith("…")).toBe(true);
    expect(g.text(6)).toHaveLength(rect.w);
  });

  test("bodies wrap at the pane width by word, and only messages of that agent show", () => {
    const s = state({
      selectedAgentId: "bo",
      messages: [
        message(1, { body: "alpha beta gamma delta epsilon zeta eta theta iota" }),
        message(2, { fromName: "cy", toName: "ada", body: "not for bo" }),
      ],
    });
    const g = draw(s, { x: 0, y: 0, w: 24, h: 14 });
    expect(rows(g, 9, 12)).toEqual([
      "  1s ada → bo delivered",
      "  alpha beta gamma delta",
      "  epsilon zeta eta theta",
      "  iota",
    ]);
    expect(rows(g, 0, 13).join("\n")).not.toContain("not for bo");
  });

  test("an agent with no messages says so", () => {
    const g = draw(state({ selectedAgentId: "ada" }));
    expect(g.text(8).trim()).toBe("");
    expect(g.text(9).trimEnd()).toBe(EMPTY.noMessages);
    expect(styleAt(g, 0, 9)).toBe("dim");
  });

  test("scroll.detail slides the lines up under the title", () => {
    const s = state({ selectedAgentId: "ada", scroll: { agents: 0, log: 0, detail: 3 } });
    const g = draw(s);
    expect(g.text(0)).toMatch(/^detail/);
    expect(g.text(1)).toMatch(/^reachable/);
  });

  test("nothing selected: one dim line", () => {
    const g = draw(state({ agents: [] }));
    expect(g.text(1).trimEnd()).toBe(EMPTY.nothingSelected);
    expect(styleAt(g, 0, 1)).toBe("dim");
    expect(g.text(2).trim()).toBe("");
  });

  test("the title is bold only while the detail pane has focus", () => {
    expect(styleAt(draw(state({ focus: "detail" })), 0, 0)).toBe("title");
    expect(styleAt(draw(state({ focus: "list" })), 0, 0)).toBe("plain");
  });

  test("drawing stays inside the rect", () => {
    const s = state({
      selectedAgentId: "ada",
      messages: [1, 2, 3, 4, 5, 6].map((n) => message(n)),
    });
    const r: Rect = { x: 3, y: 2, w: 30, h: 4 };
    const g = new Grid(40, 10);
    drawDetail(s, r, g);
    expect(g.text(2).slice(0, 3)).toBe("   ");
    expect(g.text(2)).toContain("detail");
    expect(g.text(5)).toMatch(/^ {3}host/);
    expect(g.text(6).trim()).toBe("");
    expect(g.text(1).trim()).toBe("");
  });
});

describe("drawDetail in the log view", () => {
  const logState = (m: Message, extra: Partial<State> = {}) =>
    state({ view: "log", messages: [m], selectedSeq: m.seq, ...extra });

  test("header rows, a blank row, then the wrapped body", () => {
    const m = message(3, {
      status: "sent",
      detail: "host not reachable",
      body: "one two three four five six seven eight\nnine",
    });
    const g = draw(logState(m), { x: 0, y: 0, w: 30, h: 10 });
    expect(rows(g, 1, 8)).toEqual([
      "from      ada",
      "to        bo",
      "state     sent  host not reac…",
      `sent      ${clock(NOW - 3000)}  3s ago`,
      "",
      "one two three four five six",
      "seven eight",
      "nine",
    ]);
    expect(styleAt(g, 0, 3)).toBe("dim");
    expect(styleAt(g, 10, 3)).toBe("wait");
    expect(styleAt(g, 16, 3)).toBe("plain");
  });

  test("state colors follow delivery state", () => {
    expect(styleAt(draw(logState(message(1, { status: "failed" }))), 10, 3)).toBe("bad");
    expect(styleAt(draw(logState(message(1, { status: "read" }))), 10, 3)).toBe("ok");
    expect(styleAt(draw(logState(message(1, { status: "delivered" }))), 10, 3)).toBe("ok");
  });

  test("scroll.detail moves through a long body", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const g = draw(logState(message(1, { body }), { scroll: { agents: 0, log: 0, detail: 7 } }));
    expect(g.text(1).trimEnd()).toBe("line 2");
    expect(g.text(11).trimEnd()).toBe("line 12");
  });

  test("nothing selected: one dim line", () => {
    const g = draw(state({ view: "log" }));
    expect(g.text(1).trimEnd()).toBe(EMPTY.nothingSelected);
    expect(styleAt(g, 0, 1)).toBe("dim");
  });
});
