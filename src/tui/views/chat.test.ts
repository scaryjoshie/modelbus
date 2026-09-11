import { describe, expect, test } from "bun:test";
import { Grid, type Rect } from "../screen.ts";
import {
  type Agent,
  type ChatMessage,
  type Conversation,
  type History,
  initialState,
  type State,
} from "../state.ts";
import { providerStyle, type Style } from "../style.ts";
import { clock } from "../text.ts";
import { chatLines, drawChat, messageLines } from "./chat.ts";
import { EMPTY } from "./empty.ts";

const NOW = 100_000;

const message = (seq: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  seq,
  id: `m${seq}`,
  conversationId: "c1",
  fromAgentId: "id-ada",
  fromName: "ada",
  fromProvider: "north-shell",
  body: `message ${seq}`,
  createdAt: NOW - (10 - seq) * 1000,
  ...extra,
});

const conversation: Conversation = {
  id: "c1",
  kind: "group",
  key: "group:ops",
  name: "ops",
  createdAt: NOW - 9000,
  participants: [
    { id: "id-ada", name: "ada" },
    { id: "id-bo", name: "bo" },
  ],
  unread: 0,
};

const agent = (name: string, provider: string): Agent => ({
  id: `id-${name}`,
  name,
  provider,
  lastSeen: NOW,
  purpose: null,
  registered: true,
  reachable: true,
});

const roster = [agent("ada", "north-shell"), agent("bo", "zephyr")];

const page = (messages: ChatMessage[], id = "c1"): History => ({ id, messages });

const stateWith = (history: History | undefined, extra: Partial<State> = {}): State => ({
  ...initialState({ cols: 80, rows: 24 }, NOW),
  tab: "chats",
  agents: roster,
  conversations: [conversation],
  selectedConversationId: "c1",
  history,
  ...extra,
});

const scrolled = (messages: number): State["scroll"] => ({ agents: 0, chats: 0, messages });

/** Draw into a grid exactly the pane's size; a wider grid would hide overruns. */
function draw(state: State, w: number, h: number, x = 0, y = 0): Grid {
  const grid = new Grid(x + w, y + h);
  drawChat(state, { x, y, w, h }, grid);
  return grid;
}

const rows = (g: Grid, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => g.text(from + i).trimEnd());
const styles = (grid: Grid, y: number): Style[] => (grid.cells[y] ?? []).map((c) => c.style);
const styleAt = (grid: Grid, x: number, y: number): Style | undefined => grid.cells[y]?.[x]?.style;
const text = (lines: ReturnType<typeof chatLines>) =>
  lines.map((l) => l.map((s) => s.text).join(""));
const t = (seq: number) => clock(NOW - (10 - seq) * 1000);

describe("messageLines", () => {
  test("a header and a wrapped, indented body per message, one blank line between", () => {
    const lines = messageLines(
      [message(1, { body: "one two three four" }), message(2, { body: "five" })],
      roster,
      12,
    );
    expect(text(lines)).toEqual([
      `ada  ${t(1)}`,
      "  one two",
      "  three four",
      "",
      `ada  ${t(2)}`,
      "  five",
    ]);
    expect(lines[0]?.[0]?.style).toBe(providerStyle(roster, "north-shell"));
    expect(lines[0]?.[1]?.style).toBe("dim");
    expect(lines[1]?.[0]?.style).toBe("plain");
  });

  test("a sender is colored by the host on the message, not the roster", () => {
    const lines = messageLines(
      [message(1, { fromAgentId: "id-x", fromProvider: "apex" })],
      roster,
      20,
    );
    expect(lines[0]?.[0]?.style).toBe(providerStyle(roster, "apex"));
  });

  test("a long word and wide characters break by cell width", () => {
    const lines = messageLines([message(1, { body: "abcdefghij 漢字漢字" })], roster, 8);
    expect(text(lines).slice(1)).toEqual(["  abcdef", "  ghij", "  漢字漢", "  字"]);
  });

  test("no messages, no lines", () => {
    expect(messageLines([], roster, 20)).toEqual([]);
  });
});

