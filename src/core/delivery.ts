import type { AgentRow, MessageRow } from "./schema.ts";

/**
 * A message on its way to one recipient: the stored message and who sent it.
 * Whoever holds the recipient's line decides how to present it to the host and
 * how to recognize its receipt. Core hands over facts, not text.
 */
export interface Outbound {
  message: MessageRow;
  from: AgentRow;
}

/**
 * What happened to a message for one recipient. Sending is synchronous: either the
 * server accepted the message or `send` threw. After that each recipient's copy is
 * in exactly one of these states.
 */
export type DeliveryStatus =
  /** the server has it; pushed into the host's queue, or waiting for the recipient to pull */
  | "queued"
  /** the recipient's session has consumed it (transcript shows it, or it was pulled) */
  | "received"
  /** the push was attempted and failed; the recipient can still pull it */
  | "failed";

/** Initial delivery result. Receipt comes later, via onReceipt. */
export interface DeliveryResult {
  status: "queued" | "failed";
  /** How it was queued, or why it failed. */
  detail?: string;
}

export const queued = (detail?: string): DeliveryResult => ({ status: "queued", detail });
export const failed = (detail: string): DeliveryResult => ({ status: "failed", detail });
