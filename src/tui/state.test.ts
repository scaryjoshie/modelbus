import { describe, expect, test } from "bun:test";
import { parseKeys } from "./keys.ts";
import {
  type Agent,
  type ChatMessage,
  type Conversation,
  type Effect,
  initialState,
  type Message,
  type Msg,
  type State,
  update,
} from "./state.ts";

const agent = (id: string, host = "h", extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  host,
  lastSeen: 0,
  purpose: null,
  reachable: true,
  ...extra,
});

const dm = (id: string, a: string, b: string): Conversation => ({
  id,
  kind: "dm",
  key: `dm:${a}:${b}`,
  name: null,
  createdAt: 0,
  participants: [
    { id: a, name: a },
    { id: b, name: b },
  ],
  unread: 0,
});

const chatMessage = (seq: number, from = "a"): ChatMessage => ({
  seq,
  id: `m${seq}`,
  conversationId: "c1",
  fromAgentId: from,
  body: `hello ${seq}`,
  createdAt: 0,
  fromName: from,
  fromHost: "h",
});

const size = { cols: 120, rows: 8 };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const ENTER = "\r";

/** Feed keys; the last effect wins, which is all a key sequence ever produces. */
function keys(s: State, input: string): { state: State; effect?: Effect } {
  let effect: Effect | undefined;
  const state = parseKeys(input).reduce((st, key) => {
    const step = update(st, { type: "key", key });
    if (step.effect) effect = step.effect;
    return step.state;
  }, s);
  return { state, effect };
}
const typed = (s: State, input: string): State => keys(s, input).state;
const send = (s: State, msg: Msg): State => update(s, msg).state;
const polled = (
  s: State,
  agents: Agent[],
  messages: Message[] = [],
  conversations: Conversation[] = [],
) => send(s, { type: "poll", agents, messages, conversations, at: 1 });

describe("update: agents", () => {
  test("first poll selects the first row in host-then-name order", () => {
    const s = polled(initialState(size, 0), [agent("b", "z"), agent("c", "a"), agent("a", "z")]);
    expect(s.selectedAgentId).toBe("c");
    expect(s.error).toBeUndefined();
    expect(s.lastPollAt).toBe(1);
  });

  test("arrows move, clamped; the selection survives a reorder", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = typed(s, DOWN + DOWN);
    expect(s.selectedAgentId).toBe("c");
    s = typed(s, DOWN);
    expect(s.selectedAgentId).toBe("c");
    s = polled(s, [agent("c"), agent("a"), agent("b"), agent("0")]);
    expect(s.selectedAgentId).toBe("c");
    s = typed(s, UP + UP + UP + UP);
    expect(s.selectedAgentId).toBe("0");
  });

  test("a vanished selection falls to the first row, never to an unrelated one", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = typed(s, DOWN);
    s = polled(s, [agent("a"), agent("c")]);
    expect(s.selectedAgentId).toBe("a");
    s = polled(s, []);
    expect(s.selectedAgentId).toBeUndefined();
  });

  test("scrolling keeps the cursor on screen", () => {
    const many = Array.from({ length: 20 }, (_, i) => agent(String(i).padStart(2, "0")));
    let s = polled(initialState({ cols: 120, rows: 6 }, 0), many);
    // 6 rows: tabs, list title, 3 items, status.
    s = typed(s, DOWN.repeat(3));
    expect(s.selectedAgentId).toBe("03");
    expect(s.scroll.agents).toBe(1);
    s = typed(s, DOWN.repeat(16));
    expect(s.scroll.agents).toBe(17);
    s = typed(s, UP.repeat(19));
    expect(s.scroll.agents).toBe(0);
  });

  test("c marks and unmarks in order; polls drop marks for agents that left", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = typed(s, `c${DOWN}c${DOWN}c`);
    expect(s.pending).toEqual(["a", "b", "c"]);
    s = typed(s, `${UP}c`);
    expect(s.pending).toEqual(["a", "c"]);
    s = polled(s, [agent("a"), agent("b")]);
    expect(s.pending).toEqual(["a"]);
    s = typed(s, ESC);
    expect(s.pending).toEqual([]);
  });

  test("enter with two pending asks for their DM; with one, nothing", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    expect(keys(s, `c${ENTER}`).effect).toBeUndefined();
    s = typed(s, `c${DOWN}${DOWN}c`);
    expect(keys(s, ENTER).effect).toEqual({ type: "openDm", a: "a", b: "c" });
  });

  test("enter with three pending prompts for a group name, then creates it", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = typed(s, `c${DOWN}c${DOWN}c${ENTER}`);
    expect(s.prompt).toEqual({ kind: "group", text: "", members: ["a", "b", "c"] });
    // q is a character here, not quit; enter on an empty name does nothing.
    s = typed(s, `${ENTER}q`);
    expect(s.quit).toBe(false);
    expect(s.prompt?.text).toBe("q");
    s = typed(s, "\x7f");
    const r = keys(s, `ops${ENTER}`);
    expect(r.effect).toEqual({ type: "createGroup", name: "ops", members: ["a", "b", "c"] });
    expect(r.state.prompt).toBeUndefined();
    expect(r.state.pending).toEqual([]);
  });

  test("escape cancels a group prompt and keeps the marks", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b"), agent("c")]);
    s = typed(s, `c${DOWN}c${DOWN}c${ENTER}op${ESC}`);
    expect(s.prompt).toBeUndefined();
    expect(s.pending).toEqual(["a", "b", "c"]);
  });

  test("r prompts to rename the selected agent; enter with a name is the effect", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b")]);
    s = typed(s, `${DOWN}r`);
    expect(s.prompt).toEqual({ kind: "rename", text: "", agent: "b" });
    const r = keys(s, `bee ${ENTER}`);
    expect(r.effect).toEqual({ type: "rename", agent: "b", name: "bee" });
    expect(r.state.prompt).toBeUndefined();
    expect(keys(typed(s, "x"), ESC).effect).toBeUndefined();
  });

  test("a created conversation switches tabs, clears marks and filter, and selects it", () => {
    let s = polled(initialState(size, 0), [agent("a"), agent("b")]);
    s = typed(s, `c${DOWN}cfa\r`);
    s = send(s, {
      type: "conversationCreated",
      id: "c1",
      conversations: [dm("c1", "a", "b")],
      messages: [chatMessage(1)],
    });
    expect(s.tab).toBe("chats");
    expect(s.focus).toBe("list");
    expect(s.filter).toBe("");
    expect(s.pending).toEqual([]);
    expect(s.selectedConversationId).toBe("c1");
    expect(s.history).toEqual({ id: "c1", messages: [chatMessage(1)] });
  });

  test("a failed action is a notice until the next key", () => {
    let s = send(initialState(size, 0), { type: "actionFailed", error: "name taken" });
    expect(s.notice).toBe("name taken");
    s = typed(s, DOWN);
    expect(s.notice).toBeUndefined();
  });
});

