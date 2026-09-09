import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Durability, Relationship } from "./adapter.ts";
import type { DeliveryOutcome } from "./delivery.ts";
import { migrationsDir } from "./paths.ts";
import {
  type AgentRow,
  agents,
  type ConversationRow,
  conversations,
  deliveries,
  type HandleRow,
  handles,
  type MessageRow,
  messages,
  type PresenceRow,
  participants,
  presence,
} from "./schema.ts";

/**
 * The store: the only module that touches SQL. Everything else uses these methods.
 * Schema lives in schema.ts; migrations are applied on open.
 *
 * Inbox state is `deliveries.receivedAt`, not a per-agent cursor, so a scoped pull or
 * a send(wait) can consume one DM without skipping others.
 */

export type Agent = AgentRow;
export type Handle = HandleRow;
export type Presence = PresenceRow;
export type Conversation = ConversationRow;
export type Message = MessageRow;
export type AgentState = "live" | "gone" | "unknown";
export type Attestation = "observed" | "attested";

export interface InboxItem extends Message {
  fromName: string;
  fromHost: string;
}

export interface LogRow extends Message {
  fromName: string;
  toName: string;
  wakeProvider: string | null;
  wakeResult: string | null;
  wakeDetail: string | null;
  receivedAt: number | null;
}

export function newId(): string {
  return randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7);
}

