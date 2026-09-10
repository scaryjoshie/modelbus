import type { Agent, Message, State } from "./state.ts";

/**
 * What the lists show: the last poll's data, filtered by the filter text and in a
 * fixed order. Computed from state on demand; `update` and the views both call
 * these, so the cursor and the drawing agree on which row is which.
 *
 * The order is fixed (host, then name; messages by sequence) so new data never
 * reorders rows that were already there. Comparison is by code unit, not locale,
 * so two machines with different locales list the same roster the same way.
 */

/** True when the filter is empty or some field contains it, ignoring case. */
function matches(filter: string, fields: Array<string | undefined>): boolean {
  const f = filter.toLowerCase();
  return f === "" || fields.some((s) => (s ?? "").toLowerCase().includes(f));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byHostThenName = (a: Agent, b: Agent): number =>
  compare(a.host, b.host) || compare(a.name, b.name);

const bySeq = (a: Message, b: Message): number => a.seq - b.seq;

/** The roster as the agents view lists it. */
export function visibleAgents(state: State): Agent[] {
  return state.agents
    .filter((a) => matches(state.filter, [a.name, a.host, a.cwd, a.status, a.title]))
    .sort(byHostThenName);
}

/** The message log as the log view lists it, oldest first. */
export function visibleMessages(state: State): Message[] {
  return state.messages
    .filter((m) => matches(state.filter, [m.fromName, m.toName, m.status, m.body]))
    .sort(bySeq);
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

/** The message under the cursor, if any. */
export function selectedMessage(state: State): Message | undefined {
  return state.messages.find((m) => m.seq === state.selectedSeq);
}
