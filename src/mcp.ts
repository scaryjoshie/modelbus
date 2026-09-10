import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "./client.ts";
import { GUARDS } from "./core/guards.ts";
import { ensureDaemon } from "./ensure.ts";
import { whoAmI } from "./identity.ts";
import { renderItem } from "./render.ts";

/**
 * The stdio shim: an MCP server a host spawns per session. It asks the providers who
 * it is (identity.ts), then forwards `send` and `who` to the daemon. `sync` is only
 * registered with --with-sync, for hosts that cannot receive automatically.
 * Nothing host-specific lives here.
 */

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});

export async function runMcpShim(opts: { withSync: boolean }): Promise<void> {
  await ensureDaemon();
  const { identity, label, attach } = await whoAmI();
  const client = createClient(identity);
  const me = (await client.request("bind", {})).agent.name;
  // Hand the daemon whatever our provider says it needs to reach this session.
  if (attach) await client.request("attach", attach).catch(() => undefined);

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
        wait: z
          .number()
          .int()
          .min(0)
          .max(GUARDS.MAX_WAIT_SECONDS)
          .optional()
          .describe("seconds to wait for a reply"),
      },
    },
    async ({ to, body, wait }) => {
      try {
        const r = await client.request("send", { to, body, wait });
        const d = r.delivery;
        let out = `sent to ${r.to.name}${d.status === "failed" ? ` (not delivered: ${d.detail})` : ""}`;
        if (wait) out += `\n${r.reply ? renderItem(r.reply) : `no reply in ${wait}s`}`;
        return text(out);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
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
      const r = await client.request("who", { filter });
      const lines = r.agents
        .filter((a) => a.name !== me && (filter || a.reachable))
        .map((a) => [a.name, a.host, a.cwd ?? ""].filter(Boolean).join("  "));
      return text(lines.length ? lines.join("\n") : "nobody else is on the bus");
    },
  );

  if (opts.withSync) {
    server.registerTool(
      "sync",
      {
        description: "Read messages sent to you that have not been delivered yet.",
        inputSchema: {
          scope: z.string().optional(),
          wait: z.number().int().min(0).max(GUARDS.MAX_WAIT_SECONDS).optional(),
        },
      },
      async ({ scope, wait }) => {
        const r = await client.request("pull", { scope, wait });
        const lines = r.items.map(renderItem);
        if (r.more) lines.push(`[${r.more} more; call sync again]`);
        if (r.moreElsewhere) lines.push(`[${r.moreElsewhere} unread in other DMs]`);
        return text(lines.length ? lines.join("\n") : "nothing");
      },
    );
  }

  process.stderr.write(`modelbus mcp: bound as ${label}\n`);
  await server.connect(new StdioServerTransport());
}
