import type { HostAdapter, Observation } from "./core/adapter.ts";
import type { DeliveryResult } from "./core/delivery.ts";
import type { Agent, Store } from "./core/store.ts";

/**
 * Host-agnostic session tracking. Owns the reconcile loop: ask every adapter what
 * is live, bind each observation to an agent by (host, key), and remember what was
 * seen. Presence lives here in memory, not in the store: it is re-observed every
 * few seconds and only the daemon needs it.
 *
 * An agent is live if an adapter saw it on its last pass, or if it called in
 * recently itself (registered processes and self-identified sessions).
 */

const RECONCILE_INTERVAL_MS = 3000;
/** An agent that called in this recently counts as live even if no adapter sees it. */
const CONTACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface Presence {
  reachable: boolean;
  note?: string;
  pid?: number;
  cwd?: string;
  status?: string;
  title?: string;
  startedAt?: number;
}

export interface RosterEntry extends Presence {
  id: string;
  name: string;
  host: string;
  lastSeen: number;
}

export class Tracker {
  private readonly adapters = new Map<string, HostAdapter>();
  /** host -> agent id -> what its adapter last observed. */
  private readonly present = new Map<string, Map<string, Presence>>();
  /** agent id -> last time it identified itself on the RPC. */
  private readonly contact = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    adapters: HostAdapter[],
  ) {
    for (const a of adapters) this.adapters.set(a.host, a);
  }

  start(intervalMs = RECONCILE_INTERVAL_MS): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every adapter. Concurrent calls share the in-flight pass. */
  reconcile(): Promise<void> {
    this.inFlight ??= this.reconcileOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async reconcileOnce(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      let observations: Observation[];
      try {
        observations = await adapter.observe();
      } catch {
        continue; // an adapter failure keeps its last presence rather than marking agents gone
      }
      const seen = new Map<string, Presence>();
      for (const o of observations) {
        // Only confirmed top-level sessions become peers; subagents and uncertain
        // classifications never silently turn into agents.
        if (o.relationship !== "top-level") continue;
        const agent = this.store.bind({ host: adapter.host, key: o.key, name: o.name });
        const { key: _key, name: _name, relationship: _rel, ...presence } = o;
        seen.set(agent.id, presence);
      }
      this.present.set(adapter.host, seen);
    }
  }

  /** Record that an agent called in (identified itself or used its token). */
  touch(agentId: string): void {
    this.contact.set(agentId, Date.now());
    this.store.touch(agentId);
  }

  /** A session identifying itself (hook or shim). */
  identify(opts: { host: string; key: string; name: string }): Agent {
    const agent = this.store.bind(opts);
    this.touch(agent.id);
    return agent;
  }

  /** Hand adapter-specific runtime info (e.g. a token) to the adapter for this agent. */
  attach(agent: Agent, info: Record<string, unknown>): boolean {
    const adapter = this.adapters.get(agent.host);
    if (!adapter?.attach) return false;
    adapter.attach(agent.hostKey, info);
    return true;
  }

  /** Deliver rendered text into an agent's session via its adapter. */
  async deliver(
    agent: Agent,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const adapter = this.adapters.get(agent.host);
    if (!adapter?.deliver) return { outcome: "waiting", detail: "no push path" };
    try {
      return await adapter.deliver(agent.hostKey, text, marker, onReceipt);
    } catch (e) {
      return { outcome: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private presenceOf(agent: Agent): Presence | undefined {
    const observed = this.present.get(agent.host)?.get(agent.id);
    if (observed) return observed;
    const last = this.contact.get(agent.id);
    if (last !== undefined && Date.now() - last < CONTACT_TIMEOUT_MS) {
      return { reachable: true, note: "by sync" };
    }
    return undefined;
  }

  /** Live agents, reachable first. */
  list(filter?: string): RosterEntry[] {
    const entries: RosterEntry[] = [];
    for (const a of this.store.listAgents()) {
      const p = this.presenceOf(a);
      if (p) entries.push({ id: a.id, name: a.name, host: a.host, lastSeen: a.lastSeen, ...p });
    }
    entries.sort((x, y) => Number(y.reachable) - Number(x.reachable) || y.lastSeen - x.lastSeen);
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) =>
      [e.name, e.host, e.cwd ?? "", e.title ?? ""].some((s) => s.toLowerCase().includes(f)),
    );
  }
}
