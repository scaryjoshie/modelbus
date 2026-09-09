import type { HostAdapter, Observation } from "./core/adapter.ts";
import type { DeliveryResult } from "./core/delivery.ts";
import type { Agent, AgentState, Attestation, Store } from "./core/store.ts";

/**
 * Host-agnostic session tracking. Owns the reconcile loop: ask every adapter what
 * is live, match observations to agents by (host, key), create agents for new
 * ones, mark the rest gone. Dispatches delivery to the right adapter with the
 * agent's sealed handle. Never interprets a handle or a key.
 */

export interface RosterEntry {
  id: string;
  name: string;
  host: string;
  state: AgentState;
  attestation?: Attestation;
  cwd?: string;
  status?: string;
  title?: string;
  relationship?: string;
  reachable: boolean;
  note?: string;
  lastSeen: number;
}

export class Tracker {
  private readonly adapters = new Map<string, HostAdapter>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    adapters: HostAdapter[],
  ) {
    for (const a of adapters) this.adapters.set(a.host, a);
  }

  start(intervalMs = 3000): void {
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
        continue; // an adapter failure never marks its agents gone
      }
      const seen = new Set<string>();
      for (const o of observations) {
        // Only confirmed top-level sessions become peers; subagents and uncertain
        // classifications never silently turn into agents.
        if (o.relationship !== "top-level") continue;
        const agent = this.store.bind({
          host: adapter.host,
          key: o.key,
          handle: o.handle,
          durability: o.durability,
          preferredName: o.name,
          evidence: o.evidence,
        });
        seen.add(agent.id);
        this.store.upsertPresence(agent.id, o);
      }
      for (const a of this.store.listAgents(["live"])) {
        if (a.host === adapter.host && !seen.has(a.id)) this.store.setState(a.id, "gone");
      }
    }
  }

  /** A session identifying itself (hook or shim): stronger than observation. */
  identify(opts: { host: string; key: string; name: string; evidence: string }): Agent {
    const adapter = this.adapters.get(opts.host);
    return this.store.bind({
      host: opts.host,
      key: opts.key,
      handle: adapter ? adapter.handleFromKey(opts.key) : { key: opts.key },
      durability: "session",
      preferredName: opts.name,
      evidence: opts.evidence,
      attestation: "attested",
    });
  }

  /** Hand adapter-specific runtime info (e.g. a token) to the adapter for this agent. */
  attach(agentId: string, info: Record<string, unknown>): boolean {
    const h = this.store.handleOf(agentId);
    const adapter = h && this.adapters.get(h.host);
    if (!h || !adapter?.attach) return false;
    adapter.attach(JSON.parse(h.handle), info);
    return true;
  }

  /** Deliver rendered text into an agent's session via its adapter. */
  async deliver(
    agent: Agent,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const h = this.store.handleOf(agent.id);
    const adapter = h && this.adapters.get(h.host);
    if (!h || !adapter?.deliver) return { outcome: "waiting", detail: "no push path" };
    try {
      return await adapter.deliver(JSON.parse(h.handle), text, marker, onReceipt);
    } catch (e) {
      return { outcome: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  list(filter?: string, states: AgentState[] = ["live"]): RosterEntry[] {
    const entries = this.store.listAgents(states).map((a): RosterEntry => {
      const p = this.store.presenceOf(a.id);
      const h = this.store.handleOf(a.id);
      return {
        id: a.id,
        name: a.name,
        host: a.host,
        state: a.state as AgentState,
        attestation: h?.attestation as Attestation | undefined,
        cwd: p?.cwd ?? undefined,
        status: p?.status ?? undefined,
        title: p?.title ?? undefined,
        relationship: p?.relationship,
        reachable: a.host === "cli" || Boolean(p?.reachable),
        note: p?.note ?? undefined,
        lastSeen: a.lastSeen,
      };
    });
    entries.sort((x, y) => Number(y.reachable) - Number(x.reachable) || y.lastSeen - x.lastSeen);
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) =>
      [e.name, e.host, e.cwd ?? "", e.title ?? ""].some((s) => s.toLowerCase().includes(f)),
    );
  }
}
