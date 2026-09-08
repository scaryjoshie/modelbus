import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { cliPath } from "../ensure.ts";

/** What `init` does for Codex: register the stdio shim in ~/.codex/config.toml. */
export interface CodexInitPlan {
  configPath: string;
  mcpCommand: string[];
  present: boolean;
}

export function codexInitPlan(): CodexInitPlan {
  const configPath = join(homedir(), ".codex", "config.toml");
  const present =
    existsSync(configPath) && /\[mcp_servers\.modelbus\]/.test(readFileSync(configPath, "utf8"));
  return {
    configPath,
    mcpCommand: ["codex", "mcp", "add", "modelbus", "--", process.execPath, cliPath(), "mcp"],
    present,
  };
}

export async function codexInitWrite(plan: CodexInitPlan): Promise<string[]> {
  if (plan.present) return ["codex: modelbus MCP server already configured"];
  const [cmd, ...args] = plan.mcpCommand;
  const r = await $`${cmd} ${args}`.quiet().nothrow();
  return [
    `codex mcp add: exit ${r.exitCode} ${r.stderr.toString().trim() || r.stdout.toString().trim()}`,
  ];
}
