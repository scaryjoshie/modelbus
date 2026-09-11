import { existsSync, statSync } from "node:fs";
import { delivered, failed, type Outbound } from "../../core/delivery.ts";
import type {
  Delivered,
  Observation,
  Provider,
  Secrets,
  SelfIdentity,
} from "../../runtime/provider.ts";
import { attributed } from "../../util/attribution.ts";
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
 * which may mean a dialog for the user. Tokens are remembered through the daemon's
 * secrets, keyed by session id, and forgotten when the session is no longer live.
 *
 * Read: a transcript entry containing the marker, either `queue-operation`
 * `remove` (queued mid-turn) or a `user` entry (attached to a turn).
 */

export class ClaudeCodeProvider implements Provider {
  readonly name = "claude-code";
  readonly discovery = { observe: this.observe.bind(this) };
  readonly connector = {
    /** Verified 2026-09-10: a queued message survives `--resume`. */
    queueSurvivesRestart: true,
    deliver: this.deliver.bind(this),
    attach: this.attach.bind(this),
  };
  /** Session tokens, by session id. Absent outside the daemon, where nothing is delivered. */
  private readonly secrets: Secrets | undefined;

  constructor(secretsFor?: (host: string) => Secrets) {
    this.secrets = secretsFor?.(this.name);
  }

  private async observe(): Promise<Observation[]> {
    const procs = new Map((await listProcesses()).map((p) => [p.pid, p]));
    const sessions = liveSessions();
    this.forgetGone(new Set(sessions.map((s) => s.sessionId)));
    return sessions.map((s) => ({
      key: s.sessionId,
      name: s.name,
      relationship: "top-level",
      reachable: Boolean(s.socketPath),
      note: s.socketPath ? undefined : "no inbox socket",
      pid: s.pid,
      cwd: s.cwd,
      status: s.status,
      startedAt: procs.get(s.pid)?.startedAt,
      // The transcript grows whenever the session does anything.
      activeAt: existsSync(s.transcriptPath) ? statSync(s.transcriptPath).mtimeMs : undefined,
    }));
  }

  async identifySelf(): Promise<SelfIdentity | null> {
    const s = await currentSession();
    if (!s) return null;
    const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    return {
      provider: this.name,
      key: s.sessionId,
      name: s.name,
      attach: token ? { token } : undefined,
    };
  }

  /** Only the token needs remembering; the socket and transcript come from the registry. */
  private attach(sessionId: string, info: Record<string, unknown>): void {
    if (typeof info.token === "string") this.secrets?.set(sessionId, info.token);
  }

  /** Drop tokens of sessions that are gone. A resumed session re-attaches from its hook. */
  private forgetGone(live: Set<string>): void {
    if (!this.secrets) return;
    for (const id of this.secrets.list()) if (!live.has(id)) this.secrets.delete(id);
  }

  private async deliver(
    sessionId: string,
    outbound: Outbound,
    onRead: () => void,
  ): Promise<Delivered> {
    const reg = liveSessions().find((s) => s.sessionId === sessionId);
    const socketPath = reg?.socketPath;
    const transcriptPath = reg?.transcriptPath;
    const token = this.secrets?.get(sessionId);
    if (!socketPath) return { result: failed("no inbox socket") };
    if (!existsSync(socketPath)) return { result: failed("inbox socket missing") };
    const { text, marker } = attributed(outbound);
    const fromOffset = transcriptPath ? fileOffset(transcriptPath) : 0;
    await postViaHelper(socketPath, token, text);
    const watch = transcriptPath
      ? watchTranscript({
          path: transcriptPath,
          marker,
          fromOffset,
          accept: isDelivered,
          onFound: onRead,
        })
      : undefined;
    const result = token
      ? delivered("inbox socket, with token")
      : delivered("inbox socket, no token: the session may ask its user");
    return { result, watch };
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
