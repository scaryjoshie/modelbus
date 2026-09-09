import { existsSync } from "node:fs";
import type { HostAdapter, Observation, SelfIdentity } from "../../core/adapter.ts";
import { type DeliveryResult, failed, queued } from "../../core/delivery.ts";
import { listProcesses } from "../../util/ps.ts";
import { fileOffset, watchTranscript } from "../../util/watch.ts";
import { configure } from "./configure.ts";
import { postViaHelper } from "./post.ts";
import { currentSession, liveSessions } from "./registry.ts";

/**
 * Claude Code.
 *
 * Identity: Claude Code's own session id, from the registry file it writes per
 * session. Survives `--resume`.
 *
 * Delivery: post to the session's inbox socket. With the session's token (handed
 * over by the SessionStart hook or `modelbus attach`) the message goes in with no
 * dialog in any permission mode. Without it the session's inbound rules decide,
 * which may mean a dialog for the user. Tokens are kept in memory only.
 *
 * Receipt: a transcript entry containing the marker, either `queue-operation`
 * `remove` (queued mid-turn) or a `user` entry (attached to a turn).
 */

interface Attached {
  socketPath?: string;
  token?: string;
  transcriptPath?: string;
}

export class ClaudeCodeAdapter implements HostAdapter {
  readonly host = "claude-code";
  private readonly attached = new Map<string, Attached>();

  async observe(): Promise<Observation[]> {
    const procs = new Map((await listProcesses()).map((p) => [p.pid, p]));
    return liveSessions().map((s) => ({
      key: s.sessionId,
      name: s.name,
      relationship: "top-level",
      reachable: Boolean(s.socketPath),
      note: s.socketPath ? undefined : "no inbox socket",
      pid: s.pid,
      cwd: s.cwd,
      status: s.status,
      startedAt: procs.get(s.pid)?.startedAt,
    }));
  }

  async identifySelf(): Promise<SelfIdentity | null> {
    const s = await currentSession();
    if (!s) return null;
    const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    return {
      host: this.host,
      key: s.sessionId,
      name: s.name,
      attach: socketPath
        ? {
            socketPath,
            token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
            transcriptPath: s.transcriptPath,
          }
        : undefined,
    };
  }

  attach(sessionId: string, info: Record<string, unknown>): void {
    const prev = this.attached.get(sessionId) ?? {};
    const str = (v: unknown, fallback?: string) => (typeof v === "string" ? v : fallback);
    this.attached.set(sessionId, {
      socketPath: str(info.socketPath, prev.socketPath),
      token: str(info.token, prev.token),
      transcriptPath: str(info.transcriptPath, prev.transcriptPath),
    });
  }

  async deliver(
    sessionId: string,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const a = this.attached.get(sessionId) ?? {};
    const reg = liveSessions().find((s) => s.sessionId === sessionId);
    const socketPath = a.socketPath ?? reg?.socketPath;
    const transcriptPath = a.transcriptPath ?? reg?.transcriptPath;
    if (!socketPath) return failed("no inbox socket");
    if (!existsSync(socketPath)) return failed("inbox socket missing");
    const fromOffset = transcriptPath ? fileOffset(transcriptPath) : 0;
    await postViaHelper(socketPath, a.token, text);
    if (transcriptPath) {
      watchTranscript({
        path: transcriptPath,
        marker,
        fromOffset,
        accept: isDelivered,
        onFound: onReceipt,
      });
    }
    return a.token
      ? queued("inbox socket, with token")
      : queued("inbox socket, no token: the session may ask its user");
  }

  configure = configure;
}

function isDelivered(line: string): boolean {
  try {
    const d = JSON.parse(line) as { type?: string; operation?: string };
    if (d.type === "queue-operation") return d.operation === "remove";
    return d.type === "user";
  } catch {
    return false;
  }
}
