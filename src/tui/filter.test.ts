import { describe, expect, test } from "bun:test";
import { agentMessages, visibleAgents, visibleMessages } from "./filter.ts";
import { type Agent, initialState, type Message, type State } from "./state.ts";

const agent = (name: string, host: string, extra: Partial<Agent> = {}): Agent => ({
  id: `id-${name}`,
  name,
  host,
  lastSeen: 0,
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

  test("filters by substring, ignoring case, on name, host, cwd, status and title", () => {
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

describe("visibleMessages", () => {
  test("orders by sequence and filters on from, to, status and body", () => {
    const rows = [
      message(3, "amy", "bob", { status: "failed" }),
      message(1, "bob", "amy", { body: "Ship it\nsecond line" }),
      message(2, "amy", "cat"),
    ];
    expect(seqs(visibleMessages(withData([], rows)))).toEqual([1, 2, 3]);
    expect(seqs(visibleMessages(withData([], rows, "cat")))).toEqual([2]);
    expect(seqs(visibleMessages(withData([], rows, "FAIL")))).toEqual([3]);
    expect(seqs(visibleMessages(withData([], rows, "second")))).toEqual([1]);
    expect(seqs(visibleMessages(withData([], rows, "amy")))).toEqual([1, 2, 3]);
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
