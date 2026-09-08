import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { z } from "zod";

/**
 * Host-session identity helpers. A process spawned by a host (hook, MCP shim, or a
 * shell inside the session) can find the session it belongs to by walking its
 * ancestor pids until one matches the host's own session record.
 */

export interface Ancestor {
  pid: number;
  ppid: number;
  comm: string;
}

export async function ancestors(startPid: number = process.pid, max = 12): Promise<Ancestor[]> {
  const out: Ancestor[] = [];
  let pid = startPid;
  for (let i = 0; i < max && pid > 1; i++) {
    let line: string;
    try {
      line = (await $`ps -o pid=,ppid=,comm= -p ${pid}`.quiet().text()).trim();
    } catch {
      break;
    }
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) break;
    const a = { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] ?? "" };
    out.push(a);
    pid = a.ppid;
  }
  return out;
}

const ClaudeRegistry = z.object({
  pid: z.number(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  messagingSocketPath: z.string().optional(),
  status: z.string().optional(),
});

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  socketPath?: string;
  status?: string;
  /** Derived from Claude Code's on-disk layout; may not exist yet for a brand-new session. */
  transcriptPath: string;
}

export function claudeSessionsDir(): string {
  return join(homedir(), ".claude", "sessions");
}

export function readClaudeRegistry(pid: number): ClaudeSession | null {
  const file = join(claudeSessionsDir(), `${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    const r = ClaudeRegistry.parse(JSON.parse(readFileSync(file, "utf8")));
    return {
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      name: r.name ?? `claude-${r.pid}`,
      socketPath: r.messagingSocketPath,
      status: r.status,
      transcriptPath: claudeTranscriptPath(r.cwd, r.sessionId),
    };
  } catch {
    return null;
  }
}

/** Claude Code stores transcripts at ~/.claude/projects/<cwd with / replaced by ->/<sessionId>.jsonl */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/** Find the Claude Code session this process runs inside, by ancestor pid. */
export async function findClaudeSession(
  startPid: number = process.pid,
): Promise<ClaudeSession | null> {
  for (const a of await ancestors(startPid)) {
    const s = readClaudeRegistry(a.pid);
    if (s) return s;
  }
  return null;
}

/** Find a Claude Code session by its session id among all live registry files. */
export function findClaudeSessionById(sessionId: string): ClaudeSession | null {
  const dir = claudeSessionsDir();
  if (!existsSync(dir)) return null;
  for (const f of require("node:fs").readdirSync(dir) as string[]) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m) continue;
    const s = readClaudeRegistry(Number(m[1]));
    if (s?.sessionId === sessionId) return s;
  }
  return null;
}
