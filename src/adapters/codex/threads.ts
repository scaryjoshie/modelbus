import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/**
 * Codex threads as seen from outside: which threads a process holds open (lock
 * files), and whether each is a root or a subagent (state DB, rollout header, or
 * the single-lock rule). All of this is observed local layout, not a contract.
 */

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

export interface Thread {
  id: string;
  rolloutPath?: string;
  root: boolean;
  classifiedBy: "db" | "rollout" | "single-lock" | "unknown";
  parentId?: string;
  name?: string;
  title?: string;
  cwd?: string;
}

async function lockedThreadIds(pid: number): Promise<string[]> {
  try {
    const out = await $`lsof -p ${pid} -Fn`.quiet().text();
    const ids = new Set<string>();
    for (const line of out.split("\n")) {
      const m = line.match(/thread-writer-locks\/([0-9a-f-]{36})\.lock$/);
      if (m?.[1]) ids.add(m[1]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

export function threadMeta(id: string): Thread {
  const t: Thread = { id, root: false, classifiedBy: "unknown" };
  try {
    // immutable=1: read without locks or a -shm sidecar, which a read-only
    // connection cannot create when absent (SQLITE_CANTOPEN otherwise).
    const db = new Database(`file:${join(codexHome(), "state_5.sqlite")}?immutable=1`, {
      readonly: true,
    });
    try {
      const row = db
        .query<
          {
            rollout_path: string | null;
            name: string | null;
            title: string | null;
            cwd: string | null;
            thread_source: string | null;
            source: string | null;
          },
          [string]
        >("SELECT rollout_path, name, title, cwd, thread_source, source FROM threads WHERE id = ?")
        .get(id);
      if (row) {
        t.rolloutPath = row.rollout_path ?? undefined;
        t.name = row.name ?? undefined;
        t.title = row.title ?? undefined;
        t.cwd = row.cwd ?? undefined;
        if (row.thread_source === "user") {
          t.root = true;
          t.classifiedBy = "db";
        } else if (row.thread_source === "subagent" || (row.source ?? "").includes('"subagent"')) {
          t.classifiedBy = "db";
          t.parentId = (row.source ?? "").match(/"parent_thread_id":"([0-9a-f-]{36})"/)?.[1];
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through to the rollout header */
  }
  if (t.classifiedBy === "unknown" && t.rolloutPath && existsSync(t.rolloutPath)) {
    try {
      const head = JSON.parse(readFileSync(t.rolloutPath, "utf8").split("\n")[0] ?? "") as {
        payload?: {
          thread_source?: unknown;
          source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } } | string;
          cwd?: string;
        };
      };
      const p = head.payload ?? {};
      if (typeof p.source === "object" && p.source?.subagent?.thread_spawn?.parent_thread_id) {
        t.parentId = p.source.subagent.thread_spawn.parent_thread_id;
        t.classifiedBy = "rollout";
      } else if (p.thread_source === "user" || p.source === "cli") {
        t.root = true;
        t.classifiedBy = "rollout";
      }
      t.cwd ??= p.cwd;
    } catch {
      /* unreadable header: stays unknown, never guessed */
    }
  }
  return t;
}

export async function threadsForPid(pid: number): Promise<Thread[]> {
  const threads = (await lockedThreadIds(pid)).map(threadMeta);
  const only = threads[0];
  if (threads.length === 1 && only && only.classifiedBy === "unknown") {
    only.root = true;
    only.classifiedBy = "single-lock";
  }
  return threads;
}

/** Unnamed roots are numbered by creation order (thread ids are time-ordered). */
export function displayNames(roots: Thread[]): Map<string, string> {
  const names = new Map<string, string>();
  let n = 1;
  for (const t of [...roots].sort((a, b) => a.id.localeCompare(b.id))) {
    names.set(t.id, t.name ?? `codex-${n++}`);
  }
  return names;
}

/** A rollout line recording a user message (how Codex records queued text). */
export function isUserMessage(line: string): boolean {
  try {
    const d = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } };
    return d.type === "response_item" && d.payload?.type === "message" && d.payload.role === "user";
  } catch {
    return false;
  }
}
