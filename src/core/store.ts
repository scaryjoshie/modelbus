import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DeliveryResult, DeliveryStatus, Outbound } from "./delivery.ts";
import { migrationsDir } from "./paths.ts";
import {
  type AgentRow,
  agents,
  type ConversationRow,
  conversations,
  credentials,
  deliveries,
  type MessageRow,
  messages,
  participants,
} from "./schema.ts";

/**
 * The store: the only module that touches SQL. Everything else uses these methods.
 * Schema lives in schema.ts; migrations are applied on open.
 *
 * Inbox state is `deliveries.readAt`, not a per-agent cursor, so a scoped pull or
 * a send(wait) can consume one DM without skipping others.
 */

export type Agent = AgentRow;
export type Conversation = ConversationRow;
export type Message = MessageRow;

export interface InboxItem extends Message {
  fromName: string;
  fromProvider: string;
}

/** One conversation as a person sees the list of chats. */
export interface ConversationOverview extends Conversation {
  participants: Array<{ id: string; name: string }>;
  last?: { seq: number; fromName: string; body: string; createdAt: number };
  /** Deliveries in it not yet read by their recipients. */
  unread: number;
}

export interface LogRow extends Message {
  fromName: string;
  toName: string;
  status: DeliveryStatus;
  detail: string | null;
  readAt: number | null;
}

/** Last resort when a thousand numbered names are taken. */
const NAME_SUFFIX_LIMIT = 1000;

export function newId(): string {
  return randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7);
}

