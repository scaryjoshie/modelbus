import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { z } from "zod";
import type {
  Command,
  CommandContext,
  ConfigurePlan,
  HostAdapter,
  Observation,
  SelfIdentity,
} from "../core/adapter.ts";
import { type DeliveryResult, delivered, unavailable } from "../core/delivery.ts";
import { cliPath } from "../core/paths.ts";
import { ancestors, isAlive, listProcesses } from "../util/ps.ts";
import { fileOffset, watchTranscript } from "../util/watch.ts";

/**
 * Claude Code.
 *
 * Identity: Claude Code's own session id, from the registry file it writes per
 * session to ~/.claude/sessions/<pid>.json. Survives `--resume`.
 *
 * Delivery: post to the session's inbox socket. With the session's token (handed
 * over by the SessionStart hook or `modelbus attach`) the message is delivered with
 * no dialog in any permission mode, provided the posting process has already exited
 * when Claude Code checks, so we post through a short-lived helper. Without a token
 * the post is unattested and the session's inbound rules decide.
 *
 * Receipt: a transcript entry containing the marker, either `queue-operation`
 * `remove` (queued mid-turn) or a `user` entry (attached to a turn).
 */

const sessionsDir = () => join(homedir(), ".claude", "sessions");

const Registry = z.object({
  pid: z.number(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  messagingSocketPath: z.string().optional(),
  status: z.string().optional(),
});

interface Session {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  socketPath?: string;
  status?: string;
  transcriptPath: string;
}

function readRegistry(pid: number): Session | null {
  const file = join(sessionsDir(), `${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    const r = Registry.parse(JSON.parse(readFileSync(file, "utf8")));
    const slug = r.cwd.replace(/[/.]/g, "-");
    return {
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      name: r.name ?? `claude-${r.pid}`,
      socketPath: r.messagingSocketPath,
      status: r.status,
      transcriptPath: join(homedir(), ".claude", "projects", slug, `${r.sessionId}.jsonl`),
    };
  } catch {
    return null;
  }
}

function liveSessions(): Session[] {
  if (!existsSync(sessionsDir())) return [];
  const out: Session[] = [];
  for (const f of readdirSync(sessionsDir())) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!isAlive(pid)) continue;
    const s = readRegistry(pid);
    if (s) out.push(s);
  }
  return out;
}

/** The Claude Code session this process runs inside, by ancestor pid. */
async function currentSession(): Promise<Session | null> {
  for (const a of await ancestors()) {
    const s = readRegistry(a.pid);
    if (s) return s;
  }
  return null;
}

interface Handle {
  sessionId: string;
}

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
      handle: { sessionId: s.sessionId } satisfies Handle,
      key: s.sessionId,
      name: s.name,
      durability: "session",
      relationship: "top-level",
      evidence: `registry ~/.claude/sessions/${s.pid}.json`,
      reachable: Boolean(s.socketPath),
      note: s.socketPath ? undefined : "no inbox socket",
      pid: s.pid,
      cwd: s.cwd,
      status: s.status,
      startedAt: procs.get(s.pid)?.startedAt,
    }));
  }

  handleFromKey(key: string): Handle {
    return { sessionId: key };
  }

  async identifySelf(): Promise<SelfIdentity | null> {
    const s = await currentSession();
    if (!s) return null;
    const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    return {
      host: this.host,
      key: s.sessionId,
      name: s.name,
      evidence: `ancestor pid ${s.pid}`,
      attach: socketPath
        ? {
            socketPath,
            token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
            transcriptPath: s.transcriptPath,
          }
        : undefined,
    };
  }

  attach(handle: unknown, info: Record<string, unknown>): void {
    const h = handle as Handle;
    const prev = this.attached.get(h.sessionId) ?? {};
    const str = (v: unknown, fallback?: string) => (typeof v === "string" ? v : fallback);
    this.attached.set(h.sessionId, {
      socketPath: str(info.socketPath, prev.socketPath),
      token: str(info.token, prev.token),
      transcriptPath: str(info.transcriptPath, prev.transcriptPath),
    });
  }

  async deliver(
    handle: unknown,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const h = handle as Handle;
    const a = this.attached.get(h.sessionId) ?? {};
    const reg = liveSessions().find((s) => s.sessionId === h.sessionId);
    const socketPath = a.socketPath ?? reg?.socketPath;
    const transcriptPath = a.transcriptPath ?? reg?.transcriptPath;
    if (!socketPath) return unavailable("no inbox socket");
    if (!existsSync(socketPath)) return unavailable("inbox socket missing");
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
    return a.token ? delivered("inbox socket, token") : { outcome: "delivered-unattested" };
  }

  /** CLI verbs this host needs. None of them import the client layer. */
  commands(): Record<string, Command> {
    const attach = async (
      ctx: CommandContext,
      hint: { session_id?: string; transcript_path?: string },
    ) => {
      const me = await this.identifySelf();
      if (!me) throw new Error("not inside a Claude Code session");
      if (!me.attach) throw new Error("no CLAUDE_CODE_MESSAGING_SOCKET in this environment");
      await ctx.ensureDaemon();
      const identity = {
        kind: "self",
        host: me.host,
        key: hint.session_id ?? me.key,
        name: me.name,
        evidence: `hook/attach ${me.evidence}`,
      };
      const r = await ctx.rpc<{ agent: { name: string } }>(
        "attach",
        { ...me.attach, transcriptPath: hint.transcript_path ?? me.attach.transcriptPath },
        identity,
      );
      return r.agent.name;
    };
    return {
      hook: {
        usage: "hook claude-session-start              SessionStart hook entry (stdin JSON)",
        run: async (ctx) => {
          let input: { session_id?: string; transcript_path?: string } = {};
          try {
            input = JSON.parse(await ctx.stdin());
          } catch {
            /* run by hand with no stdin */
          }
          const name = await attach(ctx, input);
          // Hook stdout is added to the session's context.
          console.log(`modelbus: this session is registered as "${name}".`);
        },
      },
      attach: {
        usage:
          "attach                                 register the Claude Code session this runs inside",
        run: async (ctx) => console.log(`attached as "${await attach(ctx, {})}"`),
      },
      post: {
        usage:
          "post                                   (internal) write stdin JSON to an inbox socket",
        run: async (ctx) => {
          const p = JSON.parse(await ctx.stdin()) as {
            socketPath: string;
            token?: string;
            text: string;
          };
          await post(p.socketPath, p.token, p.text);
        },
      },
    };
  }

  configure(): ConfigurePlan {
    const bun = process.execPath;
    const cli = cliPath();
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const hookCommand = `"${bun}" "${cli}" hook claude-session-start`;
    const allowRule = "mcp__modelbus__*";
    const mcpAdd = ["claude", "mcp", "add", "-s", "user", "modelbus", "--", bun, cli, "mcp"];
    return {
      describe: [
        `Claude Code (${settingsPath}): allow ${allowRule}; SessionStart hook ${hookCommand}`,
        `Claude Code: ${mcpAdd.join(" ")}`,
      ],
      apply: async () => {
        const done: string[] = [];
        type Hook = { hooks: Array<{ type: string; command?: string }> };
        const settings = (
          existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {}
        ) as { permissions?: { allow?: string[] }; hooks?: Record<string, Hook[]> };
        const allow = settings.permissions?.allow ?? [];
        if (!allow.includes(allowRule)) {
          allow.push(allowRule);
          done.push(`added permission allow ${allowRule}`);
        }
        settings.permissions = { ...settings.permissions, allow };
        const sessionStart = settings.hooks?.SessionStart ?? [];
        if (!sessionStart.some((g) => g.hooks?.some((h) => h.command === hookCommand))) {
          sessionStart.push({ hooks: [{ type: "command", command: hookCommand }] });
          done.push("added SessionStart hook");
        }
        settings.hooks = { ...settings.hooks, SessionStart: sessionStart };
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        const [cmd, ...args] = mcpAdd;
        const r = await $`${cmd} ${args}`.quiet().nothrow();
        done.push(
          `claude mcp add: exit ${r.exitCode} ${r.stderr.toString().trim() || r.stdout.toString().trim()}`,
        );
        return done;
      },
    };
  }
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

/** Spawn a helper that writes and exits at once, so Claude Code verifies the token. */
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

/** Direct post from this process. Used by the `post` command only. */
function post(socketPath: string, token: string | undefined, text: string): Promise<void> {
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
