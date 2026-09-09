import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The bus schema, defined once. Drizzle derives row types and migrations from it.
 *
 * Only what must survive a daemon restart lives here: who the agents are and what
 * was said. Presence (who is live and reachable right now) is re-observed every few
 * seconds and kept in the tracker's memory.
 */

/**
 * An agent: our permanent id and display name, plus the host that holds its line
 * and the host's own key for it. Same (host, hostKey) is the same agent forever.
 * The key is opaque to the core; only the host's adapter knows what it means.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    host: text("host").notNull(),
    hostKey: text("host_key").notNull(),
    lastSeen: integer("last_seen").notNull(),
  },
  (t) => [uniqueIndex("agents_host_key").on(t.host, t.hostKey)],
);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  /** dm (groups later) */
  kind: text("kind").notNull(),
  key: text("key").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const participants = sqliteTable(
  "participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.agentId] })],
);

export const messages = sqliteTable(
  "messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    /** Short random id; appears in the delivered text as the receipt marker. */
    id: text("id").notNull().unique(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_conv_seq").on(t.conversationId, t.seq)],
);

/** One row per (message, recipient). `receivedAt` is the read receipt. */
export const deliveries = sqliteTable(
  "deliveries",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id),
    /** DeliveryOutcome, once the push was attempted */
    outcome: text("outcome"),
    detail: text("detail"),
    receivedAt: integer("received_at"),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.toAgentId] }),
    index("deliveries_inbox").on(t.toAgentId, t.receivedAt),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