export class Store {
  private readonly sqlite: Database;
  readonly db: BunSQLiteDatabase;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(path, { create: true });
    // Owner-only before WAL mode: SQLite gives the -wal and -shm files the same mode.
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.sqlite.run("PRAGMA foreign_keys = ON");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: migrationsDir() });
  }

  close(): void {
    this.sqlite.close();
  }

  // ---- agents -------------------------------------------------------------

  /** By current name first; a former name still resolves, so a stale address lands. */
  agentByName(name: string): Agent | undefined {
    return (
      this.db.select().from(agents).where(eq(agents.name, name)).get() ??
      this.db.select().from(agents).where(eq(agents.formerName, name)).get()
    );
  }

  agentById(id: string): Agent | undefined {
    return this.db.select().from(agents).where(eq(agents.id, id)).get();
  }

  agentByKey(provider: string, key: string): Agent | undefined {
    return this.db
      .select()
      .from(agents)
      .where(and(eq(agents.provider, provider), eq(agents.key, key)))
      .get();
  }

  /** Every agent ever bound, most recently seen first. */
  listAgents(): Agent[] {
    return this.db.select().from(agents).orderBy(desc(agents.lastSeen)).all();
  }

  touch(agentId: string): void {
    this.db.update(agents).set({ lastSeen: Date.now() }).where(eq(agents.id, agentId)).run();
  }

  /**
   * Find the agent behind (host, key) or create one. The display name follows the
   * host's whenever that name is free.
   */
  bind(opts: { provider: string; key: string; name: string }): Agent {
    const now = Date.now();
    const existing = this.agentByKey(opts.provider, opts.key);
    if (existing) {
      // A pinned name is a person's choice; the host's renames no longer apply.
      const name =
        !existing.namePinned &&
        existing.name !== opts.name &&
        this.freeName(opts.name, existing.id) === opts.name
          ? opts.name
          : existing.name;
      this.db.update(agents).set({ lastSeen: now, name }).where(eq(agents.id, existing.id)).run();
      return { ...existing, lastSeen: now, name };
    }
    const agent: Agent = {
      id: newId(),
      name: this.freeName(opts.name),
      provider: opts.provider,
      key: opts.key,
      lastSeen: now,
      namePinned: 0,
      formerName: null,
      purpose: null,
    };
    this.db.insert(agents).values(agent).run();
    return agent;
  }

  /** Set or clear what an agent is for. */
  setPurpose(agentId: string, purpose: string | null): Agent | undefined {
    const agent = this.agentById(agentId);
    if (!agent) return undefined;
    this.db.update(agents).set({ purpose }).where(eq(agents.id, agentId)).run();
    return { ...agent, purpose };
  }

  /**
   * A person renames an agent: the name is pinned, and the old one stays as an
   * alias. Returns undefined if the name is taken by another agent.
   */
  rename(agentId: string, name: string): Agent | undefined {
    const agent = this.agentById(agentId);
    if (!agent) return undefined;
    if (this.freeName(name, agentId) !== name) return undefined;
    const next = {
      name,
      namePinned: 1,
      formerName: agent.name === name ? agent.formerName : agent.name,
    };
    this.db.update(agents).set(next).where(eq(agents.id, agentId)).run();
    return { ...agent, ...next };
  }

  // ---- credentials (registered-agent auth) --------------------------------

  private static hash(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }

  setCredential(agentId: string, secret: string): void {
    const row = { agentId, secretHash: Store.hash(secret), createdAt: Date.now() };
    this.db
      .insert(credentials)
      .values(row)
      .onConflictDoUpdate({ target: credentials.agentId, set: row })
      .run();
  }

  /** True if `secret` matches the stored hash for this agent. Constant-time. */
  verifyCredential(agentId: string, secret: string): boolean {
    const row = this.db.select().from(credentials).where(eq(credentials.agentId, agentId)).get();
    if (!row) return false;
    const a = Buffer.from(row.secretHash);
    const b = Buffer.from(Store.hash(secret));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private freeName(preferred: string, forAgentId?: string): string {
    const taken = (n: string) => {
      const a = this.agentByName(n);
      return a !== undefined && a.id !== forAgentId;
    };
    if (!taken(preferred)) return preferred;
    const m = preferred.match(/^(.*)-(\d+)$/);
    const base = m ? (m[1] as string) : preferred;
    for (let n = m ? Number(m[2]) + 1 : 2; n < NAME_SUFFIX_LIMIT; n++) {
      const candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
    return `${preferred}-${newId()}`;
  }

  // ---- conversations ------------------------------------------------------

  /** The single DM between two agents, created on first use. */
  dm(a: string, b: string): Conversation {
    const key = `dm:${[a, b].sort().join("+")}`;
    const found = this.db.select().from(conversations).where(eq(conversations.key, key)).get();
    if (found) return found;
    const conv: Conversation = { id: newId(), kind: "dm", key, name: null, createdAt: Date.now() };
    this.db.transaction((tx) => {
      tx.insert(conversations).values(conv).run();
      tx.insert(participants)
        .values([
          { conversationId: conv.id, agentId: a },
          { conversationId: conv.id, agentId: b },
        ])
        .run();
    });
    return conv;
  }

  conversationById(id: string): Conversation | undefined {
    return this.db.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  groupByName(name: string): Conversation | undefined {
    return this.db.select().from(conversations).where(eq(conversations.name, name)).get();
  }

  /** The group with this name, created empty if it does not exist. */
  group(name: string): Conversation {
    const found = this.groupByName(name);
    if (found) return found;
    const conv: Conversation = {
      id: newId(),
      kind: "group",
      key: `group:${name}`,
      name,
      createdAt: Date.now(),
    };
    this.db.insert(conversations).values(conv).run();
    return conv;
  }

  /** Add and remove members; adding an existing member is a no-op. */
  setMembers(conversationId: string, opts: { add?: string[]; remove?: string[] }): string[] {
    const current = new Set(this.participants(conversationId));
    this.db.transaction((tx) => {
      const add = (opts.add ?? []).filter((id) => !current.has(id));
      if (add.length) {
        tx.insert(participants)
          .values(add.map((agentId) => ({ conversationId, agentId })))
          .run();
      }
      const remove = (opts.remove ?? []).filter((id) => current.has(id));
      if (remove.length) {
        tx.delete(participants)
          .where(
            and(
              eq(participants.conversationId, conversationId),
              inArray(participants.agentId, remove),
            ),
          )
          .run();
      }
    });
    return this.participants(conversationId);
  }

  /** Every conversation with its members, last message, and unread count; newest activity first. */
  conversationsOverview(): ConversationOverview[] {
    const convs = this.db.select().from(conversations).all();
    const out: ConversationOverview[] = convs.map((c) => {
      const members = this.db
        .select({ id: agents.id, name: agents.name })
        .from(participants)
        .innerJoin(agents, eq(agents.id, participants.agentId))
        .where(eq(participants.conversationId, c.id))
        .all();
      const lastRow = this.db
        .select({
          seq: messages.seq,
          body: messages.body,
          createdAt: messages.createdAt,
          fromName: agents.name,
        })
        .from(messages)
        .innerJoin(agents, eq(agents.id, messages.fromAgentId))
        .where(eq(messages.conversationId, c.id))
        .orderBy(desc(messages.seq))
        .limit(1)
        .get();
      const unread =
        this.db
          .select({ n: count() })
          .from(deliveries)
          .innerJoin(messages, eq(messages.id, deliveries.messageId))
          .where(and(eq(messages.conversationId, c.id), isNull(deliveries.readAt)))
          .get()?.n ?? 0;
      return { ...c, participants: members, last: lastRow ?? undefined, unread };
    });
    return out.sort((x, y) => (y.last?.seq ?? 0) - (x.last?.seq ?? 0) || y.createdAt - x.createdAt);
  }

  /** Messages in a conversation before `beforeSeq` (or the newest), newest last, at most `limit`. */
  history(conversationId: string, opts: { beforeSeq?: number; limit: number }): InboxItem[] {
    const where = [eq(messages.conversationId, conversationId)];
    if (opts.beforeSeq !== undefined) where.push(sql`${messages.seq} < ${opts.beforeSeq}`);
    const rows = this.db
      .select({
        seq: messages.seq,
        id: messages.id,
        conversationId: messages.conversationId,
        fromAgentId: messages.fromAgentId,
        body: messages.body,
        createdAt: messages.createdAt,
        fromName: agents.name,
        fromProvider: agents.provider,
      })
      .from(messages)
      .innerJoin(agents, eq(agents.id, messages.fromAgentId))
      .where(and(...where))
      .orderBy(desc(messages.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse();
  }

  /** Ids of everyone sharing a group with this agent (itself included); undefined if it is in no group. */
  groupmates(agentId: string): Set<string> | undefined {
    const rows = this.db
      .select({ agentId: participants.agentId })
      .from(participants)
      .innerJoin(conversations, eq(conversations.id, participants.conversationId))
      .where(
        and(
          eq(conversations.kind, "group"),
          inArray(
            participants.conversationId,
            this.db
              .select({ id: participants.conversationId })
              .from(participants)
              .where(eq(participants.agentId, agentId)),
          ),
        ),
      )
      .all();
    return rows.length ? new Set(rows.map((r) => r.agentId)) : undefined;
  }

  participants(conversationId: string): string[] {
    return this.db
      .select({ agentId: participants.agentId })
      .from(participants)
      .where(eq(participants.conversationId, conversationId))
      .all()
      .map((r) => r.agentId);
  }

  // ---- messages & deliveries ---------------------------------------------

  /** Insert a message and one unread delivery per other participant. */
  insertMessage(conversationId: string, fromAgentId: string, body: string): Message {
    const id = newId();
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.insert(messages).values({ id, conversationId, fromAgentId, body, createdAt: now }).run();
      const recipients = this.participants(conversationId).filter((to) => to !== fromAgentId);
      if (recipients.length) {
        tx.insert(deliveries)
          .values(recipients.map((toAgentId) => ({ messageId: id, toAgentId })))
          .run();
      }
    });
    return this.messageById(id) as Message;
  }

  messageById(id: string): Message | undefined {
    return this.db.select().from(messages).where(eq(messages.id, id)).get();
  }

  /** Unread messages for an agent, oldest first, optionally in one conversation. */
  inbox(agentId: string, opts: { conversationId?: string; limit: number }): InboxItem[] {
    const where = [eq(deliveries.toAgentId, agentId), isNull(deliveries.readAt)];
    if (opts.conversationId) where.push(eq(messages.conversationId, opts.conversationId));
    return this.db
      .select({
        seq: messages.seq,
        id: messages.id,
        conversationId: messages.conversationId,
        fromAgentId: messages.fromAgentId,
        body: messages.body,
        createdAt: messages.createdAt,
        fromName: agents.name,
        fromProvider: agents.provider,
      })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .innerJoin(agents, eq(agents.id, messages.fromAgentId))
      .where(and(...where))
      .orderBy(messages.seq)
      .limit(opts.limit)
      .all();
  }

  countUnread(agentId: string, conversationId?: string): number {
    const where = [eq(deliveries.toAgentId, agentId), isNull(deliveries.readAt)];
    if (conversationId) where.push(eq(messages.conversationId, conversationId));
    const row = this.db
      .select({ n: count() })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(and(...where))
      .get();
    return row?.n ?? 0;
  }

  markRead(messageIds: string[], agentId: string): void {
    if (!messageIds.length) return;
    this.db
      .update(deliveries)
      .set({ status: "read", readAt: Date.now() })
      .where(
        and(
          inArray(deliveries.messageId, messageIds),
          eq(deliveries.toAgentId, agentId),
          isNull(deliveries.readAt),
        ),
      )
      .run();
  }

  /** Record a push result. Never downgrades a delivery already read. */
  recordDelivery(messageId: string, agentId: string, result: DeliveryResult): void {
    this.db
      .update(deliveries)
      .set({ status: result.status, detail: result.detail ?? null })
      .where(
        and(
          eq(deliveries.messageId, messageId),
          eq(deliveries.toAgentId, agentId),
          isNull(deliveries.readAt),
        ),
      )
      .run();
  }

  /**
   * Unread messages for an agent in the given states, oldest first, shaped for
   * the delivery port.
   */
  unread(agentId: string, states: DeliveryStatus[]): Outbound[] {
    return this.db
      .select({ message: messages, from: agents, conversation: conversations })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .innerJoin(agents, eq(agents.id, messages.fromAgentId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(deliveries.toAgentId, agentId),
          isNull(deliveries.readAt),
          inArray(deliveries.status, states),
        ),
      )
      .orderBy(messages.seq)
      .all();
  }

  /** Messages in a conversation from anyone but `meId` with seq greater than `afterSeq`. */
  repliesAfter(conversationId: string, meId: string, afterSeq: number): Message[] {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          ne(messages.fromAgentId, meId),
          gt(messages.seq, afterSeq),
        ),
      )
      .orderBy(messages.seq)
      .all();
  }

  // ---- guards support -----------------------------------------------------

  identicalRecently(conversationId: string, fromAgentId: string, body: string, sinceMs: number) {
    const row = this.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.fromAgentId, fromAgentId),
          eq(messages.body, body),
          gt(messages.createdAt, Date.now() - sinceMs),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  sendsSince(fromAgentId: string, sinceMs: number): number {
    const row = this.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(eq(messages.fromAgentId, fromAgentId), gt(messages.createdAt, Date.now() - sinceMs)),
      )
      .get();
    return row?.n ?? 0;
  }

  // ---- log ----------------------------------------------------------------

  /** Every message with its delivery state. Raw SQL: it joins `agents` twice. */
  log(conversationId?: string): LogRow[] {
    return this.db.all<LogRow>(sql`
      SELECT m.seq, m.id, m.conversation_id AS conversationId, m.from_agent_id AS fromAgentId,
             m.body, m.created_at AS createdAt,
             fa.name AS fromName, ta.name AS toName,
             d.status, d.detail, d.read_at AS readAt
      FROM messages m
      JOIN agents fa ON fa.id = m.from_agent_id
      JOIN deliveries d ON d.message_id = m.id
      JOIN agents ta ON ta.id = d.to_agent_id
      ${conversationId ? sql`WHERE m.conversation_id = ${conversationId}` : sql``}
      ORDER BY m.seq ASC`);
  }
}