export class Store {
  private readonly sqlite: Database;
  readonly db: BunSQLiteDatabase;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path, { create: true });
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.sqlite.run("PRAGMA foreign_keys = ON");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: migrationsDir() });
  }

  close(): void {
    this.sqlite.close();
  }

  // ---- agents -------------------------------------------------------------

  agentByName(name: string): Agent | undefined {
    return this.db.select().from(agents).where(eq(agents.name, name)).get();
  }

  agentById(id: string): Agent | undefined {
    return this.db.select().from(agents).where(eq(agents.id, id)).get();
  }

  listAgents(states: AgentState[] = ["live"]): Agent[] {
    return this.db
      .select()
      .from(agents)
      .where(inArray(agents.state, states))
      .orderBy(desc(agents.lastSeen))
      .all();
  }

  touch(agentId: string): void {
    this.db.update(agents).set({ lastSeen: Date.now() }).where(eq(agents.id, agentId)).run();
  }

  setState(agentId: string, state: AgentState): void {
    this.db.update(agents).set({ state }).where(eq(agents.id, agentId)).run();
  }

  /** Pin a user-chosen name; the host's name no longer overrides it. */
  rename(agentId: string, name: string): string {
    const free = this.freeName(name, agentId);
    this.db
      .update(agents)
      .set({ name: free, nameSource: "user" })
      .where(eq(agents.id, agentId))
      .run();
    return free;
  }

  // ---- handles (identity) -------------------------------------------------

  handleByKey(host: string, key: string): Handle | undefined {
    return this.db
      .select()
      .from(handles)
      .where(and(eq(handles.host, host), eq(handles.key, key)))
      .get();
  }

  handleOf(agentId: string): Handle | undefined {
    return this.db.select().from(handles).where(eq(handles.agentId, agentId)).get();
  }

  /**
   * Find the agent behind (host, key) or create one. The handle is stored sealed.
   * Attestation only ever moves from observed to attested. The display name follows
   * the host's until the user pins one.
   */
  bind(opts: {
    host: string;
    key: string;
    handle: unknown;
    durability: Durability;
    preferredName: string;
    evidence: string;
    attestation?: Attestation;
  }): Agent {
    const now = Date.now();
    const existing = this.handleByKey(opts.host, opts.key);
    const agent = existing && this.agentById(existing.agentId);
    if (existing && agent) {
      this.db
        .update(agents)
        .set({ lastSeen: now, state: "live" })
        .where(eq(agents.id, agent.id))
        .run();
      if (opts.attestation === "attested" && existing.attestation !== "attested") {
        this.db
          .update(handles)
          .set({
            attestation: "attested",
            evidence: opts.evidence,
            handle: JSON.stringify(opts.handle),
          })
          .where(eq(handles.agentId, agent.id))
          .run();
      }
      if (agent.nameSource === "host" && agent.name !== opts.preferredName) {
        const free = this.freeName(opts.preferredName, agent.id);
        if (free === opts.preferredName) {
          this.db.update(agents).set({ name: free }).where(eq(agents.id, agent.id)).run();
        }
      }
      return this.agentById(agent.id) as Agent;
    }
    const id = newId();
    this.db.transaction((tx) => {
      tx.insert(agents)
        .values({
          id,
          name: this.freeName(opts.preferredName),
          host: opts.host,
          createdAt: now,
          lastSeen: now,
          state: "live",
          nameSource: "host",
        })
        .run();
      tx.insert(handles)
        .values({
          agentId: id,
          host: opts.host,
          key: opts.key,
          handle: JSON.stringify(opts.handle),
          durability: opts.durability,
          evidence: opts.evidence,
          attestation: opts.attestation ?? "observed",
          boundAt: now,
        })
        .run();
    });
    return this.agentById(id) as Agent;
  }

  private freeName(preferred: string, forAgentId?: string): string {
    const taken = (n: string) => {
      const a = this.agentByName(n);
      return a !== undefined && a.id !== forAgentId;
    };
    if (!taken(preferred)) return preferred;
    const m = preferred.match(/^(.*)-(\d+)$/);
    const base = m ? (m[1] as string) : preferred;
    for (let n = m ? Number(m[2]) + 1 : 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
    return `${preferred}-${newId()}`;
  }

  // ---- presence -----------------------------------------------------------

  presenceOf(agentId: string): Presence | undefined {
    return this.db.select().from(presence).where(eq(presence.agentId, agentId)).get();
  }

  upsertPresence(
    agentId: string,
    p: {
      pid?: number;
      cwd?: string;
      status?: string;
      title?: string;
      relationship: Relationship;
      parentKey?: string;
      reachable: boolean;
      note?: string;
      startedAt?: number;
    },
  ): void {
    const now = Date.now();
    const row = {
      pid: p.pid ?? null,
      cwd: p.cwd ?? null,
      status: p.status ?? null,
      title: p.title ?? null,
      relationship: p.relationship,
      parentKey: p.parentKey ?? null,
      reachable: p.reachable,
      note: p.note ?? null,
      startedAt: p.startedAt ?? null,
      lastSeen: now,
    };
    this.db
      .insert(presence)
      .values({ agentId, firstSeen: now, ...row })
      .onConflictDoUpdate({ target: presence.agentId, set: row })
      .run();
    this.db
      .update(agents)
      .set({ lastSeen: now, state: "live" })
      .where(eq(agents.id, agentId))
      .run();
  }

  // ---- conversations ------------------------------------------------------

  /** The single DM between two agents, created on first use. */
  dm(a: string, b: string): Conversation {
    const key = `dm:${[a, b].sort().join("+")}`;
    const found = this.db.select().from(conversations).where(eq(conversations.key, key)).get();
    if (found) return found;
    const id = newId();
    this.db.transaction((tx) => {
      tx.insert(conversations).values({ id, kind: "dm", key, createdAt: Date.now() }).run();
      tx.insert(participants)
        .values([
          { conversationId: id, agentId: a },
          { conversationId: id, agentId: b },
        ])
        .run();
    });
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get() as Conversation;
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

  /** Insert a message and one unreceived delivery per other participant. */
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

  /** Unreceived messages for an agent, oldest first, optionally in one conversation. */
  inbox(agentId: string, opts: { conversationId?: string; limit: number }): InboxItem[] {
    const where = [eq(deliveries.toAgentId, agentId), isNull(deliveries.receivedAt)];
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
        fromHost: agents.host,
      })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .innerJoin(agents, eq(agents.id, messages.fromAgentId))
      .where(and(...where))
      .orderBy(messages.seq)
      .limit(opts.limit)
      .all();
  }

  countUnreceived(agentId: string, conversationId?: string): number {
    const where = [eq(deliveries.toAgentId, agentId), isNull(deliveries.receivedAt)];
    if (conversationId) where.push(eq(messages.conversationId, conversationId));
    const row = this.db
      .select({ n: count() })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(and(...where))
      .get();
    return row?.n ?? 0;
  }

  markReceived(messageIds: string[], agentId: string): void {
    if (!messageIds.length) return;
    this.db
      .update(deliveries)
      .set({ receivedAt: Date.now() })
      .where(
        and(
          inArray(deliveries.messageId, messageIds),
          eq(deliveries.toAgentId, agentId),
          isNull(deliveries.receivedAt),
        ),
      )
      .run();
  }

  recordWake(
    messageId: string,
    agentId: string,
    provider: string,
    outcome: DeliveryOutcome,
    detail?: string,
  ): void {
    this.db
      .update(deliveries)
      .set({
        wakeProvider: provider,
        wakeAttemptedAt: Date.now(),
        wakeResult: outcome,
        wakeDetail: detail ?? null,
      })
      .where(and(eq(deliveries.messageId, messageId), eq(deliveries.toAgentId, agentId)))
      .run();
  }

  /** Messages in a conversation from one sender with seq greater than `afterSeq`. */
  repliesAfter(conversationId: string, fromAgentId: string, afterSeq: number): Message[] {
    return this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.fromAgentId, fromAgentId),
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
             d.wake_provider AS wakeProvider, d.wake_result AS wakeResult,
             d.wake_detail AS wakeDetail, d.received_at AS receivedAt
      FROM messages m
      JOIN agents fa ON fa.id = m.from_agent_id
      JOIN deliveries d ON d.message_id = m.id
      JOIN agents ta ON ta.id = d.to_agent_id
      ${conversationId ? sql`WHERE m.conversation_id = ${conversationId}` : sql``}
      ORDER BY m.seq ASC`);
  }
}
