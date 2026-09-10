import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    MODELBUS_HOST: "aside",
    MODELBUS_KEY: `account:${account}`,
    MODELBUS_NAME: account === 0 ? "aside" : `aside-${account}`,
  },
});

const inventory = () => ({
  tools: [
    {
      name: "send",
      description: "Message another agent on this machine by name.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
          wait: { type: "number" },
        },
        required: ["to", "body"],
      },
    },
    {
      name: "who",
      description: "List the agents on this machine.",
      inputSchema: { type: "object", properties: { filter: { type: "string" } } },
    },
  ],
  refreshedAt: new Date().toISOString(),
});

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
          inventories: { ...mcp.inventories, modelbus: inventory() },
        };
        writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
        done.push(`aside u/${a}: wrote mcp.servers.modelbus + inventory`);
      }
      return done;
    },
  };
}
