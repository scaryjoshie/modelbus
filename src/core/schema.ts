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
 * See docs/poc-spec.md section 5.
 */

/** Agents are ours: id, name, host kind, state. Nothing host-shaped lives here. */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  host: text("host").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeen: integer("last_seen").notNull(),
  /** live | gone | unknown */
  state: text("state").notNull().default("live"),
  /** host: follows the host's own name; user: pinned by the user */
  nameSource: text("name_source").notNull().default("host"),
});

/** The sealed host identity behind an agent. The core never reads `handle`. */
export const handles = sqliteTable(
  "handles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id),
    host: text("host").notNull(),
    key: text("key").notNull(),
    handle: text("handle").notNull(),
    /** process | session | permanent */
    durability: text("durability").notNull(),
    evidence: text("evidence").notNull(),
    /** observed | attested */
    attestation: text("attestation").notNull().default("observed"),
    boundAt: integer("bound_at").notNull(),
  },
  (t) => [uniqueIndex("handles_key").on(t.host, t.key)],
);

/** What the tracker last observed about an agent. */
export const presence = sqliteTable("presence", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id),
  pid: integer("pid"),
  cwd: text("cwd"),
  status: text("status"),
  title: text("title"),
  relationship: text("relationship").notNull().default("unknown"),
  parentKey: text("parent_key"),
  reachable: integer("reachable", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  startedAt: integer("started_at"),
  firstSeen: integer("first_seen").notNull(),
  lastSeen: integer("last_seen").notNull(),
});

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

/** One row per (message, recipient). `receivedAt` is the inbox state. */
export const deliveries = sqliteTable(
  "deliveries",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id),
    wakeProvider: text("wake_provider"),
    wakeAttemptedAt: integer("wake_attempted_at"),
    /** DeliveryOutcome */
    wakeResult: text("wake_result"),
    wakeDetail: text("wake_detail"),
    receivedAt: integer("received_at"),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.toAgentId] }),
    index("deliveries_inbox").on(t.toAgentId, t.receivedAt),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type HandleRow = typeof handles.$inferSelect;
export type PresenceRow = typeof presence.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
