import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite store. One file, WAL mode. See docs/poc-spec.md section 5.
 *
 * Inbox state lives on `deliveries.received_at`, not on a per-agent cursor: a pull
 * returns messages whose delivery to me is unreceived, then marks them. That lets a
 * scoped pull or a send(wait) consume one DM without skipping others.
 */

export interface Agent {
  id: string;
  name: string;
  host: string;
  created_at: number;
  last_seen: number;
  state: "live" | "offline" | "archived";
}

export interface Binding {
  agent_id: string;
  host: string;
  host_session_ref: string;
  bound_at: number;
  evidence: string | null;
}

export interface Conversation {
  id: string;
  kind: "dm";
  key: string;
  created_at: number;
}

export interface Message {
  seq: number;
  id: string;
  conversation_id: string;
  from_agent_id: string;
  body: string;
  created_at: number;
}

export interface Delivery {
  message_id: string;
  to_agent_id: string;
  wake_provider: string | null;
  wake_attempted_at: number | null;
  wake_result: string | null;
  received_at: number | null;
}

export interface InboxItem extends Message {
  from_name: string;
  from_host: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'live'
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_live_name ON agents(name) WHERE state = 'live';
CREATE TABLE IF NOT EXISTS bindings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  host TEXT NOT NULL,
  host_session_ref TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  evidence TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bindings_ref ON bindings(host, host_session_ref);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  wake_provider TEXT,
  wake_attempted_at INTEGER,
  wake_result TEXT,
  received_at INTEGER,
  PRIMARY KEY (message_id, to_agent_id)
);
CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries(to_agent_id, received_at);
`;

export function newId(): string {
  return randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7);
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- agents -------------------------------------------------------------

  agentByName(name: string): Agent | null {
    return this.db
      .query<Agent, [string]>("SELECT * FROM agents WHERE name = ? AND state = 'live'")
      .get(name);
  }

  agentById(id: string): Agent | null {
    return this.db.query<Agent, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  }

  listAgents(): Agent[] {
    return this.db
      .query<Agent, []>("SELECT * FROM agents WHERE state = 'live' ORDER BY last_seen DESC")
      .all();
  }

  touch(agentId: string): void {
    this.db.run("UPDATE agents SET last_seen = ? WHERE id = ?", [Date.now(), agentId]);
  }

  /**
   * Find or create the agent bound to (host, hostSessionRef). The binding is the
   * identity; the name is display only and is de-duplicated among live agents.
   */
  bind(opts: {
    host: string;
    hostSessionRef: string;
    preferredName: string;
    evidence?: string;
  }): Agent {
    const existing = this.db
      .query<Binding, [string, string]>(
        "SELECT * FROM bindings WHERE host = ? AND host_session_ref = ?",
      )
      .get(opts.host, opts.hostSessionRef);
    if (existing) {
      const agent = this.agentById(existing.agent_id);
      if (agent) {
        if (agent.state !== "live") {
          this.db.run("UPDATE agents SET state = 'live', last_seen = ? WHERE id = ?", [
            Date.now(),
            agent.id,
          ]);
        } else {
          this.touch(agent.id);
        }
        return this.agentById(agent.id) as Agent;
      }
    }
    const now = Date.now();
    const id = newId();
    const name = this.freeName(opts.preferredName);
    this.db.run(
      "INSERT INTO agents (id, name, host, created_at, last_seen, state) VALUES (?, ?, ?, ?, ?, 'live')",
      [id, name, opts.host, now, now],
    );
    this.db.run(
      "INSERT INTO bindings (agent_id, host, host_session_ref, bound_at, evidence) VALUES (?, ?, ?, ?, ?)",
      [id, opts.host, opts.hostSessionRef, now, opts.evidence ?? null],
    );
    return this.agentById(id) as Agent;
  }

  binding(agentId: string): Binding | null {
    return this.db
      .query<Binding, [string]>("SELECT * FROM bindings WHERE agent_id = ?")
      .get(agentId);
  }

  private freeName(preferred: string): string {
    if (!this.agentByName(preferred)) return preferred;
    const m = preferred.match(/^(.*)-(\d+)$/);
    const base = m ? (m[1] as string) : preferred;
    for (let n = m ? Number(m[2]) + 1 : 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!this.agentByName(candidate)) return candidate;
    }
    return `${preferred}-${newId()}`;
  }

  // ---- conversations ------------------------------------------------------

  /** The single DM between two agents, created on first use. */
  dm(a: string, b: string): Conversation {
    const key = `dm:${[a, b].sort().join("+")}`;
    const found = this.db
      .query<Conversation, [string]>("SELECT * FROM conversations WHERE key = ?")
      .get(key);
    if (found) return found;
    const id = newId();
    const now = Date.now();
    this.db.run("INSERT INTO conversations (id, kind, key, created_at) VALUES (?, 'dm', ?, ?)", [
      id,
      key,
      now,
    ]);
    for (const agent of [a, b]) {
      this.db.run("INSERT INTO participants (conversation_id, agent_id) VALUES (?, ?)", [
        id,
        agent,
      ]);
    }
    return this.db
      .query<Conversation, [string]>("SELECT * FROM conversations WHERE id = ?")
      .get(id) as Conversation;
  }

  participants(conversationId: string): string[] {
    return this.db
      .query<{ agent_id: string }, [string]>(
        "SELECT agent_id FROM participants WHERE conversation_id = ?",
      )
      .all(conversationId)
      .map((r) => r.agent_id);
  }

  // ---- messages & deliveries ---------------------------------------------

  /** Insert a message and one unreceived delivery per other participant. */
  insertMessage(conversationId: string, fromAgentId: string, body: string): Message {
    const id = newId();
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run(
        "INSERT INTO messages (id, conversation_id, from_agent_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, conversationId, fromAgentId, body, now],
      );
      for (const to of this.participants(conversationId)) {
        if (to === fromAgentId) continue;
        this.db.run("INSERT INTO deliveries (message_id, to_agent_id) VALUES (?, ?)", [id, to]);
      }
    });
    tx();
    return this.messageById(id) as Message;
  }

  messageById(id: string): Message | null {
    return this.db.query<Message, [string]>("SELECT * FROM messages WHERE id = ?").get(id);
  }

  /** Unreceived messages for an agent, oldest first, optionally in one conversation. */
  inbox(agentId: string, opts: { conversationId?: string; limit: number }): InboxItem[] {
    const sql = `
      SELECT m.*, a.name AS from_name, a.host AS from_host
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      JOIN agents a ON a.id = m.from_agent_id
      WHERE d.to_agent_id = ? AND d.received_at IS NULL
        ${opts.conversationId ? "AND m.conversation_id = ?" : ""}
      ORDER BY m.seq ASC
      LIMIT ?`;
    const params = opts.conversationId
      ? [agentId, opts.conversationId, opts.limit]
      : [agentId, opts.limit];
    return this.db.query<InboxItem, (string | number)[]>(sql).all(...params);
  }

  countUnreceived(agentId: string, conversationId?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.to_agent_id = ? AND d.received_at IS NULL ${conversationId ? "AND m.conversation_id = ?" : ""}`;
    const params = conversationId ? [agentId, conversationId] : [agentId];
    return (this.db.query<{ n: number }, string[]>(sql).get(...params) as { n: number }).n;
  }

  markReceived(messageIds: string[], agentId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE deliveries SET received_at = ? WHERE message_id = ? AND to_agent_id = ? AND received_at IS NULL",
    );
    const tx = this.db.transaction(() => {
      for (const id of messageIds) stmt.run(now, id, agentId);
    });
    tx();
  }

  recordWake(messageId: string, agentId: string, provider: string, result: string): void {
    this.db.run(
      "UPDATE deliveries SET wake_provider = ?, wake_attempted_at = ?, wake_result = ? WHERE message_id = ? AND to_agent_id = ?",
      [provider, Date.now(), result, messageId, agentId],
    );
  }

  /** Messages in a conversation with seq greater than `afterSeq`, from a given sender. */
  repliesAfter(conversationId: string, fromAgentId: string, afterSeq: number): Message[] {
    return this.db
      .query<Message, [string, string, number]>(
        "SELECT * FROM messages WHERE conversation_id = ? AND from_agent_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(conversationId, fromAgentId, afterSeq);
  }

  // ---- guards support -----------------------------------------------------

  identicalRecently(conversationId: string, fromAgentId: string, body: string, sinceMs: number) {
    return (
      this.db
        .query<{ n: number }, [string, string, string, number]>(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND from_agent_id = ? AND body = ? AND created_at > ?",
        )
        .get(conversationId, fromAgentId, body, Date.now() - sinceMs)?.n ?? 0
    );
  }

  sendsSince(fromAgentId: string, sinceMs: number): number {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM messages WHERE from_agent_id = ? AND created_at > ?",
        )
        .get(fromAgentId, Date.now() - sinceMs)?.n ?? 0
    );
  }

  // ---- log ----------------------------------------------------------------

  log(conversationId?: string): Array<
    Message & {
      from_name: string;
      to_name: string;
      wake_provider: string | null;
      wake_result: string | null;
      received_at: number | null;
    }
  > {
    const sql = `
      SELECT m.*, fa.name AS from_name, ta.name AS to_name,
             d.wake_provider, d.wake_result, d.received_at
      FROM messages m
      JOIN agents fa ON fa.id = m.from_agent_id
      JOIN deliveries d ON d.message_id = m.id
      JOIN agents ta ON ta.id = d.to_agent_id
      ${conversationId ? "WHERE m.conversation_id = ?" : ""}
      ORDER BY m.seq ASC`;
    type Row = ReturnType<Store["log"]>[number];
    return conversationId
      ? this.db.query<Row, [string]>(sql).all(conversationId)
      : this.db.query<Row, []>(sql).all();
  }
}
