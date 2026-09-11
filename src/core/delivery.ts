import type { AgentRow, ConversationRow, MessageRow } from "./schema.ts";

/**
 * A message on its way to one recipient: the stored message and who sent it.
 * Whoever holds the recipient's line decides how to present it to the host and
 * how to recognize it being read. Core hands over facts, not text.
 */
export interface Outbound {
  message: MessageRow;
  from: AgentRow;
  conversation: ConversationRow;
}

/**
 * Where a message stands for one recipient. Sending is synchronous: either the
 * daemon stored the message or `send` threw. After that each recipient's copy is
 * in exactly one of these states. "Pending" (the sender has it, the daemon does
 * not) exists only inside a client.
 */
export type DeliveryStatus =
  /** the daemon has it; nothing has reached the recipient yet */
  | "sent"
  /** it reached the recipient's host: the push was accepted */
  | "delivered"
  /** it is in the recipient's context: the host transcript shows it, or a pull returned it */
  | "read"
  /** the push was rejected; the message stays and can still be pulled */
  | "failed";

/**
 * What one push attempt produced. `read` is never a push result; it comes later,
 * through onRead or a pull. `sent` means no push happened and the message waits.
 */
export interface DeliveryResult {
  status: "sent" | "delivered" | "failed";
  /** Why it only counts as sent, how it was delivered, or why it failed. */
  detail?: string;
}

export const sent = (detail: string): DeliveryResult => ({ status: "sent", detail });
export const delivered = (detail?: string): DeliveryResult => ({ status: "delivered", detail });
export const failed = (detail: string): DeliveryResult => ({ status: "failed", detail });
