import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Aside's local layout: per-account SQLite state at ~/.aside/u/<N>/state.db
 * (read-only here), session transcripts, the CLI, and the daemon's health URL.
 * Observed layout, not a public contract.
 */

const HEALTH = "http://127.0.0.1:21420/health";
const HEALTH_TIMEOUT_MS = 1500;
const SESSION_LIMIT = 50;

export const usersDir = () => join(homedir(), ".aside", "u");
export const asideCli = () => join(homedir(), ".local", "bin", "aside");

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  updated_at: number;
  created_at: number;
  parent_id: string | null;
  trigger: string | null;
}

export function accounts(): number[] {
  if (!existsSync(usersDir())) return [];
  return readdirSync(usersDir())
    .filter((d) => /^\d+$/.test(d) && existsSync(join(usersDir(), d, "settings.json")))
    .map(Number);
}

export function sessionsOf(account: number): SessionRow[] {
  const path = join(usersDir(), String(account), "state.db");
  if (!existsSync(path)) return [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db
        .query<SessionRow, [number]>(
          `SELECT id, title, status, updated_at, created_at, parent_id, trigger FROM sessions
           WHERE archived_at IS NULL AND ephemeral = 0 ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(SESSION_LIMIT);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function transcriptPath(account: number, sessionId: string): string | undefined {
  const dir = join(usersDir(), String(account), "sessions");
  if (!existsSync(dir)) return undefined;
  const match = readdirSync(dir).find((d) => d.endsWith(`_${sessionId}`));
  return match ? join(dir, match, "messages.jsonl") : undefined;
}

export async function daemonUp(): Promise<boolean> {
  try {
    return (await fetch(HEALTH, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** A messages.jsonl line recording a user entry (how Aside records queued text). */
export function isUserEntry(line: string): boolean {
  try {
    return (JSON.parse(line) as { role?: string }).role === "user";
  } catch {
    return false;
  }
}
