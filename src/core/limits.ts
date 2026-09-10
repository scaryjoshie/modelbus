/**
 * Policy the bus enforces on callers. Every value has a default; whoever creates
 * the API or the daemon overrides what it needs. None of these is a protocol
 * invariant; the one real constraint is that `maxWaitSeconds` stays below the
 * daemon's socket idle timeout, which the daemon checks at startup.
 */
export interface Limits {
  /** Largest message body, in bytes. */
  bodyCapBytes: number;
  /** An identical (from, to, body) inside this window is dropped. */
  dedupeWindowMs: number;
  /** Sends per sender per `rateWindowMs`; excess refused up front. */
  rateLimit: number;
  rateWindowMs: number;
  /** Longest a pull or send(wait) may block; longer requests are capped, not refused. */
  maxWaitSeconds: number;
  /** Default and largest number of items one pull returns. */
  pullLimit: number;
}

export const DEFAULT_LIMITS: Limits = {
  bodyCapBytes: 65_536,
  dedupeWindowMs: 60_000,
  rateLimit: 10,
  rateWindowMs: 60_000,
  maxWaitSeconds: 240,
  pullLimit: 50,
};
