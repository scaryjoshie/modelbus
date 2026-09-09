import type { HostAdapter, Observation } from "./core/adapter.ts";
import type { Agent, Store } from "./core/store.ts";

/**
 * Host-agnostic session tracking. Owns the reconcile loop: ask every adapter what
 * is live, match observations to agents by (host, key), create agents for new
 * ones, mark the rest gone. Also dispatches delivery to the right adapter with the
 * agent's sealed handle. It never interprets a handle or a key.
 */

export interface RosterEntry {
  id: string;
  name: string;
  host: string;
  state: Agent["state"];
  attestation?: "observed" | "attested";
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
  private reconciling: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    adapters: HostAdapter[],
  ) {
    for (const a of adapters) this.adapters.set(a.host, a);
  }

  adapter(host: string): HostAdapter | undefined {
    return this.adapters.get(host);
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
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
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
        // classifications never silently turn into agents (spec section 6).
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
        this.store.upsertPresence(agent.id, {
          pid: o.pid ?? null,
          tty: null,
          cwd: o.cwd ?? null,
          status: o.status ?? null,
          title: o.title ?? null,
          relationship: o.relationship,
          parent_key: o.parentKey ?? null,
          reachable: o.reachable ? 1 : 0,
          note: o.note ?? null,
          started_at: o.startedAt ?? null,
        });
      }
      for (const a of this.store.listAgents(["live"])) {
        if (a.host === adapter.host && !seen.has(a.id)) this.store.setState(a.id, "gone");
      }
    }
  }

  /**
   * A session identifying itself (hook or shim). Stronger than observation: the
   * handle becomes attested. Returns the agent.
   */
  identify(opts: { host: string; key: string; name: string; evidence: string }): Agent {
    const adapter = this.adapters.get(opts.host);
    const handle = adapter ? adapter.handleFromKey(opts.key) : { key: opts.key };
    return this.store.bind({
      host: opts.host,
      key: opts.key,
      handle,
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
  ): Promise<string> {
    const h = this.store.handleOf(agent.id);
    const adapter = h && this.adapters.get(h.host);
    if (!h || !adapter?.deliver) return "none";
    try {
      return await adapter.deliver(JSON.parse(h.handle), text, marker, onReceipt);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  list(filter?: string, states: Agent["state"][] = ["live"]): RosterEntry[] {
    const entries = this.store.listAgents(states).map((a) => {
      const p = this.store.presenceOf(a.id);
      const h = this.store.handleOf(a.id);
      return {
        id: a.id,
        name: a.name,
        host: a.host,
        state: a.state,
        attestation: h?.attestation,
        cwd: p?.cwd ?? undefined,
        status: p?.status ?? undefined,
        title: p?.title ?? undefined,
        relationship: p?.relationship,
        reachable: a.host === "cli" ? true : Boolean(p?.reachable),
        note: p?.note ?? undefined,
        lastSeen: a.last_seen,
      } satisfies RosterEntry;
    });
    entries.sort((x, y) => Number(y.reachable) - Number(x.reachable) || y.lastSeen - x.lastSeen);
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) =>
      [e.name, e.host, e.cwd ?? "", e.title ?? ""].some((s) => s.toLowerCase().includes(f)),
    );
  }
}
