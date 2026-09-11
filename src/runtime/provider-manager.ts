import type { DeliveryResult, Outbound } from "../core/delivery.ts";
import type { Agent, Store } from "../core/store.ts";
import type { Watch } from "../util/watch.ts";
import { discover } from "./discovery.ts";
import type { Observation, Provider } from "./provider.ts";

/**
 * Host-agnostic session tracking. Owns the reconcile loop: ask every provider what
 * is live and remember what was seen. Discovery makes candidates, not agents: a
 * session becomes an agent only when it registers (itself, or by being added to a
 * chat). Presence lives here in memory, not in the store: it is re-observed every
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
  /** When the agent last did anything: the host's record, or its last call to the daemon. */
  activeAt?: number;
}

export interface RosterEntry extends Presence {
  id: string;
  name: string;
  provider: string;
  lastSeen: number;
  /** What the agent is for, if anyone said. */
  purpose: string | null;
}

/** A session a provider sees that has not registered: visible, not yet on the bus. */
export interface Candidate extends Presence {
  provider: string;
  key: string;
  name: string;
}

export class ProviderManager {
  private readonly providers = new Map<string, Provider>();
  /** provider -> session key -> what it last observed (top-level sessions only). */
  private readonly observed = new Map<string, Map<string, Observation>>();
  /** agent id -> last time it identified itself on the RPC. */
  private readonly contact = new Map<string, number>();
  /** agent id -> a status the agent set for itself; shown when its host reports none. */
  private readonly statuses = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  /** The first pass after start(); already settled if start() was never called. */
  private firstPass: Promise<void> = Promise.resolve();
  /** Watches providers started on our behalf and have not finished. */
  private readonly open = new Set<Watch>();
  /** Agents reachable after the previous pass, to notice who just became reachable. */
  private wasReachable = new Set<string>();
  /**
   * Called once for each agent that is reachable now and was not on the previous
   * pass, with what its provider states about the host: whether messages the
   * host accepted survive a restart. The daemon points this at core's redeliver;
   * the manager does not know what happens.
   */
  onReachable?: (agent: Agent, host: { queueSurvivesRestart: boolean }) => Promise<void>;

  constructor(
    readonly store: Store,
    providers: Provider[],
  ) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  start(intervalMs = RECONCILE_INTERVAL_MS): void {
    this.firstPass = this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
  }

  /** Settles once the first pass since start() has completed. Never waits after that. */
  ready(): Promise<void> {
    return this.firstPass;
  }

