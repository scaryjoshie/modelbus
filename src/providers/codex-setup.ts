import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Pre-approve the modelbus tools so no session ever sees Codex's first-use prompt.
 * This is exactly what "Always allow" writes: mcp_servers.<server>.tools.<tool>
 * .approval_mode = "approve" (codex-rs/core/src/mcp_tool_call.rs).
 */
export const CODEX_TOOLS = ["send", "who", "sync"] as const;

export function codexApprovalBlock(): string {
  return CODEX_TOOLS.map(
    (t) => `[mcp_servers.modelbus.tools.${t}]\napproval_mode = "approve"\n`,
  ).join("\n");
}

export async function codexInitWrite(plan: CodexInitPlan): Promise<string[]> {
  const done: string[] = [];
  if (plan.present) done.push("codex: modelbus MCP server already configured");
  else {
    const [cmd, ...args] = plan.mcpCommand;
    const r = await $`${cmd} ${args}`.quiet().nothrow();
    done.push(
      `codex mcp add: exit ${r.exitCode} ${r.stderr.toString().trim() || r.stdout.toString().trim()}`,
    );
  }
  const toml = existsSync(plan.configPath) ? readFileSync(plan.configPath, "utf8") : "";
  const missing = CODEX_TOOLS.filter((t) => !toml.includes(`[mcp_servers.modelbus.tools.${t}]`));
  if (missing.length) {
    const block = missing
      .map((t) => `\n[mcp_servers.modelbus.tools.${t}]\napproval_mode = "approve"\n`)
      .join("");
    writeFileSync(plan.configPath, `${toml.replace(/\s*$/, "\n")}${block}`);
    done.push(`codex: pre-approved modelbus tools ${missing.join(", ")}`);
  } else done.push("codex: modelbus tools already pre-approved");
  return done;
}