describe("chatLines", () => {
  test("nothing selected: one dim line", () => {
    const lines = chatLines(stateWith(undefined, { selectedConversationId: undefined }), 40);
    expect(lines).toEqual([[{ text: EMPTY.nothingSelected, style: "dim" }]]);
  });

  test("loading until a page for the selected conversation lands", () => {
    expect(chatLines(stateWith(undefined), 40)).toEqual([[{ text: EMPTY.loading, style: "dim" }]]);
    const stale = stateWith(page([message(1)], "c-other"));
    expect(chatLines(stale, 40)).toEqual([[{ text: EMPTY.loading, style: "dim" }]]);
  });

  test("an empty page says no messages; a full one is its message lines", () => {
    expect(chatLines(stateWith(page([])), 40)).toEqual([
      [{ text: EMPTY.noMessages, style: "dim" }],
    ]);
    const messages = [message(1), message(2)];
    expect(chatLines(stateWith(page(messages)), 40)).toEqual(messageLines(messages, roster, 40));
  });
});

describe("drawChat", () => {
  test("the title names the chat in its kind color and its members in theirs", () => {
    const g = draw(stateWith(page([message(1)])), 40, 6);
    expect(g.text(0).trimEnd()).toBe("#ops  ada, bo");
    expect(styleAt(g, 0, 0)).toBe("group");
    expect(styleAt(g, 6, 0)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, 9, 0)).toBe("dim");
    expect(styleAt(g, 11, 0)).toBe(providerStyle(roster, "zephyr"));
    const unknown = draw(stateWith(page([message(1)]), { agents: [] }), 40, 6);
    expect(styleAt(unknown, 6, 0)).toBe("plain");
    expect(styleAt(unknown, 0, 0)).toBe("group");
    const dm = draw(
      stateWith(page([message(1)]), {
        conversations: [{ ...conversation, kind: "dm", name: null }],
      }),
      40,
      6,
    );
    expect(dm.text(0).trimEnd()).toBe("dm  ada, bo");
    expect(styleAt(dm, 0, 0)).toBe("dm");
  });

  test("the title is bold across its width while the pane has the arrows", () => {
    const focused = draw(stateWith(page([message(1)]), { focus: "messages" }), 40, 6);
    expect(focused.text(0).trimEnd()).toBe("#ops  ada, bo");
    expect(new Set(styles(focused, 0).slice(0, 13))).toEqual(new Set(["title"]));
    expect(styleAt(focused, 0, 1)).toBe(providerStyle(roster, "north-shell"));
    const list = draw(stateWith(page([message(1)]), { focus: "list" }), 40, 6);
    expect(styles(list, 0)).not.toContain("title");
  });

  test("nothing selected: a plain pane name and one dim line", () => {
    const g = draw(stateWith(undefined, { selectedConversationId: undefined }), 40, 4);
    expect(g.text(0).trimEnd()).toBe("chat");
    expect(styleAt(g, 0, 0)).toBe("plain");
    expect(g.text(1).trimEnd()).toBe(EMPTY.nothingSelected);
    expect(styleAt(g, 0, 1)).toBe("dim");
    expect(g.text(2).trim()).toBe("");
  });

  test("messages run oldest to newest from the top when the offset is zero", () => {
    const g = draw(stateWith(page([message(1), message(2)])), 40, 8);
    expect(rows(g, 1, 7)).toEqual([
      `ada  ${t(1)}`,
      "  message 1",
      "",
      `ada  ${t(2)}`,
      "  message 2",
      "",
      "",
    ]);
  });

  test("the offset is a line index: the pane shows that line and the ones after it", () => {
    const messages = [1, 2, 3].map((n) => message(n, { body: `body ${n}\nmore ${n}` }));
    // Lines: header 1, body 1, more 1, blank, header 2, body 2, more 2, blank, header 3, ...
    const g = draw(stateWith(page(messages), { scroll: scrolled(7) }), 40, 7);
    expect(rows(g, 1, 6)).toEqual(["", `ada  ${t(3)}`, "  body 3", "  more 3", "", ""]);
    expect(g.rows).toBe(7);
    const mid = draw(stateWith(page(messages), { scroll: scrolled(5) }), 40, 4);
    expect(rows(mid, 1, 3)).toEqual(["  body 2", "  more 2", ""]);
  });

  test("senders take their host's hue, times are dim, bodies plain; no row is inverse", () => {
    const bo = message(2, { fromAgentId: "id-bo", fromName: "bo", fromProvider: "zephyr" });
    const g = draw(stateWith(page([message(1), bo])), 40, 8);
    expect(styleAt(g, 0, 1)).toBe(providerStyle(roster, "north-shell"));
    expect(styleAt(g, 5, 1)).toBe("dim");
    expect(styleAt(g, 2, 2)).toBe("plain");
    expect(styleAt(g, 0, 4)).toBe(providerStyle(roster, "zephyr"));
    for (let y = 0; y < g.rows; y++) expect(styles(g, y)).not.toContain("selected");
  });

  test("bodies wrap at the pane width and are indented two cells", () => {
    const g = draw(stateWith(page([message(1, { body: "alpha beta gamma delta" })])), 14, 6);
    expect(rows(g, 1, 5)).toEqual([`ada  ${t(1)}`, "  alpha beta", "  gamma delta", "", ""]);
  });

  test("a long header is cut with an ellipsis at the pane edge", () => {
    const g = draw(
      stateWith(page([message(1, { fromName: "a-very-long-name", fromProvider: "apex" })])),
      12,
      4,
    );
    expect(g.text(1)).toBe("a-very-long…");
    expect(styleAt(g, 11, 1)).toBe(providerStyle(roster, "apex"));
    expect(g.text(0)).toBe("#ops  ada, …");
  });

  test("loading before the page lands, no messages after an empty one", () => {
    const loading = draw(stateWith(undefined), 40, 5);
    expect(loading.text(1).trimEnd()).toBe(EMPTY.loading);
    expect(styleAt(loading, 0, 1)).toBe("dim");
    const stale = draw(stateWith(page([message(1)], "c-other")), 40, 5);
    expect(stale.text(1).trimEnd()).toBe(EMPTY.loading);
    const empty = draw(stateWith(page([])), 40, 5);
    expect(empty.text(1).trimEnd()).toBe(EMPTY.noMessages);
    expect(rows(empty, 1, 4).join("\n")).not.toContain(EMPTY.loading);
  });

  test("nothing is drawn into an empty rect", () => {
    const g = new Grid(20, 3);
    drawChat(stateWith(page([message(1)])), { x: 0, y: 0, w: 20, h: 0 }, g);
    drawChat(stateWith(page([message(1)])), { x: 0, y: 0, w: 0, h: 3 }, g);
    expect(rows(g, 0, 2)).toEqual(["", "", ""]);
  });

  test("drawing stays inside the rect", () => {
    const s = stateWith(page([1, 2, 3, 4, 5].map((n) => message(n))));
    const r: Rect = { x: 3, y: 2, w: 30, h: 4 };
    const g = new Grid(40, 10);
    drawChat(s, r, g);
    expect(g.text(1).trim()).toBe("");
    expect(g.text(2)).toMatch(/^ {3}#ops/);
    expect(g.text(3)).toMatch(/^ {3}ada {2}\d\d:\d\d:\d\d/);
    expect(g.text(4)).toMatch(/^ {3} {2}message 1/);
    expect(g.text(5).trim()).toBe("");
    expect(g.text(6).trim()).toBe("");
    expect(g.text(3).slice(33).trim()).toBe("");
  });
});
