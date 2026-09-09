import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { ConfigurePlan } from "../../core/adapter.ts";
import { cliPath } from "../../core/paths.ts";
import { codexHome } from "./threads.ts";

/** What `init` writes for Codex: the MCP server and per-tool pre-approval. */
export function configure(): ConfigurePlan {
  const configPath = join(codexHome(), "config.toml");
  const tools = ["send", "who", "sync"];
  const mcpAdd = ["codex", "mcp", "add", "modelbus", "--", process.execPath, cliPath(), "mcp"];
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const hasServer = /\[mcp_servers\.modelbus\]/.test(current);
  const missing = tools.filter((t) => !current.includes(`[mcp_servers.modelbus.tools.${t}]`));
  return {
    describe: [
      hasServer ? `Codex (${configPath}): server configured` : `Codex: ${mcpAdd.join(" ")}`,
      missing.length
        ? `Codex (${configPath}): pre-approve tools ${missing.join(", ")} (approval_mode = "approve")`
        : `Codex (${configPath}): tools pre-approved`,
    ],
    apply: async () => {
      const done: string[] = [];
      if (!hasServer) {
        const [cmd, ...args] = mcpAdd;
        const r = await $`${cmd} ${args}`.quiet().nothrow();
        done.push(`codex mcp add: exit ${r.exitCode}`);
      }
      if (missing.length) {
        appendFileSync(
          configPath,
          missing
            .map((t) => `\n[mcp_servers.modelbus.tools.${t}]\napproval_mode = "approve"\n`)
            .join(""),
        );
        done.push(`codex: pre-approved ${missing.join(", ")}`);
      }
      return done;
    },
  };
}
