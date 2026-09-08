import type { HostKind } from "../types.ts";

/**
 * The boundary between the host-agnostic core and each host.
 *
 * The core knows agents (its own ids and names). Each host adapter knows how its
 * host identifies a session, and keeps that knowledge to itself: the `handle` it
 * returns is a sealed value the core stores and hands back, never reads. The only
 * thing the core does with identity is compare `key` strings the adapter derived
 * from its handle, for equality and indexing. What a key means is the adapter's
 * business. See docs/poc-spec.md section 6.
 */

/** How long the adapter expects its handle to keep meaning the same agent. */
export type Durability =
  | "process" // dies with the process (e.g. only a pid is known)
  | "session" // survives process restarts of the same host session (resume)
  | "permanent"; // stored by the host indefinitely (e.g. a browser session record)

export type Relationship = "top-level" | "subagent" | "unknown";

export interface Observation {
  /** Sealed: only the adapter that produced it may interpret it. */
  handle: unknown;
  /** Opaque equality key derived from the handle. Unique within the host. */
  key: string;
  /** Preferred display name; the core de-duplicates. */
  name: string;
  durability: Durability;
  relationship: Relationship;
  /** Key of the parent observation when relationship is subagent. */
  parentKey?: string;
  /** Free-text description of how this observation was made. */
  evidence: string;
  /** Whether the adapter can deliver into this session right now. */
  reachable: boolean;
  /** Short reason when not reachable. */
  note?: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  status?: string;
  title?: string;
  startedAt?: number;
}

export interface ConfigurePlan {
  /** Human-readable description of what apply() would change. */
  describe: string[];
  apply(): Promise<string[]>;
}

export interface HostAdapter {
  readonly host: HostKind;
  /** Everything live on this host right now. Must not throw; return [] instead. */
  observe(): Promise<Observation[]>;
  /** Rebuild a handle from a key the adapter previously produced. */
  handleFromKey(key: string): unknown;
  /**
   * Put `text` into the session. Returns a short result word. Call `onReceipt`
   * later if the adapter can observe the host reading the message.
   */
  deliver?(handle: unknown, text: string, marker: string, onReceipt: () => void): Promise<string>;
  /** Accept runtime information a session hands over about itself (secrets stay here). */
  attach?(handle: unknown, info: Record<string, unknown>): void;
  /** What `init` writes for this host. */
  configure?(): ConfigurePlan;
}
