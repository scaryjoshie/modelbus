import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import type { Api, WakeProvider } from "../core/api.ts";
import type { Agent, Message } from "../core/store.ts";
import { cliPath } from "../ensure.ts";
import { findClaudeSessionById } from "../hostid.ts";

/**
 * Delivers into a Claude Code session by posting to its inbox socket.
 *
 *  - With the session's token (handed to the daemon by the SessionStart hook or by
 *    `modelbus attach` run inside the session): delivered with no dialog in any
 *    permission mode, PROVIDED the posting process has exited by the time Claude
 *    Code checks. A long-lived poster that is not the session's child is held (seen
 *    2026-09-07: "verified pid <daemon>"). So the daemon posts through a short-lived
 *    helper process (`modelbus post`) that writes and exits immediately.
 *  - Without a token: posted unattested; the session's inbound rules decide
 *    (delivered in prompting mode, held behind a dialog in bypass mode).
 *
 * Receipt is read from the session transcript. Claude Code records a delivered peer
 * message either as a `queue-operation` `remove` entry (message queued during a
 * turn, then pulled in) or directly as a `user` entry (message attached to a turn).
 * Either one containing our marker means the model has the message. Tokens live
 * only in memory here, never in the store or logs.
 */

interface Attached {
  socketPath: string;
  token?: string;
  transcriptPath?: string;
}

const WATCH_INTERVAL_MS = 1000;
const WATCH_TIMEOUT_MS = 15 * 60 * 1000;

export class ClaudeCodeWake implements WakeProvider {
  readonly host = "claude-code";
  private readonly sessions = new Map<string, Attached>();
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly api: Api) {}

  attach(sessionId: string, info: Attached): void {
    this.sessions.set(sessionId, { ...this.sessions.get(sessionId), ...info });
  }

  private resolve(sessionId: string): Attached | null {
    const known = this.sessions.get(sessionId);
    if (known?.socketPath) return known;
    const s = findClaudeSessionById(sessionId);
    if (!s?.socketPath) return null;
    const found: Attached = {
      socketPath: s.socketPath,
      transcriptPath: s.transcriptPath,
      ...known,
    };
    return found;
  }

  async wake(agent: Agent, sessionId: string, message: Message, text: string): Promise<string> {
    const target = this.resolve(sessionId);
    if (!target) return "no-socket";
    if (!existsSync(target.socketPath)) return "socket-missing";
    try {
      await postViaHelper(target.socketPath, target.token, text);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (target.transcriptPath) this.watchReceipt(target.transcriptPath, message.id, agent.id);
    return target.token ? "posted" : "posted-unattested";
  }

  /** Poll the transcript until a queue-operation remove for this message appears. */
  private watchReceipt(transcriptPath: string, messageId: string, agentId: string): void {
    const key = `${agentId}:${messageId}`;
    if (this.watchers.has(key)) return;
    let offset = existsSync(transcriptPath) ? statSync(transcriptPath).size : 0;
    const started = Date.now();
    const marker = `#${messageId}`;
    const timer = setInterval(() => {
      if (Date.now() - started > WATCH_TIMEOUT_MS) return stop();
      if (!existsSync(transcriptPath)) return;
      const size = statSync(transcriptPath).size;
      if (size <= offset) return;
      const fd = openSync(transcriptPath, "r");
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes(marker)) continue;
        if (isDeliveredEntry(line)) {
          this.api.store.markReceived([messageId], agentId);
          return stop();
        }
      }
    }, WATCH_INTERVAL_MS);
    const stop = () => {
      clearInterval(timer);
      this.watchers.delete(key);
    };
    this.watchers.set(key, timer);
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
  if (code !== 0)
    throw new Error((await new Response(child.stderr).text()).trim() || `helper exit ${code}`);
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
