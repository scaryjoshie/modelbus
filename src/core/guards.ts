/**
 * Every protocol-level limit in one place. These are defaults, not tuned values.
 * No wake budget in v0 (Joshua, 2026-09-07).
 */
export const GUARDS = {
  /** Identical (from, to, body) inside this window is dropped. */
  DEDUPE_WINDOW_MS: 60_000,
  /** Sends per sender per RATE_WINDOW_MS; excess refused up front. */
  RATE_LIMIT: 10,
  RATE_WINDOW_MS: 60_000,
  /** Message body cap in bytes. */
  BODY_CAP_BYTES: 65_536,
  /**
   * Max seconds a pull or send(wait) may block. The daemon's socket idle timeout
   * must exceed this; Bun caps that at 255 s.
   */
  MAX_WAIT_SECONDS: 240,
  /** Default and max items returned by one pull. */
  PULL_LIMIT: 50,
} as const;
