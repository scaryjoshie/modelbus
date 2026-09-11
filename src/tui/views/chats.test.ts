import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { type Agent, type Conversation, initialState, type State } from "../state.ts";
import { providerStyle, type Style } from "../style.ts";
import { columns, drawChats } from "./chats.ts";
import { EMPTY } from "./empty.ts";

const NOW = 100_000;

const member = (name: string) => ({ id: `id-${name}`, name });

const agent = (name: string, provider: string): Agent => ({
  id: `id-${name}`,
  name,
  provider,
  lastSeen: NOW,
  purpose: null,
  reachable: true,
});

/** The roster the rows are colored from; `cy` is on it, `dee` and most `agent-N` are not. */
const roster = [
  agent("ada", "north-shell"),
  agent("bo", "zephyr"),
  agent("cy", "apex"),
  agent("agent-0", "north-shell"),
  agent("agent-3", "zephyr"),
];

const conversation = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  kind: "dm",
  key: `dm:${id}`,
  name: null,
  createdAt: NOW - 9000,
  participants: [member("ada"), member("bo")],
  unread: 0,
  ...extra,
});

const list: Conversation[] = [
  conversation("c1", {
    kind: "group",
    name: "ops",
    participants: [member("ada"), member("bo"), member("cy")],
    unread: 3,
    last: { seq: 9, fromName: "cy", body: "ship it\nsecond line", createdAt: NOW - 1000 },
  }),
  conversation("c2", {
    last: { seq: 7, fromName: "ada", body: "hello there", createdAt: NOW - 5000 },
  }),
  conversation("c3", { participants: [member("bo"), member("cy")] }),
];

/** The Chats tab with the first row selected unless `extra` says otherwise. */
const stateWith = (conversations: Conversation[], extra: Partial<State> = {}): State => ({
  ...initialState({ cols: 80, rows: 24 }, NOW),
  tab: "chats",
  agents: roster,
  conversations,
  selectedConversationId: conversations[0]?.id,
  ...extra,
});
const NONE: Partial<State> = { selectedConversationId: undefined };

/** Draw into a grid exactly the pane's size; a wider grid would hide overruns. */
function draw(state: State, w: number, h: number, x = 0, y = 0): Grid {
  const grid = new Grid(x + w, y + h);
  drawChats(state, { x, y, w, h }, grid);
  return grid;
}

const styles = (grid: Grid, y: number): Style[] => (grid.cells[y] ?? []).map((c) => c.style);
const styleAt = (grid: Grid, x: number, y: number): Style | undefined => grid.cells[y]?.[x]?.style;

