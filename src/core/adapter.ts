import type { DeliveryResult } from "./delivery.ts";

/**
 * The boundary between the host-agnostic core and each host.
 *
 * A host adapter is whoever holds the line to a kind of agent. It reports which
 * sessions exist (`observe`) and pushes text into one (`deliver`). The core knows
 * an agent only by the adapter's `key` for it, which it stores and hands back;
 * everything else the adapter needs it re-derives from its host at call time.
 */

export type Relationship = "top-level" | "subagent" | "unknown";

/** One live session as an adapter sees it. */
export interface Observation {
  /** The host's own identifier for this session. Stable across host restarts if the host's is. */
  key: string;
  /** Preferred display name; the core de-duplicates and follows it. */
  name: string;
  /** Only top-level sessions become agents. */
  relationship: Relationship;
  /** Whether the adapter can deliver into this session right now. */
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
  /** Adapter-specific runtime info to hand the daemon (e.g. a socket and token). */
  attach?: Record<string, unknown>;
}

export interface ConfigurePlan {
  describe: string[];
  apply(): Promise<string[]>;
}

/** Facilities a CLI command contributed by an adapter may use. */
export interface CommandContext {
  args: string[];
  stdin(): Promise<string>;
  rpc<T>(method: string, params: Record<string, unknown>, identity?: unknown): Promise<T>;
  ensureDaemon(): Promise<void>;
}

export interface Command {
  usage: string;
  /** Runs without the daemon (the CLI starts it for every other command). */
  standalone?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

export interface HostAdapter {
  readonly host: string;
  /** Everything live on this host right now. Must not throw; return [] instead. */
  observe(): Promise<Observation[]>;
  /** Inside a process the host spawned: which of its sessions is this? Null if not this host. */
  identifySelf?(): Promise<SelfIdentity | null>;
  /** Put `text` into the session; call onReceipt later if the adapter can observe it being read. */
  deliver?(
    key: string,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult>;
  /** Accept runtime information a session hands over about itself (secrets stay here). */
  attach?(key: string, info: Record<string, unknown>): void;
  /** What `init` writes for this host. */
  configure?(): ConfigurePlan;
  /** CLI verbs this host needs (e.g. a hook entry point). */
  commands?(): Record<string, Command>;
}
