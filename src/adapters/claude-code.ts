import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import type { ConfigurePlan, HostAdapter, Observation } from "../core/adapter.ts";
import { cliPath } from "../ensure.ts";
import { claudeSessionsDir, readClaudeRegistry } from "../hostid.ts";
import { claudeInitPlan, claudeInitWrite } from "../providers/claude-code-setup.ts";
import { watchTranscript } from "../providers/watch.ts";
import { isAlive, listProcesses } from "../util/ps.ts";

/**
 * Claude Code adapter.
 *
 * Identity: Claude Code's own session id, read from the per-session registry file
 * it writes to ~/.claude/sessions/<pid>.json. Survives `--resume`. Sealed in the
 * handle; the core only sees the key.
 *
 * Delivery: post to the session's inbox socket. With the session's token (handed
 * over by the SessionStart hook or `modelbus attach`) the message is delivered
 * without a dialog in any permission mode, PROVIDED the posting process has exited
 * by the time Claude Code checks, so we post through a short-lived helper. Without
 * a token the post is unattested and the session's inbound rules decide.
 *
 * Receipt: a transcript entry containing the marker, either `queue-operation`
 * `remove` (queued mid-turn) or a `user` entry (attached to a turn).
 */

interface ClaudeHandle {
  sessionId: string;
}

interface Attached {
  socketPath?: string;
  token?: string;
  transcriptPath?: string;
}

export class ClaudeCodeAdapter implements HostAdapter {
  readonly host = "claude-code" as const;
  private readonly attached = new Map<string, Attached>();

  async observe(): Promise<Observation[]> {
    const dir = claudeSessionsDir();
    if (!existsSync(dir)) return [];
    const procs = new Map((await listProcesses()).map((p) => [p.pid, p]));
    const out: Observation[] = [];
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!isAlive(pid)) continue;
      const s = readClaudeRegistry(pid);
      if (!s) continue;
      const handle: ClaudeHandle = { sessionId: s.sessionId };
      out.push({
        handle,
        key: s.sessionId,
        name: s.name,
        durability: "session",
        relationship: "top-level",
        evidence: `registry ~/.claude/sessions/${pid}.json`,
        reachable: Boolean(s.socketPath),
        note: s.socketPath ? undefined : "no inbox socket",
        pid,
        tty: procs.get(pid)?.tty,
        cwd: s.cwd,
        status: s.status,
        startedAt: procs.get(pid)?.startedAt,
      });
    }
    return out;
  }

  handleFromKey(key: string): ClaudeHandle {
    return { sessionId: key };
  }

  attach(handle: unknown, info: Record<string, unknown>): void {
    const h = handle as ClaudeHandle;
    const prev = this.attached.get(h.sessionId) ?? {};
    this.attached.set(h.sessionId, {
      socketPath: typeof info.socketPath === "string" ? info.socketPath : prev.socketPath,
      token: typeof info.token === "string" ? info.token : prev.token,
      transcriptPath:
        typeof info.transcriptPath === "string" ? info.transcriptPath : prev.transcriptPath,
    });
  }

  async deliver(
    handle: unknown,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<string> {
    const h = handle as ClaudeHandle;
    const a = this.attached.get(h.sessionId) ?? {};
    let socketPath = a.socketPath;
    let transcriptPath = a.transcriptPath;
    if (!socketPath || !transcriptPath) {
      const s = this.registryBySessionId(h.sessionId);
      socketPath ??= s?.socketPath;
      transcriptPath ??= s?.transcriptPath;
    }
    if (!socketPath) return "no-socket";
    if (!existsSync(socketPath)) return "socket-missing";
    await postViaHelper(socketPath, a.token, text);
    if (transcriptPath) {
      watchTranscript({
        path: transcriptPath,
        marker,
        accept: isDeliveredEntry,
        onFound: onReceipt,
      });
    }
    return a.token ? "posted" : "posted-unattested";
  }

  configure(): ConfigurePlan {
    const plan = claudeInitPlan();
    return {
      describe: [
        `Claude Code (${plan.settingsPath}): merge ${JSON.stringify(plan.settingsPatch)}`,
        `Claude Code: run ${plan.mcpCommand.join(" ")}`,
      ],
      apply: () => claudeInitWrite(plan),
    };
  }

  private registryBySessionId(sessionId: string) {
    const dir = claudeSessionsDir();
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m) continue;
      const s = readClaudeRegistry(Number(m[1]));
      if (s?.sessionId === sessionId) return s;
    }
    return null;
  }
}

/** A transcript line (already known to contain the marker) that proves delivery. */
export function isDeliveredEntry(line: string): boolean {
  try {
    const d = JSON.parse(line) as { type?: string; operation?: string };
    if (d.type === "queue-operation") return d.operation === "remove";
    return d.type === "user";
  } catch {
    return false;
  }
}

/**
 * Spawn a helper that connects, writes, and exits at once, so Claude Code's own-child
 * check finds no running process and verifies the token instead. The token goes over
 * the helper's stdin, never argv or the environment.
 */
async function postViaHelper(socketPath: string, token: string | undefined, text: string) {
  const child = Bun.spawn([process.execPath, cliPath(), "post"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ socketPath, token, text }));
  child.stdin.end();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error((await new Response(child.stderr).text()).trim() || `helper exit ${code}`);
  }
}

/** Direct post from this process. Used by the `modelbus post` helper. */
export function post(socketPath: string, token: string | undefined, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    sock.setTimeout(5000);
    sock.on("connect", () => {
      const lines: string[] = [];
      if (token) lines.push(JSON.stringify({ type: "auth", token }));
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
      sock.end(`${lines.join("\n")}\n`, () => resolve());
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("socket timeout"));
    });
    sock.on("error", reject);
  });
}
