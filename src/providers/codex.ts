import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { ancestors } from "../hostid.ts";
import type { LiveSession, Provider } from "../types.ts";
import { cwdOf, listProcesses } from "../util/ps.ts";

/**
 * Codex (OpenAI) sessions. A Codex TUI process is a *thread* with a UUID. One process
 * can own several threads (a root plus subagents it spawned), each visible as an
 * open lock file `~/.codex/thread-writer-locks/<id>.lock`. Root vs. subagent is
 * decided from the rollout's session_meta: roots have `thread_source: "user"`;
 * subagents have `source.subagent.thread_spawn.parent_thread_id`. Only roots become
 * bus agents (spec section 6). All of this is observed local layout, not a public
 * contract.
 */

export interface CodexThread {
  id: string;
  rolloutPath?: string;
  root: boolean;
  /** How root/subagent was decided: db, rollout, single-lock, or unknown. */
  evidence: "db" | "rollout" | "single-lock" | "unknown";
  parentId?: string;
  name?: string;
  title?: string;
  cwd?: string;
}

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Thread ids a process holds writer locks for. */
export async function threadIdsForPid(pid: number): Promise<string[]> {
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

/** Read thread metadata from Codex's state database (read-only) and the rollout header. */
export function threadMeta(id: string): CodexThread {
  const meta: CodexThread = { id, root: false, evidence: "unknown" };
  try {
    // immutable=1: read without locks or a -shm file, which a read-only connection
    // cannot create when the WAL sidecars are absent (SQLITE_CANTOPEN otherwise).
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
        meta.rolloutPath = row.rollout_path ?? undefined;
        meta.name = row.name ?? undefined;
        meta.title = row.title ?? undefined;
        meta.cwd = row.cwd ?? undefined;
        if (row.thread_source === "user") {
          meta.root = true;
          meta.evidence = "db";
        } else if (row.thread_source === "subagent" || (row.source ?? "").includes('"subagent"')) {
          meta.root = false;
          meta.evidence = "db";
          const m = (row.source ?? "").match(/"parent_thread_id":"([0-9a-f-]{36})"/);
          if (m?.[1]) meta.parentId = m[1];
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* state db unavailable; fall through to rollout header */
  }
  if (meta.evidence === "unknown" && meta.rolloutPath && existsSync(meta.rolloutPath)) {
    try {
      const first = readFileSync(meta.rolloutPath, "utf8").split("\n")[0] ?? "";
      const head = JSON.parse(first) as {
        payload?: {
          thread_source?: unknown;
          source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } } | string;
          cwd?: string;
        };
      };
      const p = head.payload ?? {};
      if (typeof p.source === "object" && p.source?.subagent?.thread_spawn?.parent_thread_id) {
        meta.parentId = p.source.subagent.thread_spawn.parent_thread_id;
        meta.root = false;
        meta.evidence = "rollout";
      } else if (p.thread_source === "user" || p.source === "cli") {
        meta.root = true;
        meta.evidence = "rollout";
      }
      meta.cwd ??= p.cwd;
    } catch {
      /* unreadable header: leave root=false (unknown), never guess */
    }
  }
  return meta;
}

/**
 * Classify a process's threads. A process holding exactly one lock is a root by
 * construction (subagents run inside the parent's process next to the parent's
 * lock), which covers brand-new sessions that have no state row yet.
 */
export async function threadsForPid(pid: number): Promise<CodexThread[]> {
  const threads = (await threadIdsForPid(pid)).map(threadMeta);
  if (threads.length === 1 && threads[0] && threads[0].evidence === "unknown") {
    threads[0].root = true;
    threads[0].evidence = "single-lock";
  }
  return threads;
}

/** The root thread of a Codex process, if exactly one can be identified. */
export async function rootThreadForPid(pid: number): Promise<CodexThread | null> {
  const roots = (await threadsForPid(pid)).filter((t) => t.root);
  return roots.length === 1 ? (roots[0] ?? null) : null;
}

/** Find the Codex session this process runs inside, by ancestor pid. */
export async function findCodexSession(
  startPid: number = process.pid,
): Promise<{ pid: number; thread: CodexThread } | null> {
  for (const a of await ancestors(startPid)) {
    if (a.comm.split("/").pop() !== "codex") continue;
    const thread = await rootThreadForPid(a.pid);
    if (thread) return { pid: a.pid, thread };
  }
  return null;
}

/** Unnamed roots are numbered by creation order (thread ids are time-ordered). */
export function codexDisplayNames(roots: CodexThread[]): Map<string, string> {
  const names = new Map<string, string>();
  const sorted = [...roots].sort((a, b) => a.id.localeCompare(b.id));
  let n = 1;
  for (const t of sorted) names.set(t.id, t.name ?? `codex-${n++}`);
  return names;
}

export const codex: Provider = {
  kind: "codex",
  async detect(): Promise<LiveSession[]> {
    const procs = (await listProcesses()).filter((p) => p.exe === "codex" && p.tty);
    const found: Array<{ p: (typeof procs)[number]; threads: CodexThread[]; cwd?: string }> = [];
    for (const p of procs) {
      found.push({
        p,
        threads: await threadsForPid(p.pid),
        cwd: await cwdOf(p.pid),
      });
    }
    const allRoots = found.flatMap((f) => f.threads.filter((t) => t.root));
    const names = codexDisplayNames(allRoots);
    const out: LiveSession[] = [];
    for (const { p, threads, cwd } of found) {
      const roots = threads.filter((t) => t.root);
      if (roots.length === 1 && roots[0]) {
        const t = roots[0];
        // `codex queue` needs the thread to exist in Codex's store, which happens on
        // the first turn. A session with no rollout yet can be seen but not queued to.
        const queueable = Boolean(t.rolloutPath);
        out.push({
          host: "codex",
          name: names.get(t.id) ?? "codex",
          pid: p.pid,
          tty: p.tty,
          cwd: t.cwd ?? cwd,
          sessionId: t.id,
          startedAt: p.startedAt,
          reach: queueable ? ["codex-queue"] : ["pull-only"],
          extra: {
            title: t.title,
            subagents: threads.length - 1,
            evidence: t.evidence,
            note: queueable ? undefined : "no turns yet; codex queue works after the first turn",
          },
        });
      } else {
        out.push({
          host: "codex",
          name: `codex-${p.pid}`,
          pid: p.pid,
          tty: p.tty,
          cwd,
          startedAt: p.startedAt,
          reach: ["pull-only"],
          extra: { note: roots.length ? "multiple root threads" : "no root thread identified" },
        });
      }
    }
    return out;
  },
};
