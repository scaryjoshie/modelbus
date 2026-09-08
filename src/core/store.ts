import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Durability, Relationship } from "./adapter.ts";

/**
 * SQLite store. One file, WAL mode. See docs/poc-spec.md section 5.
 *
 * Identity: an agent is ours (id, name, host). Its host identity is a sealed handle
 * in `handles`, found by an opaque key. Presence is what the tracker last observed.
 * Inbox state lives on `deliveries.received_at`, not on a per-agent cursor.
 */

export interface Agent {
  id: string;
  name: string;
  host: string;
  created_at: number;
  last_seen: number;
  state: "live" | "gone" | "unknown";
  /** "host": follows the host's own name for the session; "user": pinned by the user. */
  name_source: "host" | "user";
}

export interface Handle {
  agent_id: string;
  host: string;
  key: string;
  /** JSON-serialized sealed handle; the core never reads inside. */
  handle: string;
  durability: Durability;
  /** How we came to associate this handle with the agent. */
  evidence: string;
  /** "attested" once the session identified itself (hook/shim); "observed" otherwise. */
  attestation: "observed" | "attested";
  bound_at: number;
}

export interface Presence {
  agent_id: string;
  pid: number | null;
  tty: string | null;
  cwd: string | null;
  status: string | null;
  title: string | null;
  relationship: Relationship;
  parent_key: string | null;
  reachable: number;
  note: string | null;
  started_at: number | null;
  first_seen: number;
  last_seen: number;
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
  state TEXT NOT NULL DEFAULT 'live',
  name_source TEXT NOT NULL DEFAULT 'host'
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_name ON agents(name);
CREATE TABLE IF NOT EXISTS handles (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  host TEXT NOT NULL,
  key TEXT NOT NULL,
  handle TEXT NOT NULL,
  durability TEXT NOT NULL,
  evidence TEXT NOT NULL,
  attestation TEXT NOT NULL DEFAULT 'observed',
  bound_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS handles_key ON handles(host, key);
CREATE TABLE IF NOT EXISTS presence (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  pid INTEGER, tty TEXT, cwd TEXT, status TEXT, title TEXT,
  relationship TEXT NOT NULL DEFAULT 'unknown',
  parent_key TEXT,
  reachable INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  started_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
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
    return this.db.query<Agent, [string]>("SELECT * FROM agents WHERE name = ?").get(name);
  }

  agentById(id: string): Agent | null {
    return this.db.query<Agent, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  }

  listAgents(states: Agent["state"][] = ["live"]): Agent[] {
    const marks = states.map(() => "?").join(",");
    return this.db
      .query<Agent, string[]>(
        `SELECT * FROM agents WHERE state IN (${marks}) ORDER BY last_seen DESC`,
      )
      .all(...states);
  }

  touch(agentId: string): void {
    this.db.run("UPDATE agents SET last_seen = ? WHERE id = ?", [Date.now(), agentId]);
  }

  setState(agentId: string, state: Agent["state"]): void {
    this.db.run("UPDATE agents SET state = ? WHERE id = ?", [state, agentId]);
  }

  // ---- handles (identity) -------------------------------------------------

  handleByKey(host: string, key: string): Handle | null {
    return this.db
      .query<Handle, [string, string]>("SELECT * FROM handles WHERE host = ? AND key = ?")
      .get(host, key);
  }

  handleOf(agentId: string): Handle | null {
    return this.db.query<Handle, [string]>("SELECT * FROM handles WHERE agent_id = ?").get(agentId);
  }

  /**
   * Find the agent behind (host, key) or create one. The handle is stored sealed.
   * Attestation only ever moves from observed to attested.
   */
  bind(opts: {
    host: string;
    key: string;
    handle: unknown;
    durability: Durability;
    preferredName: string;
    evidence: string;
    attestation?: "observed" | "attested";
  }): Agent {
    const now = Date.now();
    const existing = this.handleByKey(opts.host, opts.key);
    if (existing) {
      const agent = this.agentById(existing.agent_id);
      if (agent) {
        this.db.run("UPDATE agents SET last_seen = ?, state = 'live' WHERE id = ?", [
          now,
          agent.id,
        ]);
        // Follow the host's name until the user pins one (e.g. Codex titles a thread
        // after its first turn). Our id never changes.
        if (agent.name_source === "host" && agent.name !== opts.preferredName) {
          const free = this.freeName(opts.preferredName, agent.id);
          if (free === opts.preferredName) {
            this.db.run("UPDATE agents SET name = ? WHERE id = ?", [free, agent.id]);
          }
        }
        if (opts.attestation === "attested" && existing.attestation !== "attested") {
          this.db.run(
            "UPDATE handles SET attestation = 'attested', evidence = ?, handle = ? WHERE agent_id = ?",
            [opts.evidence, JSON.stringify(opts.handle), agent.id],
          );
        }
        return this.agentById(agent.id) as Agent;
      }
    }
    const id = newId();
    const name = this.freeName(opts.preferredName);
    this.db.run(
      "INSERT INTO agents (id, name, host, created_at, last_seen, state) VALUES (?, ?, ?, ?, ?, 'live')",
      [id, name, opts.host, now, now],
    );
    this.db.run(
      "INSERT INTO handles (agent_id, host, key, handle, durability, evidence, attestation, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.host,
        opts.key,
        JSON.stringify(opts.handle),
        opts.durability,
        opts.evidence,
        opts.attestation ?? "observed",
        now,
      ],
    );
    return this.agentById(id) as Agent;
  }

  private freeName(preferred: string, forAgentId?: string): string {
    const taken = (n: string) => {
      const a = this.agentByName(n);
      return a !== null && a.id !== forAgentId;
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

  /** Pin a user-chosen name; the host's name no longer overrides it. */
  rename(agentId: string, name: string): string {
    const free = this.freeName(name, agentId);
    this.db.run("UPDATE agents SET name = ?, name_source = 'user' WHERE id = ?", [free, agentId]);
    return free;
  }

  // ---- presence -----------------------------------------------------------

  presenceOf(agentId: string): Presence | null {
    return this.db
      .query<Presence, [string]>("SELECT * FROM presence WHERE agent_id = ?")
      .get(agentId);
  }

  upsertPresence(
    agentId: string,
    p: Omit<Presence, "agent_id" | "first_seen" | "last_seen">,
  ): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO presence (agent_id, pid, tty, cwd, status, title, relationship, parent_key, reachable, note, started_at, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET pid=excluded.pid, tty=excluded.tty, cwd=excluded.cwd, status=excluded.status,
         title=excluded.title, relationship=excluded.relationship, parent_key=excluded.parent_key, reachable=excluded.reachable,
         note=excluded.note, started_at=excluded.started_at, last_seen=excluded.last_seen`,
      [
        agentId,
        p.pid,
        p.tty,
        p.cwd,
        p.status,
        p.title,
        p.relationship,
        p.parent_key,
        p.reachable,
        p.note,
        p.started_at,
        now,
        now,
      ],
    );
    this.db.run("UPDATE agents SET last_seen = ?, state = 'live' WHERE id = ?", [now, agentId]);
  }

  // ---- conversations ------------------------------------------------------

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
