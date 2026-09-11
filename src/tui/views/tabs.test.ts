import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { type Agent, type Conversation, initialState, type State } from "../state.ts";
import { drawTabs, tabCount } from "./tabs.ts";

const agent = (name: string): Agent => ({
  id: `id-${name}`,
  name,
  provider: "h",
  lastSeen: 0,
  purpose: null,
  reachable: true,
});

const group = (name: string): Conversation => ({
  id: `c-${name}`,
  kind: "group",
  key: `group:${name}`,
  name,
  createdAt: 0,
  participants: [],
  unread: 0,
});

const COLS = 40;
const base = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: COLS, rows: 10 }, 0),
  agents: [agent("alpha"), agent("beta"), agent("gamma")],
  conversations: [group("one"), group("two")],
  lastPollAt: 0,
  ...extra,
});

const draw = (state: State, w = COLS) => {
  const g = new Grid(w, 2);
  g.put(0, 0, "#".repeat(w));
  drawTabs(state, { x: 0, y: 0, w, h: 1 }, g);
  return g;
};
const styleAt = (g: Grid, x: number) => g.cells[0]?.[x]?.style;
const line = (state: State) => draw(state).text(0).trimEnd();

describe("drawTabs", () => {
  test("both names with their counts; the active tab in title, the rest dim", () => {
    const g = draw(base());
    expect(g.text(0).trimEnd()).toBe("Agents 3  Chats 2");
    expect(styleAt(g, 0)).toBe("title");
    expect(styleAt(g, 5)).toBe("title");
    expect(styleAt(g, 7)).toBe("dim");
    expect(styleAt(g, 10)).toBe("dim");
    expect(styleAt(g, 16)).toBe("dim");
  });

  test("switching tabs moves the title style", () => {
    const g = draw(base({ tab: "chats" }));
    expect(styleAt(g, 0)).toBe("dim");
    expect(styleAt(g, 10)).toBe("title");
    expect(styleAt(g, 14)).toBe("title");
    expect(styleAt(g, 16)).toBe("dim");
  });

  test("a filter shows the active tab's count as shown/total, the other tab's as is", () => {
    expect(line(base({ filter: "et" }))).toBe("Agents 1/3  Chats 2");
    expect(line(base({ filter: "zz" }))).toBe("Agents 0/3  Chats 2");
    expect(line(base({ filter: "one", tab: "chats" }))).toBe("Agents 3  Chats 1/2");
    expect(tabCount(base({ filter: "et" }), "agents")).toBe("1/3");
    expect(tabCount(base({ filter: "et" }), "chats")).toBe("2");
  });

  test("no counts before the first poll has answered", () => {
    expect(line(base({ lastPollAt: undefined }))).toBe("Agents  Chats");
  });

  test("the row is cleared and clipped to its width", () => {
    const g = draw(base(), 12);
    expect(g.text(0)).toBe("Agents 3  Ch");
    expect(g.text(1).trim()).toBe("");
  });

  test("a rect with no room draws nothing", () => {
    const g = new Grid(10, 1);
    drawTabs(base(), { x: 0, y: 0, w: 10, h: 0 }, g);
    expect(g.text(0).trim()).toBe("");
  });
});
