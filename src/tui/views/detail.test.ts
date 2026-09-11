import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import { type Agent, type Conversation, initialState, type Message, type State } from "../state.ts";
import { providerStyle } from "../style.ts";
import { clock } from "../text.ts";
import { detailLines, drawDetail } from "./detail.ts";
import { EMPTY } from "./empty.ts";

const NOW = 100_000;

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  provider: "north-shell",
  activeAt: NOW - 5000,
  lastSeen: NOW - 5000,
  purpose: null,
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

const group = (name: string, members: string[]): Conversation => ({
  id: `g-${name}`,
  kind: "group",
  key: `group:${name}`,
  name,
  createdAt: NOW - 9000,
  participants: members.map((m) => ({ id: m, name: m })),
  unread: 0,
});

const roster = [
  agent("ada"),
  agent("bo", { provider: "zephyr" }),
  agent("cy", { provider: "apex" }),
];

const state = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: 120, rows: 20 }, NOW),
  agents: roster,
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

describe("drawDetail in the agents view", () => {
  test("one field per row with dim labels, then the messages", () => {
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
      "provider  north-shell",
      "reachable yes",
      "status    working",
      "title     fix tests",
      "dir       /srv/project",
      `active    5s ago  ${clock(NOW - 5000)}`,
      "",
      "  1s ada → bo delivered",
      "  first",
    ]);
    expect(styleAt(g, 0, 1)).toBe("dim");
    expect(styleAt(g, 10, 2)).toBe("plain");
    expect(styleAt(g, 10, 4)).toBe("ok");
    expect(styleAt(g, 0, 10)).toBe("dim");
    expect(styleAt(g, g.text(10).indexOf("delivered"), 10)).toBe("ok");
  });

  test("the name and the host tag share the host's hue; the clock is dim", () => {
    const g = draw(state({ selectedAgentId: "ada" }));
    expect(styleAt(g, 10, 1)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, 12, 1)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, 10, 3)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, 10, 2)).toBe("plain");
    const bo = draw(state({ selectedAgentId: "bo" }));
    expect(styleAt(bo, 10, 1)).toBe(providerStyle(roster, "zephyr"));
    expect(styleAt(bo, 10, 3)).toBe(providerStyle(roster, "zephyr"));
    // No purpose or title, so "active" is the seventh field.
    const seen = g.text(7);
    expect(seen).toMatch(/^active {4}5s ago/);
    expect(styleAt(g, seen.indexOf("ago"), 7)).toBe("plain");
    expect(styleAt(g, seen.indexOf(":"), 7)).toBe("dim");
  });

  test("the groups the agent is in follow the fields, each #name in the group color", () => {
    const s = state({
      selectedAgentId: "bo",
      conversations: [
        group("ops", ["ada", "bo"]),
        group("docs", ["cy"]),
        group("plan", ["bo", "cy"]),
        {
          ...group("x", ["ada", "bo"]),
          id: "d1",
          kind: "dm",
          key: "dm:ada:bo",
          name: null,
        },
      ],
    });
    const g = draw(s);
    expect(g.text(8).trimEnd()).toBe("in        #ops, #plan");
    expect(styleAt(g, 0, 8)).toBe("dim");
    expect(styleAt(g, 10, 8)).toBe("group");
    expect(styleAt(g, 14, 8)).toBe("dim");
    expect(styleAt(g, 16, 8)).toBe("group");
    expect(g.text(9).trim()).toBe("");
    expect(g.text(10).trimEnd()).toBe(EMPTY.noMessages);
  });

  test("an agent in no group has no 'in' line", () => {
    const s = state({ selectedAgentId: "ada", conversations: [group("docs", ["cy"])] });
    const g = draw(s);
    expect(g.text(8).trim()).toBe("");
    expect(g.text(9).trimEnd()).toBe(EMPTY.noMessages);
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

  test("a message header colors both names by their host on the roster", () => {
    const s = state({
      selectedAgentId: "ada",
      messages: [message(1, { fromAgentId: "ada", toName: "bo" })],
    });
    const g = draw(s);
    const header = g.text(9);
    expect(header.trimEnd()).toMatch(/ada → bo delivered$/);
    expect(styleAt(g, header.indexOf("ada"), 9)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, header.indexOf("bo"), 9)).toBe(providerStyle(roster, "zephyr"));
    expect(styleAt(g, header.indexOf("→"), 9)).toBe("plain");
    const gone = draw(
      state({ agents: [agent("ada")], selectedAgentId: "ada", messages: s.messages }),
    );
    expect(styleAt(gone, header.indexOf("bo"), 9)).toBe("plain");
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

  test("nothing selected: one dim line", () => {
    const g = draw(state({ agents: [] }));
    expect(g.text(1).trimEnd()).toBe(EMPTY.nothingSelected);
    expect(styleAt(g, 0, 1)).toBe("dim");
    expect(g.text(2).trim()).toBe("");
  });

  test("the title is plain: the pane has no focus", () => {
    expect(styleAt(draw(state()), 0, 0)).toBe("plain");
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
    expect(g.text(5)).toMatch(/^ {3}provider/);
    expect(g.text(6).trim()).toBe("");
    expect(g.text(1).trim()).toBe("");
  });
});