describe("update: filter and prompts", () => {
  test("f filters as you type, enter keeps it, escape clears it", () => {
    let s = polled(initialState(size, 0), [agent("alpha", "x"), agent("beta", "y")]);
    s = typed(s, "fbe");
    expect(s.prompt).toEqual({ kind: "filter", text: "be" });
    expect(s.filter).toBe("be");
    expect(s.selectedAgentId).toBe("beta");
    s = typed(s, "\x7f");
    expect(s.filter).toBe("b");
    s = typed(s, ENTER);
    expect(s.prompt).toBeUndefined();
    expect(s.filter).toBe("b");
    s = typed(s, ESC);
    expect(s.filter).toBe("");
    s = typed(s, "fq");
    expect(s.quit).toBe(false);
    s = typed(s, ESC);
    expect(s.filter).toBe("");
    expect(s.prompt).toBeUndefined();
  });

  test("the filter applies to the active tab and survives a tab switch", () => {
    let s = polled(initialState(size, 0), [agent("alpha")], [], [dm("c1", "alpha", "beta")]);
    s = typed(s, "fbeta\r");
    expect(s.selectedAgentId).toBeUndefined();
    s = typed(s, "\t");
    expect(s.tab).toBe("chats");
    expect(s.filter).toBe("beta");
    expect(s.selectedConversationId).toBe("c1");
  });

  test("ctrl+c quits inside a prompt; q does not", () => {
    const s = typed(initialState(size, 0), "fq");
    expect(s.quit).toBe(false);
    expect(typed(s, "\x03").quit).toBe(true);
  });
});

