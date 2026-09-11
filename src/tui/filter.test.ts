import { describe, expect, test } from "bun:test";
import {
  agentMessages,
  conversationLabel,
  conversationSpec,
  visibleAgents,
  visibleConversations,
} from "./filter.ts";
import { type Agent, type Conversation, initialState, type Message, type State } from "./state.ts";

const agent = (name: string, provider: string, extra: Partial<Agent> = {}): Agent => ({
  id: `id-${name}`,
  name,
  provider,
  lastSeen: 0,
  purpose: null,
  reachable: true,
  ...extra,
});

const message = (seq: number, from: string, to: string, extra: Partial<Message> = {}): Message => ({
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
  ...extra,
});

const conversation = (
  id: string,
  kind: "dm" | "group",
  members: string[],
  extra: Partial<Conversation> = {},
): Conversation => ({
  id,
  kind,
  key: `${kind}:${id}`,
  name: kind === "group" ? id : null,
  createdAt: 0,
  participants: members.map((name) => ({ id: `id-${name}`, name })),
  unread: 0,
  ...extra,
});

const withData = (agents: Agent[], messages: Message[] = [], filter = ""): State => ({
  ...initialState({ cols: 80, rows: 24 }, 0),
  agents,
  messages,
  filter,
});

const names = (agents: Agent[]) => agents.map((a) => a.name);
const seqs = (messages: Message[]) => messages.map((m) => m.seq);

describe("visibleAgents", () => {
  test("sorts by host then name, by code unit, and keeps equal rows in input order", () => {
    const rows = [
      agent("zed", "zephyr"),
      agent("amy", "zephyr"),
      agent("Bob", "apex"),
      agent("bob", "apex"),
      agent("dup", "apex", { id: "first" }),
      agent("dup", "apex", { id: "second" }),
    ];
    const out = visibleAgents(withData(rows));
    expect(names(out)).toEqual(["Bob", "bob", "dup", "dup", "amy", "zed"]);
    expect(out.map((a) => a.id).slice(2, 4)).toEqual(["first", "second"]);
  });

  test("does not reorder the input", () => {
    const rows = [agent("b", "h"), agent("a", "h")];
    const state = withData(rows);
    visibleAgents(state);
    expect(names(state.agents)).toEqual(["b", "a"]);
  });

  test("filters by substring, ignoring case, on name, provider, cwd, status and title", () => {
    const rows = [
      agent("planner", "north-shell", { cwd: "~/work/app", status: "idle", title: "Refactor" }),
      agent("tester", "zephyr", { cwd: "~/work/lib", status: "busy" }),
    ];
    const by = (filter: string) => names(visibleAgents(withData(rows, [], filter)));
    expect(by("PLAN")).toEqual(["planner"]);
    expect(by("zephyr")).toEqual(["tester"]);
    expect(by("/lib")).toEqual(["tester"]);
    expect(by("idle")).toEqual(["planner"]);
    expect(by("refactor")).toEqual(["planner"]);
    expect(by("work")).toEqual(["planner", "tester"]);
    expect(by("id-")).toEqual([]);
    expect(by("nothing")).toEqual([]);
  });
});

describe("visibleConversations", () => {
  const rows = [
    conversation("ops", "group", ["amy", "bob"], {
      last: { seq: 2, fromName: "amy", body: "Ship it", createdAt: 0 },
    }),
    conversation("c2", "dm", ["amy", "cat"]),
    conversation("c3", "dm", ["bob", "dan"], {
      last: { seq: 1, fromName: "dan", body: "hello ops", createdAt: 0 },
    }),
  ];
  const ids = (filter: string) =>
    visibleConversations({ ...withData([], [], filter), conversations: rows }).map((c) => c.id);

  test("keeps the daemon's order and filters on label, members and the last body", () => {
    expect(ids("")).toEqual(["ops", "c2", "c3"]);
    expect(ids("#ops")).toEqual(["ops"]);
    expect(ids("ops")).toEqual(["ops", "c3"]);
    expect(ids("CAT")).toEqual(["c2"]);
    expect(ids("dm")).toEqual(["c2", "c3"]);
    expect(ids("ship")).toEqual(["ops"]);
    expect(ids("zzz")).toEqual([]);
  });

  test("label and spec: #name for a group, dm and a,b for a pair", () => {
    expect(conversationLabel(rows[0] as Conversation)).toBe("#ops");
    expect(conversationSpec(rows[0] as Conversation)).toBe("#ops");
    expect(conversationLabel(rows[1] as Conversation)).toBe("dm");
    expect(conversationSpec(rows[1] as Conversation)).toBe("amy,cat");
  });
});

describe("agentMessages", () => {
  test("returns messages to or from the agent, oldest first, regardless of the filter", () => {
    const rows = [
      message(5, "cat", "bob"),
      message(2, "amy", "bob"),
      message(1, "bob", "amy"),
      message(4, "amy", "cat"),
    ];
    const state = withData([], rows, "cat");
    expect(seqs(agentMessages(state, agent("bob", "h")))).toEqual([1, 2, 5]);
    expect(seqs(agentMessages(state, agent("dan", "h")))).toEqual([]);
  });
});
