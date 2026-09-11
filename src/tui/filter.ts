import type { Agent, Conversation, Message, State } from "./state.ts";

/**
 * What the lists show: the last poll's data, filtered by the filter text and in a
 * fixed order. Computed from state on demand; `update` and the views both call
 * these, so the cursor and the drawing agree on which row is which.
 *
 * The order is fixed (agents by host then name; conversations as the daemon
 * lists them, newest activity first; messages by sequence) so new data never
 * reorders rows that were already there. Comparison is by code unit, not
 * locale, so two machines with different locales list the same roster the same way.
 */

/** True when the filter is empty or some field contains it, ignoring case. */
function matches(filter: string, fields: Array<string | undefined>): boolean {
  const f = filter.toLowerCase();
  return f === "" || fields.some((s) => (s ?? "").toLowerCase().includes(f));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byHostThenName = (a: Agent, b: Agent): number =>
  compare(a.provider, b.provider) || compare(a.name, b.name);

const bySeq = (a: Message, b: Message): number => a.seq - b.seq;

/** The roster as the agents tab lists it. */
export function visibleAgents(state: State): Agent[] {
  return state.agents
    .filter((a) => matches(state.filter, [a.name, a.provider, a.cwd, a.status, a.title]))
    .sort(byHostThenName);
}

/** The conversations as the chats tab lists them, in the daemon's order. */
export function visibleConversations(state: State): Conversation[] {
  return state.conversations.filter((c) =>
    matches(state.filter, [
      conversationLabel(c),
      ...c.participants.map((p) => p.name),
      c.last?.body,
    ]),
  );
}

/** Messages the agent sent or received, oldest first. Names are unique on the bus. */
export function agentMessages(state: State, agent: Agent): Message[] {
  return state.messages
    .filter((m) => m.fromName === agent.name || m.toName === agent.name)
    .sort(bySeq);
}

/** The agent under the cursor, if any. */
export function selectedAgent(state: State): Agent | undefined {
  return state.agents.find((a) => a.id === state.selectedAgentId);
}

/** The conversation under the cursor, if any. */
export function selectedConversation(state: State): Conversation | undefined {
  return state.conversations.find((c) => c.id === state.selectedConversationId);
}

/** "#name" for a group, "dm" for a pair: the kind column of the chats list. */
export function conversationLabel(c: Conversation): string {
  return c.kind === "group" ? `#${c.name ?? ""}` : "dm";
}

/** How `history` and `log` name this conversation: "#name" or "a,b". */
export function conversationSpec(c: Conversation): string {
  if (c.kind === "group") return `#${c.name ?? ""}`;
  return c.participants.map((p) => p.name).join(",");
}
