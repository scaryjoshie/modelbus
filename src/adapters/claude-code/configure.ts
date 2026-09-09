import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { ConfigurePlan } from "../../core/adapter.ts";
import { cliPath } from "../../core/paths.ts";

/**
 * What `init` writes for Claude Code: a permission rule so the modelbus tools never
 * prompt, a SessionStart hook that attaches the session, and the MCP server entry.
 */

const ALLOW_RULE = "mcp__modelbus__*";

interface Hook {
  hooks: Array<{ type: string; command?: string }>;
}

interface Settings {
  permissions?: { allow?: string[] };
  hooks?: Record<string, Hook[]>;
}

export function configure(): ConfigurePlan {
  const bun = process.execPath;
  const cli = cliPath();
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const hookCommand = `"${bun}" "${cli}" attach`;
  const mcpAdd = ["claude", "mcp", "add", "-s", "user", "modelbus", "--", bun, cli, "mcp"];
  return {
    describe: [
      `Claude Code (${settingsPath}): allow ${ALLOW_RULE}; SessionStart hook ${hookCommand}`,
      `Claude Code: ${mcpAdd.join(" ")}`,
    ],
    apply: async () => {
      const done: string[] = [];
      const settings: Settings = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, "utf8"))
        : {};
      const allow = settings.permissions?.allow ?? [];
      if (!allow.includes(ALLOW_RULE)) {
        allow.push(ALLOW_RULE);
        done.push(`added permission allow ${ALLOW_RULE}`);
      }
      settings.permissions = { ...settings.permissions, allow };
      // Replace any earlier modelbus hook (older command shapes) with the current one.
      const isOurs = (h: { command?: string }) => h.command?.includes(cli) ?? false;
      const kept = (settings.hooks?.SessionStart ?? []).filter((g) => !g.hooks.some(isOurs));
      kept.push({ hooks: [{ type: "command", command: hookCommand }] });
      if (kept.length !== settings.hooks?.SessionStart?.length) done.push("set SessionStart hook");
      settings.hooks = { ...settings.hooks, SessionStart: kept };
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
