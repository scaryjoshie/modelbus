import { rpc } from "../client.ts";
import { HISTORY_PAGE_LIMIT } from "./actions.ts";
import type { Msg } from "./state.ts";

/**
 * The one place the TUI asks the daemon on a timer: `who`, `log` and
 * `conversations` every tick, and `history` for the selected conversation
 * while there is one. A UI may poll; models do not. Skips a tick while the
 * previous one is in flight, reports errors as messages and never throws.
 */

export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface SelectedChat {
  id: string;
  /** How `history` names it: "#group" or "a,b". */
  spec: string;
}

export interface PollOptions {
  intervalMs?: number;
  dispatch: (msg: Msg) => void;
  /** Replaceable for tests; defaults to the daemon's RPC client. */
  request?: typeof rpc;
  /** The conversation to fetch a page for this tick, if one is selected. */
  selected?: () => SelectedChat | undefined;
}

export function startPoller(opts: PollOptions): { stop: () => void } {
  const request = opts.request ?? rpc;
  const selected = opts.selected ?? (() => undefined);
  let inFlight = false;
  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const chat = selected();
      const [who, log, chats, page] = await Promise.all([
        request("who", {}),
        request("log", {}),
        request("conversations", {}),
        chat
          ? request("history", { conversation: chat.spec, limit: HISTORY_PAGE_LIMIT })
          : undefined,
      ]);
      const at = Date.now();
      // Candidates sit in the same list as agents, marked unregistered, keyed by
      // provider and session key since they have no id yet.
      const candidates = who.candidates.map((c) => ({
        ...c,
        id: `candidate:${c.provider}:${c.key}`,
        lastSeen: 0,
        purpose: null,
        registered: false,
      }));
      opts.dispatch({
        type: "poll",
        agents: [...who.agents.map((a) => ({ ...a, registered: true })), ...candidates],
        messages: log.rows,
        conversations: chats.conversations,
        at,
      });
      if (chat && page) opts.dispatch({ type: "history", id: chat.id, messages: page.items, at });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      opts.dispatch({ type: "pollError", error, at: Date.now() });
    } finally {
      inFlight = false;
    }
  }
  const timer = setInterval(tick, opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