describe("update: chats", () => {
  const conversations = [dm("c1", "a", "b"), dm("c2", "a", "c")];
  const withChats = () =>
    keys(polled(initialState(size, 0), [agent("a"), agent("b")], [], conversations), "\t");
  const page = (id: string, seqs: number[], at = 2): Msg => ({
    type: "history",
    id,
    messages: seqs.map((n) => chatMessage(n)),
    at,
  });

  test("switching to the tab asks for the selected conversation's page at once", () => {
    const r = withChats();
    expect(r.state.selectedConversationId).toBe("c1");
    expect(r.effect).toEqual({ type: "loadHistory", id: "c1", spec: "a,b" });
    // Already asked: pressing keys that keep the selection does not ask again.
    expect(keys(r.state, "?").effect).toBeUndefined();
  });

  test("moving the list selects another conversation and asks for its page", () => {
    let s = withChats().state;
    s = send(s, page("c1", [1]));
    const r = keys(s, DOWN);
    expect(r.state.selectedConversationId).toBe("c2");
    expect(r.effect).toEqual({ type: "loadHistory", id: "c2", spec: "a,c" });
    // The old page stays until the new one lands; the view tells by the id.
    expect(r.state.history?.id).toBe("c1");
  });

  test("a page lands only on the selected conversation", () => {
    let s = withChats().state;
    s = send(s, page("c2", [9]));
    expect(s.history).toBeUndefined();
    s = send(s, page("c1", [1, 2]));
    expect(s.history?.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  test("enter gives the arrows to the messages pane; escape gives them back", () => {
    let s = withChats().state;
    s = send(
      s,
      page(
        "c1",
        Array.from({ length: 30 }, (_, i) => i + 1),
      ),
    );
    s = typed(s, ENTER);
    expect(s.focus).toBe("messages");
    const tail = s.scroll.messages;
    expect(tail).toBeGreaterThan(0);
    expect(typed(s, DOWN).scroll.messages).toBe(tail);
    s = typed(s, UP + UP);
    expect(s.scroll.messages).toBe(tail - 2);
    expect(s.selectedConversationId).toBe("c1");
    s = typed(s, ESC);
    expect(s.focus).toBe("list");
    expect(s.scroll.messages).toBe(tail - 2);
    s = typed(s, DOWN);
    expect(s.selectedConversationId).toBe("c2");
  });

  test("the pane follows the newest message while it shows the tail, else stays put", () => {
    let s = withChats().state;
    s = send(
      s,
      page(
        "c1",
        Array.from({ length: 30 }, (_, i) => i + 1),
      ),
    );
    const tail = s.scroll.messages;
    s = send(
      s,
      page(
        "c1",
        Array.from({ length: 31 }, (_, i) => i + 1),
        3,
      ),
    );
    expect(s.scroll.messages).toBeGreaterThan(tail);
    s = typed(s, `${ENTER}${UP}${UP}${UP}`);
    const held = s.scroll.messages;
    s = send(
      s,
      page(
        "c1",
        Array.from({ length: 32 }, (_, i) => i + 1),
        4,
      ),
    );
    expect(s.scroll.messages).toBe(held);
  });

  test("a new selection shows the tail once its page lands", () => {
    let s = withChats().state;
    s = send(
      s,
      page(
        "c1",
        Array.from({ length: 30 }, (_, i) => i + 1),
      ),
    );
    s = typed(s, `${ENTER}${UP}${UP}${ESC}${DOWN}`);
    expect(s.scroll.messages).toBe(0);
    s = send(
      s,
      page(
        "c2",
        Array.from({ length: 30 }, (_, i) => i + 1),
        3,
      ),
    );
    expect(s.scroll.messages).toBeGreaterThan(0);
    expect(typed(typed(s, ENTER), DOWN).scroll.messages).toBe(s.scroll.messages);
  });

  test("the filter applies to the list and clearing it keeps the pane in the list", () => {
    let s = withChats().state;
    s = typed(s, "fc\r");
    expect(s.selectedConversationId).toBe("c2");
    s = typed(s, ESC);
    expect(s.filter).toBe("");
    expect(s.focus).toBe("list");
  });
});

describe("update: common", () => {
  test("escape closes help first; q quits from either tab", () => {
    let s = polled(initialState(size, 0), [agent("a")]);
    s = typed(s, "?");
    expect(s.help).toBe(true);
    s = typed(s, ESC);
    expect(s.help).toBe(false);
    expect(typed(s, "q").quit).toBe(true);
    expect(typed(typed(s, "\t"), "q").quit).toBe(true);
    expect(typed(s, "\x03").quit).toBe(true);
  });

  test("resize and poll errors keep the data", () => {
    let s = polled(initialState(size, 0), [agent("a")]);
    s = send(s, { type: "pollError", error: "down", at: 5 });
    expect(s.agents).toHaveLength(1);
    expect(s.error).toBe("down");
    s = send(s, { type: "resize", size: { cols: 40, rows: 10 } });
    expect(s.size.cols).toBe(40);
    s = polled(s, [agent("a")]);
    expect(s.error).toBeUndefined();
  });
});