describe("drawChats", () => {
  test("title on row 0, bold while the arrows move the list, plain otherwise", () => {
    const g = draw(stateWith(list), 60, 6);
    expect(g.text(0).trimEnd()).toBe("chats");
    expect(styleAt(g, 0, 0)).toBe("title");
    const reading = draw(stateWith(list, { focus: "messages" }), 60, 6);
    expect(styleAt(reading, 0, 0)).toBe("plain");
    expect(styleAt(reading, 0, 1)).toBe("selected");
  });

  test("one row per conversation in the daemon's order: label, members, unread, last message", () => {
    const g = draw(stateWith(list, NONE), 60, 6, 2, 1);
    expect(g.text(1).trimEnd()).toBe("  chats");
    expect(g.text(2).trimEnd()).toBe("  #ops  ada, bo, cy  3  cy: ship it");
    expect(g.text(3).trimEnd()).toBe("  dm    ada, bo      0  ada: hello there");
    expect(g.text(4).trimEnd()).toBe("  dm    bo, cy       0");
    expect(g.text(5).trim()).toBe("");
  });

  test("kinds, names, counts and senders each take their role's color", () => {
    const g = draw(stateWith(list, NONE), 60, 6);
    const ops = g.text(1);
    expect(styleAt(g, 0, 1)).toBe("group");
    expect(styleAt(g, 0, 2)).toBe("dm");
    expect(styleAt(g, ops.indexOf("ada"), 1)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, ops.indexOf(","), 1)).toBe("dim");
    expect(styleAt(g, ops.indexOf("bo"), 1)).toBe(providerStyle(roster, "zephyr"));
    expect(styleAt(g, ops.indexOf("3"), 1)).toBe("accent");
    expect(styleAt(g, g.text(2).indexOf("0"), 2)).toBe("dim");
    expect(styleAt(g, ops.lastIndexOf("cy"), 1)).toBe(providerStyle(roster, "apex"));
    expect(styleAt(g, ops.indexOf(": ship"), 1)).toBe("plain");
    expect(styleAt(g, ops.indexOf("ship"), 1)).toBe("plain");
  });

  test("unread counts are right-aligned in their column", () => {
    const rows = [conversation("a", { unread: 12 }), conversation("b", { unread: 0 })];
    const g = draw(stateWith(rows, NONE), 60, 4);
    const x = g.text(1).indexOf("12");
    expect(g.text(2).slice(x, x + 2)).toBe(" 0");
    expect(styleAt(g, x + 1, 2)).toBe("dim");
  });

  test("a name off the roster, or a sender who is not a member, stays plain", () => {
    const rows = [
      conversation("a", {
        participants: [member("ada"), member("eve")],
        last: { seq: 1, fromName: "dee", body: "hi", createdAt: NOW },
      }),
    ];
    const g = draw(stateWith(rows, NONE), 60, 3);
    const row = g.text(1);
    expect(styleAt(g, row.indexOf("ada"), 1)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, row.indexOf("eve"), 1)).toBe("plain");
    expect(styleAt(g, row.indexOf("dee"), 1)).toBe("plain");
    // A member off the roster: known by id, but with no host to take a hue from.
    const bare = draw(stateWith(rows, { ...NONE, agents: [] }), 60, 3);
    expect(styleAt(bare, row.indexOf("ada"), 1)).toBe("plain");
  });

  test("the selected row is inverse across the whole pane", () => {
    const g = draw(stateWith(list, { selectedConversationId: "c2" }), 60, 6);
    expect(new Set(styles(g, 2))).toEqual(new Set(["selected"]));
    expect(g.text(2)).toMatch(/^dm\s+ada, bo\s+0\s+ada: hello there\s*$/);
    expect(styleAt(g, 0, 1)).toBe("group");
  });

  test("rows start at the scroll offset and stop at the pane's bottom", () => {
    const many = Array.from({ length: 10 }, (_, i) => conversation(`c${i}`, { unread: i }));
    const s = stateWith(many, {
      scroll: { agents: 0, chats: 4, messages: 0 },
      selectedConversationId: "c5",
    });
    const g = draw(s, 40, 4);
    expect(g.text(1)).toMatch(/\b4\s*$/);
    expect(g.text(2)).toMatch(/\b5\s*$/);
    expect(styleAt(g, 0, 2)).toBe("selected");
    expect(g.text(3)).toMatch(/\b6\s*$/);
    expect(g.rows).toBe(4);
  });

  test("columns come from the whole list; the last message takes the slack and goes first", () => {
    const wide = columns(60, list);
    expect(wide).toEqual({ label: 4, members: 11, unread: 1, last: 60 - (4 + 11 + 1) - 3 * 2 });
    const narrow = columns(24, list);
    expect(narrow).toEqual({ label: 4, members: 24 - (4 + 1) - 2 * 2, unread: 1, last: 0 });
    const g = draw(stateWith(list, NONE), 24, 4);
    expect(g.text(1).trimEnd()).toBe("#ops  ada, bo, cy      3");
    expect(g.text(1)).not.toContain("ship");
  });

  test("long labels, member lists and messages end in an ellipsis", () => {
    const rows = [
      conversation("a", {
        kind: "group",
        name: "a-very-long-group-name-indeed",
        participants: Array.from({ length: 12 }, (_, i) => member(`agent-${i}`)),
        last: { seq: 1, fromName: "agent-0", body: "x".repeat(80), createdAt: NOW },
      }),
    ];
    const g = draw(stateWith(rows, NONE), 70, 3);
    const row = g.text(1);
    expect(row.length).toBe(70);
    expect(
      row.startsWith("#a-very-long-gr…  agent-0, agent-1, agent-2, agen…  0  agent-0: xxx"),
    ).toBe(true);
    expect(row.endsWith("…")).toBe(true);
    expect(styleAt(g, 15, 1)).toBe("group");
    const cut = row.indexOf("agen…");
    expect(styleAt(g, cut, 1)).toBe(providerStyle(roster, "zephyr"));
    expect(styleAt(g, cut + 4, 1)).toBe(providerStyle(roster, "zephyr"));
    expect(styleAt(g, cut - 2, 1)).toBe("dim");
    expect(styleAt(g, row.indexOf("agent-1"), 1)).toBe("plain");
    expect(styleAt(g, row.indexOf("agent-0:"), 1)).toBe(providerStyle(roster, "north-shell"));
  });

  test("wide characters in a body count as two cells", () => {
    const rows = [
      conversation("a", {
        last: { seq: 1, fromName: "ada", body: "漢字漢字漢字", createdAt: NOW },
      }),
    ];
    const g = draw(stateWith(rows, NONE), 30, 3);
    const row = g.text(1);
    expect(row).toContain("ada: 漢字");
    expect(row.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(row)).toBe(30);
  });

  test("a filter narrows the rows; the count lives in the tab row, not the title", () => {
    const g = draw(stateWith(list, { filter: "ops" }), 40, 6);
    expect(g.text(0).trimEnd()).toBe("chats");
    expect(g.text(1)).toMatch(/^#ops/);
    expect(g.text(2).trim()).toBe("");
  });

  test("empty states tell no chats apart from no match", () => {
    const body = (g: Grid) =>
      Array.from({ length: g.rows - 1 }, (_, y) => g.text(y + 1)).join("\n");
    const none = draw(stateWith([], NONE), 60, 5);
    expect(none.text(0).trimEnd()).toBe("chats");
    expect(body(none)).toContain(EMPTY.noChats);
    const noMatch = draw(stateWith(list, { filter: "zzz" }), 60, 5);
    expect(noMatch.text(0).trimEnd()).toBe("chats");
    expect(body(noMatch)).toContain(EMPTY.noMatch);
    expect(body(noMatch)).not.toContain(EMPTY.noChats);
  });

  test("nothing is drawn into an empty rect", () => {
    const g = new Grid(10, 2);
    drawChats(stateWith(list), { x: 0, y: 0, w: 10, h: 0 }, g);
    expect(g.text(0).trim()).toBe("");
  });
});
