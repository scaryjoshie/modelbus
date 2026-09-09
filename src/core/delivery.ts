/**
 * What happened when the bus tried to put a message into a host session.
 * A typed union rather than a string so every caller handles every case.
 */
export type DeliveryOutcome =
  /** the host accepted it into the session (queue, socket, or command) */
  | "delivered"
  /** accepted, but the host may still hold it for the user (Claude Code, no token) */
  | "delivered-unattested"
  /** stored; the recipient must pull it (no push path for this host) */
  | "waiting"
  /** returned inline to a caller blocked in send(wait); not pushed to the host */
  | "returned-to-waiter"
  /** the host cannot be reached right now (no socket, no adapter, not queueable) */
  | "unavailable"
  /** the push was attempted and failed */
  | "error";

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  /** Short human-readable reason for unavailable/error, or the mechanism used. */
  detail?: string;
}

export const delivered = (detail?: string): DeliveryResult => ({ outcome: "delivered", detail });
export const unavailable = (detail: string): DeliveryResult => ({ outcome: "unavailable", detail });
export const failed = (detail: string): DeliveryResult => ({ outcome: "error", detail });