  /** Clear the timer and close every watch still running. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.open) w[Symbol.dispose]();
    this.open.clear();
  }

  /** Number of watches still running; for tests and diagnostics. */
  get watching(): number {
    return this.open.size;
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
      const seen = new Map<string, Observation>();
      for (const o of result.observations) {
        // Only confirmed top-level sessions are candidates; subagents and uncertain
        // classifications never silently become agents.
        if (o.relationship === "top-level") seen.set(o.key, o);
      }
      this.observed.set(result.provider, seen);
      // A registered agent's name follows its host's until a person pins it.
      for (const o of seen.values()) {
        const agent = this.store.agentByKey(result.provider, o.key);
        if (agent && agent.name !== o.name && !agent.namePinned) {
          this.store.bind({ provider: result.provider, key: o.key, name: o.name });
        }
      }
    }
    await this.noticeReappearances();
  }

  private async noticeReappearances(): Promise<void> {
    const now = new Set<string>();
    for (const a of this.store.listAgents()) {
      if (!this.presenceOf(a)?.reachable) continue;
      now.add(a.id);
      if (this.wasReachable.has(a.id) || !this.onReachable) continue;
      // Untested hosts count as keeping their queue: that choice cannot duplicate.
      const survives = this.providers.get(a.provider)?.connector?.queueSurvivesRestart ?? true;
      // One failing callback must not stop the pass or the others.
      await this.onReachable(a, { queueSurvivesRestart: survives }).catch(() => undefined);
    }
    this.wasReachable = now;
  }

  /** Record that an agent called in (identified itself or used its token). */
  touch(agentId: string): void {
    this.contact.set(agentId, Date.now());
    this.store.touch(agentId);
  }

  /** An agent says what it is doing; empty clears it. Presence only, so it is gone on restart. */
  setStatus(agentId: string, text: string): void {
    if (text.trim()) this.statuses.set(agentId, text.trim());
    else this.statuses.delete(agentId);
  }

  /** The agent behind a self identity, if it has registered; contact is recorded either way. */
  agentFor(identity: { provider: string; key: string }): Agent | undefined {
    const agent = this.store.agentByKey(identity.provider, identity.key);
    if (agent) this.touch(agent.id);
    return agent;
  }

  /**
   * Registration: the one door into core. A session (its own, or one a person
   * or a chat pulled in) becomes an agent by (provider, key), with its purpose.
   */
  register(opts: { provider: string; key: string; name: string }): Agent {
    const agent = this.store.bind(opts);
    this.touch(agent.id);
    return agent;
  }

  /** Sessions seen by a provider that have not registered. */
  candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const [provider, seen] of this.observed) {
      for (const o of seen.values()) {
        if (this.store.agentByKey(provider, o.key)) continue;
        const { key, name, relationship: _rel, ...presence } = o;
        out.push({ provider, key, name, ...presence });
      }
    }
    return out;
  }

  /** The candidate a person means by this name, if any. */
  candidateNamed(name: string): Candidate | undefined {
    return this.candidates().find((c) => c.name === name);
  }

  /**
   * Hand provider-specific runtime info (e.g. a token) to the provider for a
   * session, registered or not: delivery needs it either way.
   */
  attach(identity: { provider: string; key: string }, info: Record<string, unknown>): boolean {
    const provider = this.providers.get(identity.provider);
    if (!provider?.connector?.attach) return false;
    provider.connector.attach(identity.key, info);
    return true;
  }

  /** Hand a message to the provider holding the agent's line. */
  async deliver(agent: Agent, outbound: Outbound, onRead: () => void): Promise<DeliveryResult> {
    const provider = this.providers.get(agent.provider);
    if (!provider?.connector) return { status: "sent", detail: "waiting for it to sync" };
    try {
      const { result, watch } = await provider.connector.deliver(agent.key, outbound, onRead);
      if (watch) {
        this.open.add(watch);
        void watch.done.then(() => this.open.delete(watch));
      }
      return result;
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private presenceOf(agent: Agent): Presence | undefined {
    const own = this.statuses.get(agent.id);
    const o = this.observed.get(agent.provider)?.get(agent.key);
    if (o) {
      const { key: _key, name: _name, relationship: _rel, ...observed } = o;
      return { ...observed, status: observed.status ?? own };
    }
    const last = this.contact.get(agent.id);
    if (last !== undefined && Date.now() - last < CONTACT_TIMEOUT_MS) {
      return { reachable: true, note: "by sync", activeAt: last, status: own };
    }
    return undefined;
  }

  /** Live agents, reachable first. */
  list(filter?: string): RosterEntry[] {
    const entries: RosterEntry[] = [];
    for (const a of this.store.listAgents()) {
      const p = this.presenceOf(a);
      if (p) {
        entries.push({
          id: a.id,
          name: a.name,
          provider: a.provider,
          lastSeen: a.lastSeen,
          purpose: a.purpose,
          ...p,
        });
      }
    }
    entries.sort((x, y) => Number(y.reachable) - Number(x.reachable) || y.lastSeen - x.lastSeen);
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) =>
      [e.name, e.provider, e.cwd ?? "", e.title ?? "", e.purpose ?? ""].some((s) =>
        s.toLowerCase().includes(f),
      ),
    );
  }
}
