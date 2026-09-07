import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LiveSession, Provider } from "../types.ts";

/**
 * Aside (the browser) runs a separate `aside-daemon` on localhost. Its health endpoint
 * is unauthenticated and reports whether any session is running. Session details come
 * from the per-account SQLite store at ~/.aside/u/<n>/state.db, read-only.
 *
 * Everything here is from local inspection, not public docs, and may change.
 */
const DEFAULT_PORT = 21420;

const Health = z.object({
  service: z.literal("aside-daemon"),
  version: z.string(),
  pid: z.number(),
  port: z.number(),
  status: z.string(),
  runningSessionCount: z.number(),
});

interface SessionRow {
  id: string;
  title: string;
  status: string;
  cwd: string;
  updated_at: number;
  created_at: number;
  archived_at: number | null;
  active_tab_target_id: string | null;
}

async function health(): Promise<z.infer<typeof Health> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    return Health.parse(await res.json());
  } catch {
    return undefined;
  }
}

function readSessions(dbPath: string): SessionRow[] {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .query<SessionRow, []>(
          `SELECT id, title, status, cwd, updated_at, created_at, archived_at, active_tab_target_id
           FROM sessions
           WHERE archived_at IS NULL AND ephemeral = 0
           ORDER BY updated_at DESC
           LIMIT 50`,
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export const aside: Provider = {
  kind: "aside",
  async detect(): Promise<LiveSession[]> {
    const h = await health();
    if (!h) return [];
    const out: LiveSession[] = [];
    const usersDir = join(homedir(), ".aside", "u");
    let accounts: string[] = [];
    try {
      accounts = (await readdir(usersDir)).filter((d) => /^\d+$/.test(d));
    } catch {
      /* no accounts dir */
    }
    for (const acct of accounts) {
      for (const row of readSessions(join(usersDir, acct, "state.db"))) {
        out.push({
          host: "aside",
          name: row.title || `aside-${row.id}`,
          pid: h.pid,
          cwd: row.cwd || undefined,
          status: row.status,
          sessionId: row.id,
          startedAt: row.created_at * 1000,
          reach: ["aside-mcp"],
          extra: {
            account: Number(acct),
            daemonVersion: h.version,
            hasTab: row.active_tab_target_id != null,
            lastActive: new Date(row.updated_at * 1000).toISOString(),
          },
        });
      }
    }
    return out;
  },
};
