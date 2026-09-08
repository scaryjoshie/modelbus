import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type Identity, rpc } from "../client.ts";
import { cliPath, ensureDaemon } from "../ensure.ts";
import { findClaudeSession, findClaudeSessionById } from "../hostid.ts";

/**
 * Claude Code setup: the SessionStart hook handler, manual attach for sessions that
 * predate the hook, and what `init` writes. See docs/poc-spec.md section 9.
 */

/** Read the hook's stdin JSON, register this session with the daemon, hand over the token. */
export async function hookSessionStart(stdinJson: string): Promise<string> {
  let input: { session_id?: string; cwd?: string; transcript_path?: string } = {};
  try {
    input = JSON.parse(stdinJson);
  } catch {
    /* tolerate empty stdin when run by hand */
  }
  return attachCurrentSession({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
  });
}

/** Register the Claude Code session this process runs inside. Needs the session's env. */
export async function attachCurrentSession(
  hint: { sessionId?: string; transcriptPath?: string } = {},
): Promise<string> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath)
    throw new Error("not inside a Claude Code session (no CLAUDE_CODE_MESSAGING_SOCKET)");

  const session = hint.sessionId
    ? (findClaudeSessionById(hint.sessionId) ?? (await findClaudeSession()))
    : await findClaudeSession();
  if (!session)
    throw new Error("could not find this session's registry file under ~/.claude/sessions");

  await ensureDaemon();
  const identity: Identity = {
    kind: "binding",
    host: "claude-code",
    ref: session.sessionId,
    name: session.name,
    evidence: `hook/attach pid ${session.pid}`,
  };
  const r = await rpc<{ agent: { name: string } }>(
    "attach",
    {
      sessionId: session.sessionId,
      socketPath,
      token,
      transcriptPath: hint.transcriptPath ?? session.transcriptPath,
    },
    identity,
  );
  return r.agent.name;
}

// ---- init ----------------------------------------------------------------

export interface ClaudeInitPlan {
  settingsPath: string;
  hookCommand: string;
  mcpCommand: string[];
  allowRule: string;
  settingsPatch: Record<string, unknown>;
}

export function claudeInitPlan(): ClaudeInitPlan {
  const bun = process.execPath;
  const cli = cliPath();
  const hookCommand = `"${bun}" "${cli}" hook claude-session-start`;
  return {
    settingsPath: join(homedir(), ".claude", "settings.json"),
    hookCommand,
    mcpCommand: ["claude", "mcp", "add", "-s", "user", "modelbus", "--", bun, cli, "mcp"],
    allowRule: "mcp__modelbus__*",
    settingsPatch: {
      permissions: { allow: ["mcp__modelbus__*"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }] },
    },
  };
}

/** Apply the plan: merge settings.json non-destructively and register the MCP server. */
export async function claudeInitWrite(plan: ClaudeInitPlan): Promise<string[]> {
  const done: string[] = [];
  const settings = existsSync(plan.settingsPath)
    ? (JSON.parse(readFileSync(plan.settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  const permissions = (settings.permissions ??= {}) as { allow?: string[] };
  permissions.allow ??= [];
  if (!permissions.allow.includes(plan.allowRule)) {
    permissions.allow.push(plan.allowRule);
    done.push(`added permission allow ${plan.allowRule}`);
  }
  const hooks = (settings.hooks ??= {}) as Record<
    string,
    Array<{ hooks: Array<{ command?: string }> }>
  >;
  hooks.SessionStart ??= [];
  const present = hooks.SessionStart.some((g) =>
    g.hooks?.some((h) => h.command === plan.hookCommand),
  );
  if (!present) {
    hooks.SessionStart.push({ hooks: [{ type: "command", command: plan.hookCommand }] as never });
    done.push("added SessionStart hook");
  }
  writeFileSync(plan.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const [cmd, ...args] = plan.mcpCommand;
  const r = await $`${cmd} ${args}`.quiet().nothrow();
  done.push(
    `claude mcp add: exit ${r.exitCode} ${r.stderr.toString().trim() || r.stdout.toString().trim()}`,
  );
  return done;
}
