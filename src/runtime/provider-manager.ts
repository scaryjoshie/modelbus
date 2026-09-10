import type { DeliveryResult, Outbound } from "../core/delivery.ts";
import type { Agent, Store } from "../core/store.ts";
import { discover } from "./discovery.ts";
import type { Provider } from "./provider.ts";

/**
 * Host-agnostic session tracking. Owns the reconcile loop: ask every provider what
 * is live, bind each observation to an agent by (host, key), and remember what was
 * seen. Presence lives here in memory, not in the store: it is re-observed every
 * few seconds and only the daemon needs it.
 *
 * An agent is live if a provider saw it on its last pass, or if it called in
 * recently itself (registered processes and self-identified sessions).
 */

const RECONCILE_INTERVAL_MS = 3000;
/** An agent that called in this recently counts as live even if no provider sees it. */
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

export class ProviderManager {
  private readonly providers = new Map<string, Provider>();
  /** host -> agent id -> what its provider last observed. */
  private readonly present = new Map<string, Map<string, Presence>>();
  /** agent id -> last time it identified itself on the RPC. */
  private readonly contact = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    providers: Provider[],
  ) {
    for (const a of providers) this.providers.set(a.host, a);
  }

  start(intervalMs = RECONCILE_INTERVAL_MS): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every provider. Concurrent calls share the in-flight pass. */
  reconcile(): Promise<void> {
    this.inFlight ??= this.reconcileOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async reconcileOnce(): Promise<void> {
    for (const result of await discover([...this.providers.values()])) {
      // A failed discovery is not evidence that the provider's sessions disappeared.
      if (result.status === "failed") continue;
      const seen = new Map<string, Presence>();
      for (const o of result.observations) {
        // Only confirmed top-level sessions become peers; subagents and uncertain
        // classifications never silently turn into agents.
        if (o.relationship !== "top-level") continue;
        // Current POC policy: automatically bind observed top-level sessions.
        // Discovery itself does not register them; explicit connection can replace
        // this policy without changing provider discovery or the core API.
        const agent = this.store.bind({ host: result.host, key: o.key, name: o.name });
        const { key: _key, name: _name, relationship: _rel, ...presence } = o;
        seen.set(agent.id, presence);
      }
      this.present.set(result.host, seen);
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

  /** Hand provider-specific runtime info (e.g. a token) to the provider for this agent. */
  attach(agent: Agent, info: Record<string, unknown>): boolean {
    const provider = this.providers.get(agent.host);
    if (!provider?.connector?.attach) return false;
    provider.connector.attach(agent.hostKey, info);
    return true;
  }

  /** Hand a message to the provider holding the agent's line. */
  async deliver(agent: Agent, outbound: Outbound, onRead: () => void): Promise<DeliveryResult> {
    const provider = this.providers.get(agent.host);
    if (!provider?.connector) return { status: "sent", detail: "waiting for it to sync" };
    try {
      return await provider.connector.deliver(agent.hostKey, outbound, onRead);
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
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
