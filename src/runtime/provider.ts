import type { DeliveryResult, Outbound } from "../core/delivery.ts";

/**
 * The runtime's contract with a host integration. Core does not consume it.
 *
 * Discovery, communication, self-identification, and setup are independent
 * capabilities. Grouping them in a provider does not require running them together.
 * Providers receive no core API or store; the runtime binds identities and routes
 * delivery. Host keys remain opaque to core.
 */

export type Relationship = "top-level" | "subagent" | "unknown";

/** One live session as a provider sees it. */
export interface Observation {
  /** The host's own identifier for this session. Stable across host restarts if the host's is. */
  key: string;
  /** Preferred display name; the core de-duplicates and follows it. */
  name: string;
  /** Only top-level sessions become agents. */
  relationship: Relationship;
  /** Whether the provider can deliver into this session right now. */
  reachable: boolean;
  /** Why not, or how, for humans reading `who`. */
  note?: string;
  pid?: number;
  cwd?: string;
  status?: string;
  title?: string;
  startedAt?: number;
}

/** What a process running inside a host session learns about itself. */
export interface SelfIdentity {
  host: string;
  key: string;
  name: string;
  /** Provider-specific runtime info to hand the daemon (e.g. a socket and token). */
  attach?: Record<string, unknown>;
}

export interface ConfigurePlan {
  describe: string[];
  apply(): Promise<string[]>;
}

export interface Discovery {
  /** Current observations. Empty means nothing seen; throw if discovery failed. */
  observe(): Promise<Observation[]>;
}

export interface Connector {
  /**
   * Put the message into the session, in whatever form the host takes. Call
   * onReceipt later if the provider can observe the session consuming it.
   */
  deliver(key: string, outbound: Outbound, onReceipt: () => void): Promise<DeliveryResult>;
  /** Accept runtime information a session hands over about itself (secrets stay here). */
  attach?(key: string, info: Record<string, unknown>): void;
}

export interface Provider {
  /** Existing wire/storage namespace; not an authentication credential. */
  readonly host: string;
  readonly discovery?: Discovery;
  readonly connector?: Connector;
  /** Inside a host's child process: which session is this? Null if unrecognized. */
  identifySelf?(): Promise<SelfIdentity | null>;
  /** What `init` writes for this host. */
  configure?(): ConfigurePlan;
}
