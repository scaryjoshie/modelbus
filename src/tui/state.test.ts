import { describe, expect, test } from "bun:test";
import { parseKeys } from "./keys.ts";
import { type Agent, initialState, type Message, type State, update } from "./state.ts";

const agent = (id: string, host = "h", extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  host,
  lastSeen: 0,
  reachable: true,
  ...extra,
});

const message = (seq: number, from: string, to: string): Message => ({
  seq,
  id: `m${seq}`,
  conversationId: "c",
  fromAgentId: from,
  body: `hello ${seq}`,
  createdAt: 0,
  fromName: from,
  toName: to,
  status: "sent",
  detail: null,
  readAt: null,
});

const size = { cols: 120, rows: 8 };
const keys = (s: State, input: string) =>
  parseKeys(input).reduce((st, key) => update(st, { type: "key", key }), s);
const polled = (s: State, agents: Agent[], messages: Message[] = []) =>
  update(s, { type: "poll", agents, messages, at: 1 });

describe("update", () => {
  test("first poll selects the first row in host-then-name order", () => {
    const s = polled(initialState(size, 0), [agent("b", "z"), agent("c", "a"), agent("a", "z")]);
    expect(s.selectedAgentId).toBe("c");
    expect(s.error).toBeUndefined();
    expect(s.lastPollAt).toBe(1);
  });

  test("movement is clamped and the selection survives a reorder", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = keys(s, "jj");
    expect(s.selectedAgentId).toBe("c");
    s = keys(s, "j");
    expect(s.selectedAgentId).toBe("c");
    s = polled(s, [agent("c"), agent("a"), agent("b"), agent("0")]);
    expect(s.selectedAgentId).toBe("c");
    s = keys(s, "g");
    expect(s.selectedAgentId).toBe("0");
    s = keys(s, "G");
    expect(s.selectedAgentId).toBe("c");
  });

  test("a vanished selection falls to the row now at its index", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = keys(s, "j");
    s = polled(s, [agent("a"), agent("c")]);
    expect(s.selectedAgentId).toBe("c");
    s = polled(s, []);
    expect(s.selectedAgentId).toBeUndefined();
  });

  test("scrolling keeps the cursor on screen", () => {
    const many = Array.from({ length: 20 }, (_, i) => agent(String(i).padStart(2, "0")));
    let s = polled(initialState({ cols: 120, rows: 5 }, 0), many);
    // 5 rows: 3 for list items after the title and status rows.
    s = keys(s, "jjj");
    expect(s.selectedAgentId).toBe("03");
    expect(s.scroll.agents).toBe(1);
    s = keys(s, "G");
    expect(s.scroll.agents).toBe(17);
    s = keys(s, "\x1b[5~");
    expect(s.selectedAgentId).toBe("16");
    s = keys(s, "g");
    expect(s.scroll.agents).toBe(0);
  });

  test("filter narrows as you type, enter keeps it, escape clears it", () => {
    let s = polled(initialState(size, 0), [agent("alpha", "x"), agent("beta", "y")]);
    s = keys(s, "/be");
    expect(s.focus).toBe("filter");
    expect(s.filter).toBe("be");
    expect(s.selectedAgentId).toBe("beta");
    s = keys(s, "\x7f");
    expect(s.filter).toBe("b");
    s = keys(s, "\r");
    expect(s.focus).toBe("list");
    expect(s.filter).toBe("b");
    s = keys(s, "\x1b");
    expect(s.filter).toBe("");
    s = keys(s, "/q");
    expect(s.quit).toBe(false);
    s = keys(s, "\x1b");
    expect(s.filter).toBe("");
    expect(s.focus).toBe("list");
  });

  test("escape backs out one level at a time; q quits only from the list", () => {
    let s = polled(initialState(size, 0), [agent("a")]);
    s = keys(s, "?");
    expect(s.help).toBe(true);
    s = keys(s, "q");
    expect(s.help).toBe(false);
    expect(s.quit).toBe(false);
    s = keys(s, "\r");
    expect(s.focus).toBe("detail");
    s = keys(s, "\x1b");
    expect(s.focus).toBe("list");
    s = keys(s, "\t\t");
    expect(s.focus).toBe("list");
    s = keys(s, "q");
    expect(s.quit).toBe(true);
    expect(keys(polled(initialState(size, 0), []), "\x03").quit).toBe(true);
  });

  test("the log follows new messages while the cursor is on the last row", () => {
    let s = keys(initialState(size, 0), "2");
    expect(s.view).toBe("log");
    s = polled(s, [], [message(1, "a", "b"), message(2, "b", "a")]);
    expect(s.selectedSeq).toBe(2);
    s = polled(s, [], [message(1, "a", "b"), message(2, "b", "a"), message(3, "a", "b")]);
    expect(s.selectedSeq).toBe(3);
    s = keys(s, "k");
    s = polled(
      s,
      [],
      [1, 2, 3, 4].map((n) => message(n, "a", "b")),
    );
    expect(s.selectedSeq).toBe(2);
  });

  test("resize and poll errors keep the data", () => {
    let s = polled(initialState(size, 0), [agent("a")]);
    s = update(s, { type: "pollError", error: "down", at: 5 });
    expect(s.agents).toHaveLength(1);
    expect(s.error).toBe("down");
    s = update(s, { type: "resize", size: { cols: 40, rows: 10 } });
    expect(s.size.cols).toBe(40);
    s = polled(s, [agent("a")]);
    expect(s.error).toBeUndefined();
  });
});
