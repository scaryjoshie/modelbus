import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import { type Agent, initialState, type Message, type State } from "../state.ts";
import { EMPTY } from "./empty.ts";
import { drawLog, logColumns } from "./log.ts";

const NOW = 100_000;

const message = (seq: number, extra: Partial<Message> = {}): Message => ({
  seq,
  id: `m${seq}`,
  conversationId: "c",
  fromAgentId: "a",
  body: `hello ${seq}`,
  createdAt: NOW - seq * 1000,
  fromName: "ada",
  toName: "bo",
  status: "sent",
  detail: null,
  readAt: null,
  ...extra,
});

const agent = (id: string): Agent => ({ id, name: id, host: "h", lastSeen: 0, reachable: true });

const state = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: 120, rows: 20 }, NOW),
  view: "log",
  agents: [agent("ada"), agent("bo")],
  ...extra,
});

const rect: Rect = { x: 0, y: 0, w: 60, h: 5 };

const styles = (g: Grid, y: number) => (g.cells[y] ?? []).map((c) => c.style);
const styleAt = (g: Grid, x: number, y: number) => g.cells[y]?.[x]?.style;
const bodyText = (g: Grid) => Array.from({ length: g.rows }, (_, y) => g.text(y));

describe("drawLog", () => {
  test("title row, then one row per message from the scroll offset", () => {
    const s = state({ messages: [message(1), message(2), message(3)], selectedSeq: 1 });
    const g = new Grid(rect.w, rect.h);
    drawLog(s, rect, g);
    expect(g.text(0)).toMatch(/^messages/);
    expect(styleAt(g, 0, 0)).toBe("title");
    expect(g.text(1)).toBe("  1s ada  → bo   sent      hello 1".padEnd(rect.w));
    expect(g.text(2)).toContain("hello 2");
    expect(g.text(3)).toContain("hello 3");
    expect(g.text(4).trim()).toBe("");
  });

  test("scroll offset drops the first rows and the window clips the rest", () => {
    const messages = [1, 2, 3, 4, 5, 6].map((n) => message(n));
    const s = state({ messages, scroll: { agents: 0, log: 2, detail: 0 } });
    const g = new Grid(rect.w, rect.h);
    drawLog(s, rect, g);
    expect(g.text(1)).toContain("hello 3");
    expect(g.text(4)).toContain("hello 6");
    expect(g.text(0)).not.toContain("hello");
  });

  test("the title is plain when the list is not focused", () => {
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ focus: "detail", messages: [message(1)] }), rect, g);
    expect(styleAt(g, 0, 0)).toBe("plain");
  });

  test("age is right-aligned and dim; status is colored by delivery state", () => {
    const messages = [
      message(1, { status: "sent" }),
      message(2, { status: "delivered" }),
      message(3, { status: "read" }),
      message(4, { status: "failed", createdAt: NOW - 90_000 }),
    ];
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ messages }), rect, g);
    expect(g.text(1).slice(0, 4)).toBe("  1s");
    expect(g.text(4).slice(0, 4)).toBe("  1m");
    expect(styleAt(g, 3, 1)).toBe("dim");
    const statusX = g.text(1).indexOf("sent");
    expect(styleAt(g, statusX, 1)).toBe("wait");
    expect(styleAt(g, statusX, 2)).toBe("ok");
    expect(styleAt(g, statusX, 3)).toBe("ok");
    expect(styleAt(g, statusX, 4)).toBe("bad");
  });

  test("the selected row is inverse across its whole width, colors included", () => {
    const messages = [message(1), message(2, { status: "failed" })];
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ messages, selectedSeq: 2 }), rect, g);
    expect(new Set(styles(g, 2))).toEqual(new Set(["selected"]));
    expect(styles(g, 1)).toContain("plain");
    expect(styles(g, 1)).not.toContain("selected");
  });

  test("only the first body line shows, truncated with an ellipsis, never wrapped", () => {
    const long = `${"x".repeat(80)}\nsecond line`;
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ messages: [message(1, { body: long })] }), rect, g);
    const row = g.text(1);
    expect(row).toHaveLength(rect.w);
    expect(row.trimEnd().endsWith("…")).toBe(true);
    expect(g.text(2)).not.toContain("second");
    expect(row).not.toContain("second");
  });

  test("rows respect the rect's origin and never spill past its bottom", () => {
    const off: Rect = { x: 5, y: 2, w: 40, h: 3 };
    const messages = [1, 2, 3, 4].map((n) => message(n));
    const g = new Grid(50, 8);
    drawLog(state({ messages }), off, g);
    expect(g.text(2).slice(0, 5)).toBe("     ");
    expect(g.text(2)).toContain("messages");
    expect(g.text(3)).toContain("hello 1");
    expect(g.text(4)).toContain("hello 2");
    expect(g.text(5).trim()).toBe("");
  });

  test("empty: no messages at all, or none matching the filter", () => {
    const none = new Grid(rect.w, rect.h);
    drawLog(state(), rect, none);
    const noneRow = bodyText(none).findIndex((t) => t.includes(EMPTY.noMessages));
    expect(noneRow).toBeGreaterThan(0);
    expect(styleAt(none, 0, noneRow)).toBe("dim");

    const filtered = new Grid(rect.w, rect.h);
    drawLog(state({ messages: [message(1)], filter: "zzz" }), rect, filtered);
    expect(bodyText(filtered).join("\n")).toContain(EMPTY.noMatch);
    expect(bodyText(filtered).join("\n")).not.toContain(EMPTY.noMessages);
  });

  test("a filter narrows the rows", () => {
    const messages = [message(1, { body: "apple" }), message(2, { body: "pear" })];
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ messages, filter: "PEAR" }), rect, g);
    expect(g.text(1)).toContain("pear");
    expect(g.text(2).trim()).toBe("");
  });

  test("a wide name column is padded so the status stays aligned", () => {
    const messages = [message(1, { fromName: "a-very-long-name" }), message(2)];
    const g = new Grid(rect.w, rect.h);
    drawLog(state({ messages }), rect, g);
    expect(g.text(1).indexOf("sent")).toBe(g.text(2).indexOf("sent"));
  });

  test("does nothing for an empty rect", () => {
    const g = new Grid(10, 2);
    drawLog(state({ messages: [message(1)] }), { x: 0, y: 0, w: 10, h: 0 }, g);
    expect(g.text(0).trim()).toBe("");
  });
});

describe("logColumns", () => {
  const sum = (w: number, msgs: Message[]) => {
    const c = logColumns(w, msgs);
    return c.age + 1 + c.name + 3 + c.name + 1 + c.status + 1 + c.body;
  };

  test("the body takes the slack and the total never exceeds the width", () => {
    const msgs = [message(1)];
    expect(sum(80, msgs)).toBe(80);
    expect(logColumns(80, msgs).body).toBeGreaterThan(40);
  });

  test("names widen to the longest name, up to a cap", () => {
    expect(logColumns(120, [message(1, { toName: "abcdefgh" })]).name).toBe(8);
    expect(logColumns(120, [message(1, { toName: "x".repeat(40) })]).name).toBe(16);
  });

  test("narrow panes shrink names before the body, and the body never goes negative", () => {
    const wide = [message(1, { toName: "x".repeat(16) })];
    expect(logColumns(40, wide).name).toBeLessThan(16);
    expect(logColumns(40, wide).body).toBeGreaterThan(0);
    expect(logColumns(10, wide).body).toBe(0);
  });
});
