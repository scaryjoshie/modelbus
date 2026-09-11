import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, DaemonUnreachable } from "./client.ts";
import { whoAmI } from "./identity.ts";
import { renderItem } from "./render.ts";

/**
 * The stdio shim: an MCP server a host spawns per session. It asks the providers who
 * it is (identity.ts), then forwards `send` and `who` to the daemon. `sync` is only
 * registered with --with-sync, for hosts that cannot receive automatically.
 * Nothing host-specific lives here. The shim never starts the daemon: if it is not
 * running, every tool says so until it is, and the session binds on the first call
 * that gets through.
 */

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});

const NOT_REGISTERED =
  "not registered on modelbus; call register with one line on what you are working on";

export async function runMcpShim(opts: { withSync: boolean }): Promise<void> {
  const { identity, label, attach } = await whoAmI();
  const client = createClient(identity);
  let me: string | undefined;
  let attached = false;
  /** Hand the daemon whatever our provider says it needs to reach this session, registered or not. */
  const attachOnce = async () => {
    if (attached || !attach) return;
    await client.request("attach", attach);
    attached = true;
  };
  /** The name we are registered under, learned once; throws while unregistered. */
  const bound = async (): Promise<string> => {
    if (me) return me;
    await attachOnce().catch(() => undefined);
    me = (await client.request("bind", {})).agent.name;
    return me;
  };
  try {
    await bound();
  } catch (e) {
    if (e instanceof DaemonUnreachable) {
      process.stderr.write(`modelbus mcp: ${e.message}; tools will say so until it is\n`);
    }
    // Not registered yet: the instructions and the register tool handle that.
  }

  const server = new McpServer(
    { name: "modelbus", version: "0.0.0" },
    {
      instructions: me
        ? `You are "${me}" on modelbus, a message bus between the agents on this machine.`
        : `You are not yet registered on modelbus, the message bus between the agents on this machine. Call the register tool with one line saying what you are working on; write "unspecified until further notice" if you do not know yet.`,
    },
  );

  server.registerTool(
    "register",
    {
      description:
        "Register on the bus, stating in one line what you are working on. Returns your name, your groups, and any messages waiting for you.",
      inputSchema: { purpose: z.string().min(1).max(200) },
    },
    async ({ purpose }) => {
      try {
        await attachOnce().catch(() => undefined);
        const r = await client.request("register", { purpose });
        me = r.agent.name;
        const lines = [`registered as "${me}": ${r.agent.purpose ?? purpose}`];
        for (const g of r.briefing.groups) lines.push(`in #${g.name} with ${g.members.join(", ")}`);
        if (r.briefing.unread.length) {
          lines.push(`${r.briefing.unread.length} waiting:`, ...r.briefing.unread.map(renderItem));
        }
        return text(lines.join("\n"));
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  server.registerTool(
    "send",
    {
      description: "Message an agent by name, or a group as #name.",
      inputSchema: {
        to: z.string().describe("agent name as shown by who, or #group"),
        body: z.string(),
        wait: z.number().int().min(0).optional().describe("seconds to wait for a reply"),
      },
    },
    async ({ to, body, wait }) => {
      try {
        await bound();
        const r = await client.request("send", { to, body, wait });
        let out = r.deliveries
          .map(
            (d) =>
              `sent to ${d.to.name}${d.status === "failed" ? ` (not delivered: ${d.detail})` : ""}`,
          )
          .join("\n");
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
      description:
        "List the agents you share a group with, or everyone if you are in none. Each line: name, what it is for, provider.",
      inputSchema: { filter: z.string().optional() },
    },
    async ({ filter }) => {
      try {
        const self = await bound().catch(() => undefined);
        const r = await client.request("who", { filter });
        const lines = r.agents
          .filter((a) => a.name !== self && (filter || a.reachable))
          .map((a) => [a.name, a.purpose ?? "", a.provider].filter(Boolean).join("  "));
        return text(lines.length ? lines.join("\n") : "nobody else is on the bus");
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  if (opts.withSync) {
    server.registerTool(
      "sync",
      {
        description: "Read messages sent to you that have not been delivered yet.",
        inputSchema: {
          scope: z.string().optional(),
          wait: z.number().int().min(0).optional(),
        },
      },
      async ({ scope, wait }) => {
        try {
          await bound();
          const r = await client.request("pull", { scope, wait });
          const lines = r.items.map(renderItem);
          if (r.more) lines.push(`[${r.more} more; call sync again]`);
          if (r.moreElsewhere) lines.push(`[${r.moreElsewhere} unread in other DMs]`);
          return text(lines.length ? lines.join("\n") : "nothing");
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      },
    );
  }

  process.stderr.write(
    `modelbus mcp: ${me ? `registered as ${me}` : `${label}: ${NOT_REGISTERED}`}\n`,
  );
  await server.connect(new StdioServerTransport());
}
