import { rpc } from "../client.ts";
import type { Msg } from "./state.ts";

/**
 * The one place the TUI asks the daemon anything: `who` and `log` on a fixed
 * interval. A UI may poll; models do not. Skips a tick while the previous one
 * is in flight, reports errors as messages and never throws.
 */

export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface PollOptions {
  intervalMs?: number;
  dispatch: (msg: Msg) => void;
  /** Replaceable for tests; defaults to the daemon's RPC client. */
  request?: typeof rpc;
}

export function startPoller(opts: PollOptions): { stop: () => void } {
  const request = opts.request ?? rpc;
  let inFlight = false;
  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const [who, log] = await Promise.all([request("who", {}), request("log", {})]);
      opts.dispatch({ type: "poll", agents: who.agents, messages: log.rows, at: Date.now() });
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
