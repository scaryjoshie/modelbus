/**
 * The boundary between the host-agnostic core and each host.
 *
 * The core knows agents (its own ids and names). Each host adapter knows how its
 * host identifies a session and keeps that to itself: the `handle` it returns is a
 * sealed value the core stores and hands back, never reads. The only thing the core
 * does with identity is compare `key` strings the adapter derived from its handle.
 */

/** How long the adapter expects its handle to keep meaning the same agent. */
export type Durability = "process" | "session" | "permanent";

export type Relationship = "top-level" | "subagent" | "unknown";

export interface Observation {
  /** Sealed: only the adapter that produced it may interpret it. */
  handle: unknown;
  /** Opaque equality key derived from the handle. Unique within the host. */
  key: string;
  /** Preferred display name; the core de-duplicates and follows it until the user pins one. */
  name: string;
  durability: Durability;
  relationship: Relationship;
  parentKey?: string;
  /** How this observation was made. */
  evidence: string;
  /** Whether the adapter can deliver into this session right now. */
  reachable: boolean;
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
  evidence: string;
  /** Adapter-specific runtime info to hand the daemon (e.g. a socket and token). */
  attach?: Record<string, unknown>;
}

export interface ConfigurePlan {
  describe: string[];
  apply(): Promise<string[]>;
}

export interface HostAdapter {
  readonly host: string;
  /** Everything live on this host right now. Must not throw; return [] instead. */
  observe(): Promise<Observation[]>;
  /** Rebuild a handle from a key the adapter previously produced. */
  handleFromKey(key: string): unknown;
  /** Inside a process the host spawned: which of its sessions is this? Null if not this host. */
  identifySelf?(): Promise<SelfIdentity | null>;
  /** Put `text` into the session. Returns a short result word; calls onReceipt if it can observe reading. */
  deliver?(handle: unknown, text: string, marker: string, onReceipt: () => void): Promise<string>;
  /** Accept runtime information a session hands over about itself (secrets stay here). */
  attach?(handle: unknown, info: Record<string, unknown>): void;
  /** What `init` writes for this host. */
  configure?(): ConfigurePlan;
}
