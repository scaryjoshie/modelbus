import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createClient, type Identity, rpc } from "./client.ts";
import { parseToken } from "./identity.ts";
import { renderItem } from "./render.ts";

/**
 * The web door: one MCP server over HTTP for chats that live on the web. Nothing
 * observes a web chat and nothing can push into one, so a chat joins by name and
 * receives by asking. The chat repeats only its non-secret id; this process holds
 * the credentials. Auth for the endpoint itself belongs to whatever exposes it.
 */

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});

/** Credentials of every chat that joined through this process, by agent id. Memory only. */
const joined = new Map<string, Identity>();

function requireJoined(as: string): Identity {
  const identity = joined.get(as);
  if (!identity) throw new Error(`unknown id "${as}"; call join first`);
  return identity;
}

/** A fresh MCP server per request: the transport is stateless, the state is `joined`. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "modelbus", version: "0.0.0" },
    { instructions: "modelbus is a message bus between the agents on one machine." },
  );
  server.registerTool(
    "join",
    {
      description:
        "Join the bus as a named agent, saying in one line what you are for. Call once per conversation and keep the returned id; pass it as `as` on every other call.",
      inputSchema: {
        name: z.string().min(1),
        purpose: z.string().max(200).optional().describe("what you are for, one line"),
      },
    },
    async ({ name, purpose }) => {
      try {
        const r = await rpc("register", { name, purpose });
        joined.set(r.agent.id, parseToken(r.token));
        return text(`joined as "${r.agent.name}"; your id is ${r.agent.id}`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );
  server.registerTool(
    "who",
    { description: "List the agents on the bus.", inputSchema: { filter: z.string().optional() } },
    async ({ filter }) => {
      try {
        const r = await rpc("who", { filter });
        const lines = r.agents.map((a) => [a.name, a.host, a.cwd ?? ""].filter(Boolean).join("  "));
        return text(lines.length ? lines.join("\n") : "nobody is on the bus");
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
        as: z.string().describe("your id from join"),
        to: z.string().describe("agent name as shown by who, or #group"),
        body: z.string(),
        wait: z.number().int().min(0).optional().describe("seconds to wait for a reply"),
      },
    },
    async ({ as, to, body, wait }) => {
      try {
        const r = await createClient(requireJoined(as)).request("send", { to, body, wait });
        let out = r.deliveries
          .map((d) => `sent to ${d.to.name} (${d.status}${d.detail ? `: ${d.detail}` : ""})`)
          .join("\n");
        if (wait) out += `\n${r.reply ? renderItem(r.reply) : `no reply in ${wait}s`}`;
        return text(out);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );
  server.registerTool(
    "status",
    {
      description:
        "Say what you are doing, in a few words, for the people watching the bus. Empty clears it.",
      inputSchema: { as: z.string().describe("your id from join"), text: z.string().max(200) },
    },
    async ({ as, text: t }) => {
      try {
        await createClient(requireJoined(as)).request("status", { text: t });
        return text(t.trim() ? `status: ${t.trim()}` : "status cleared");
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );
  server.registerTool(
    "sync",
    {
      description:
        "Read messages sent to you. Nothing is pushed to a web chat; this is how you receive.",
      inputSchema: {
        as: z.string().describe("your id from join"),
        scope: z.string().optional().describe("only the DM with this agent"),
        wait: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("seconds to wait for something to arrive"),
      },
    },
    async ({ as, scope, wait }) => {
      try {
        const r = await createClient(requireJoined(as)).request("pull", { scope, wait });
        const lines = r.items.map(renderItem);
        if (r.more) lines.push(`[${r.more} more; call sync again]`);
        if (r.moreElsewhere) lines.push(`[${r.moreElsewhere} unread in other DMs]`);
        return text(lines.length ? lines.join("\n") : "nothing");
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );
  return server;
}

/** Handle one HTTP request to the MCP endpoint. */
export async function handleMcp(req: Request): Promise<Response> {
  // Stateless, and plain JSON replies rather than a stream: a tool call is one
  // request and one answer, even when the answer waits on a reply.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: every request is its own server and transport.
    void server.close();
  }
}

/** Serve the endpoint on localhost; a tunnel is what makes it reachable from the web. */
export function serveWeb(opts: { port: number; hostname?: string }) {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/mcp")
        return new Response("modelbus web: POST /mcp", { status: 404 });
      return handleMcp(req);
    },
  });
  return { url: `http://${server.hostname}:${server.port}/mcp`, stop: () => server.stop(true) };
}
