/**
 * Every tunable limit in one place. See docs/poc-spec.md section 8.
 * No wake budget in v0 (Joshua, 2026-09-07).
 */
export const GUARDS = {
  /** Identical (from, to, body) inside this window is dropped. */
  DEDUPE_WINDOW_MS: 60_000,
  /** Sends per sender per rolling minute; excess refused up front. */
  RATE_LIMIT_PER_MINUTE: 10,
  /** Message body cap in bytes. */
  BODY_CAP_BYTES: 65_536,
  /** Max seconds a pull or send(wait) may block. */
  MAX_WAIT_SECONDS: 600,
  /** Default and max lines returned by one pull. */
  PULL_LIMIT: 50,
} as const;
