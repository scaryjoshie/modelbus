import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliPath } from "../../core/paths.ts";
import type { ConfigurePlan } from "../../runtime/provider.ts";
import { accounts, usersDir } from "./state.ts";

/**
 * What `init` writes for Aside: the MCP server entry in each account's settings,
 * with the account named in the shim's environment, plus a cached tool inventory.
 * Aside only offers a server's tools once its settings hold that inventory; it does
 * not query a new server on its own. Aside reads settings at startup.
 */

const serverEntry = (account: number) => ({
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [cliPath(), "mcp"],
  env: {
    MODELBUS_PROVIDER: "aside",
    MODELBUS_KEY: `account:${account}`,
    MODELBUS_NAME: account === 0 ? "aside" : `aside-${account}`,
  },
});

/**
 * The tool inventory Aside caches: exactly what the shim serves, asked of a shim
 * started the way Aside would start it. A hand-copied list drifts; this cannot.
 */
async function inventory(account: number): Promise<{ tools: unknown[]; refreshedAt: string }> {
  const entry = serverEntry(account);
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...process.env, ...entry.env },
    stderr: "ignore",
  });
  const client = new Client({ name: "modelbus-init", version: "0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return { tools, refreshedAt: new Date().toISOString() };
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface Settings {
  mcp?: { servers?: Record<string, unknown>; inventories?: Record<string, unknown> };
}

export function configure(): ConfigurePlan {
  return {
    describe: accounts().map(
      (a) => `Aside (~/.aside/u/${a}/settings.json): mcp.servers.modelbus + tool inventory`,
    ),
    apply: async () => {
      const done: string[] = [];
      for (const a of accounts()) {
        const path = join(usersDir(), String(a), "settings.json");
        const s: Settings = JSON.parse(readFileSync(path, "utf8"));
        const mcp = s.mcp ?? {};
        s.mcp = {
          ...mcp,
          servers: { ...mcp.servers, modelbus: serverEntry(a) },
          inventories: { ...mcp.inventories, modelbus: await inventory(a) },
        };
        writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
        done.push(`aside u/${a}: wrote mcp.servers.modelbus + inventory`);
      }
      return done;
    },
  };
}
