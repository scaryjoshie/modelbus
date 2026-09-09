import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { ConfigurePlan, HostAdapter, Observation, SelfIdentity } from "../core/adapter.ts";
import { type DeliveryResult, delivered, failed } from "../core/delivery.ts";
import { cliPath } from "../core/paths.ts";
import { ancestors, cwdOf, listProcesses } from "../util/ps.ts";
import { fileOffset, watchTranscript } from "../util/watch.ts";

/**
 * Codex (OpenAI).
 *
 * Identity: the thread id of a process's root thread. One process can own a root
 * plus subagent threads, each visible as a lock file it holds open. Root vs
 * subagent comes from Codex's state DB (`threads.thread_source`), the rollout
 * header, or the single-lock rule (a process holding exactly one lock is a root).
 * Survives `codex resume`.
 *
 * Delivery: the official `codex queue --thread`. Fails for a thread that has never
 * had a turn ("no rollout found"), reported as not reachable.
 *
 * Receipt: the rollout records the queued text as a user message.
 */

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

interface Thread {
  id: string;
  rolloutPath?: string;
  root: boolean;
  evidence: "db" | "rollout" | "single-lock" | "unknown";
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

function threadMeta(id: string): Thread {
  const t: Thread = { id, root: false, evidence: "unknown" };
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
          t.evidence = "db";
        } else if (row.thread_source === "subagent" || (row.source ?? "").includes('"subagent"')) {
          t.evidence = "db";
          t.parentId = (row.source ?? "").match(/"parent_thread_id":"([0-9a-f-]{36})"/)?.[1];
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through to the rollout header */
  }
  if (t.evidence === "unknown" && t.rolloutPath && existsSync(t.rolloutPath)) {
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
        t.evidence = "rollout";
      } else if (p.thread_source === "user" || p.source === "cli") {
        t.root = true;
        t.evidence = "rollout";
      }
      t.cwd ??= p.cwd;
    } catch {
      /* unreadable header: stays unknown, never guessed */
    }
  }
  return t;
}

async function threadsForPid(pid: number): Promise<Thread[]> {
  const threads = (await lockedThreadIds(pid)).map(threadMeta);
  const only = threads[0];
  if (threads.length === 1 && only && only.evidence === "unknown") {
    only.root = true;
    only.evidence = "single-lock";
  }
  return threads;
}

/** Unnamed roots are numbered by creation order (thread ids are time-ordered). */
function displayNames(roots: Thread[]): Map<string, string> {
  const names = new Map<string, string>();
  let n = 1;
  for (const t of [...roots].sort((a, b) => a.id.localeCompare(b.id))) {
    names.set(t.id, t.name ?? `codex-${n++}`);
  }
  return names;
}

export class CodexAdapter implements HostAdapter {
  readonly host = "codex";

  async observe(): Promise<Observation[]> {
    const procs = (await listProcesses()).filter((p) => p.exe === "codex" && p.tty);
    const found: Array<{ pid: number; startedAt?: number; threads: Thread[]; cwd?: string }> = [];
    for (const p of procs) {
      found.push({
        pid: p.pid,
        startedAt: p.startedAt,
        threads: await threadsForPid(p.pid),
        cwd: await cwdOf(p.pid),
      });
    }
    const names = displayNames(found.flatMap((f) => f.threads.filter((t) => t.root)));
    const out: Observation[] = [];
    for (const f of found) {
      for (const t of f.threads) {
        const queueable = t.root && Boolean(t.rolloutPath);
        out.push({
          key: t.id,
          name: names.get(t.id) ?? `codex-${t.id.slice(0, 4)}`,
          relationship: t.root ? "top-level" : t.parentId ? "subagent" : "unknown",
          reachable: queueable,
          note:
            t.root && !queueable
              ? "no turns yet; codex queue works after the first turn"
              : undefined,
          pid: f.pid,
          cwd: t.cwd ?? f.cwd,
          title: t.title,
          startedAt: f.startedAt,
        });
      }
    }
    return out;
  }

  async identifySelf(): Promise<SelfIdentity | null> {
    for (const a of await ancestors()) {
      if (a.comm.split("/").pop() !== "codex") continue;
      const roots = (await threadsForPid(a.pid)).filter((t) => t.root);
      const root = roots[0];
      if (roots.length !== 1 || !root) continue;
      return {
        host: this.host,
        key: root.id,
        name: displayNames([root]).get(root.id) ?? "codex-1",
      };
    }
    return null;
  }

  async deliver(
    threadId: string,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const meta = threadMeta(threadId);
    const fromOffset = meta.rolloutPath ? fileOffset(meta.rolloutPath) : 0;
    const proc = Bun.spawn(["codex", "queue", "--thread", threadId, "--message", text], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return failed(`codex queue: ${err || "failed"}`);
    }
    if (meta.rolloutPath) {
      watchTranscript({
        path: meta.rolloutPath,
        marker,
        fromOffset,
        accept: isUserMessage,
        onFound: onReceipt,
      });
    }
    return delivered("codex queue");
  }

  configure(): ConfigurePlan {
    const configPath = join(codexHome(), "config.toml");
    const tools = ["send", "who", "sync"];
    const mcpAdd = ["codex", "mcp", "add", "modelbus", "--", process.execPath, cliPath(), "mcp"];
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const hasServer = /\[mcp_servers\.modelbus\]/.test(current);
    const missing = tools.filter((t) => !current.includes(`[mcp_servers.modelbus.tools.${t}]`));
    return {
      describe: [
        hasServer ? `Codex (${configPath}): server configured` : `Codex: ${mcpAdd.join(" ")}`,
        missing.length
          ? `Codex (${configPath}): pre-approve tools ${missing.join(", ")} (approval_mode = "approve")`
          : `Codex (${configPath}): tools pre-approved`,
      ],
      apply: async () => {
        const done: string[] = [];
        if (!hasServer) {
          const [cmd, ...args] = mcpAdd;
          const r = await $`${cmd} ${args}`.quiet().nothrow();
          done.push(`codex mcp add: exit ${r.exitCode}`);
        }
        if (missing.length) {
          appendFileSync(
            configPath,
            missing
              .map((t) => `\n[mcp_servers.modelbus.tools.${t}]\napproval_mode = "approve"\n`)
              .join(""),
          );
          done.push(`codex: pre-approved ${missing.join(", ")}`);
        }
        return done;
      },
    };
  }
}

function isUserMessage(line: string): boolean {
  try {
    const d = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } };
    return d.type === "response_item" && d.payload?.type === "message" && d.payload.role === "user";
  } catch {
    return false;
  }
}
