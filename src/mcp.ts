import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rpc } from "./client.ts";
import type { Agent, InboxItem } from "./core/store.ts";
import { ensureDaemon } from "./ensure.ts";
import { whoAmI } from "./identity.ts";

/**
 * The stdio shim: an MCP server a host spawns per session. It asks the adapters who
 * it is (identity.ts), then forwards `send` and `who` to the daemon. `sync` is only
 * registered with --with-sync, for hosts that cannot receive automatically.
 * Nothing host-specific lives here.
 */

export function renderItem(i: InboxItem): string {
  const [first = "", ...rest] = i.body.split("\n");
  return [`${i.from_name}: ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}

export async function runMcpShim(opts: { withSync: boolean }): Promise<void> {
  await ensureDaemon();
  const { identity, label, attach } = await whoAmI();
  const bound = await rpc<{ agent: Agent }>("bind", {}, identity);
  const me = bound.agent.name;
  // Hand the daemon whatever our adapter says it needs to reach this session.
  if (attach) await rpc("attach", attach, identity).catch(() => undefined);

  const server = new McpServer(
    { name: "modelbus", version: "0.0.0" },
    {
      instructions: `You are "${me}" on modelbus, a message bus between the agents on this machine.`,
    },
  );

  server.registerTool(
    "send",
    {
      description: "Message another agent on this machine by name.",
      inputSchema: {
        to: z.string().describe("agent name, as shown by who"),
        body: z.string(),
        wait: z.number().int().min(0).max(600).optional().describe("seconds to wait for a reply"),
      },
    },
    async ({ to, body, wait }) => {
      try {
        const r = await rpc<{ to: Agent; wakeResult: string; reply?: InboxItem }>(
          "send",
          { to, body, wait },
          identity,
        );
        let text = `sent to ${r.to.name}`;
        if (r.wakeResult.startsWith("error") || r.wakeResult === "none")
          text += ` (delivery: ${r.wakeResult})`;
        if (wait) text += `\n${r.reply ? renderItem(r.reply) : `no reply in ${wait}s`}`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "who",
    {
      description: "List the agents on this machine.",
      inputSchema: { filter: z.string().optional() },
    },
    async ({ filter }) => {
      const r = await rpc<{
        agents: Array<{
          name: string;
          host: string;
          cwd?: string;
          reachable: boolean;
          note?: string;
        }>;
      }>("who", { filter });
      const lines = r.agents
        .filter((a) => a.name !== me && (filter || a.reachable))
        .map((a) => [a.name, a.host, a.cwd ?? ""].filter(Boolean).join("  "));
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "nobody else is on the bus" },
        ],
      };
    },
  );

  if (opts.withSync) {
    server.registerTool(
      "sync",
      {
        description: "Read messages sent to you that have not been delivered yet.",
        inputSchema: {
          scope: z.string().optional(),
          wait: z.number().int().min(0).max(600).optional(),
        },
      },
      async ({ scope, wait }) => {
        const r = await rpc<{ items: InboxItem[]; more: number; moreElsewhere: number }>(
          "pull",
          { scope, wait },
          identity,
        );
        const lines = r.items.map(renderItem);
        if (r.more) lines.push(`[${r.more} more; call sync again]`);
        if (r.moreElsewhere) lines.push(`[${r.moreElsewhere} unread in other DMs]`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "nothing" }] };
      },
    );
  }

  process.stderr.write(`modelbus mcp: bound as ${label}\n`);
  await server.connect(new StdioServerTransport());
}
