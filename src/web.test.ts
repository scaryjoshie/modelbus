import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { socketPath } from "./core/paths.ts";
import { Store } from "./core/store.ts";
import { createDaemon } from "./daemon.ts";
import { serveWeb } from "./web.ts";

/** A web chat as the MCP SDK's client sees it. */
async function chat(url: string): Promise<Client> {
  const c = new Client({ name: "chat", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

const textOf = (r: unknown) =>
  (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

describe("web door", () => {
  let dir: string;
  let daemon: ReturnType<typeof createDaemon>;
  let web: ReturnType<typeof serveWeb>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-web-"));
    process.env.MODELBUS_HOME = dir; // the door's clients find the test daemon here
    daemon = createDaemon({
      store: new Store(join(dir, "d.db")),
      unix: socketPath(),
      providers: [],
      track: false,
    });
    web = serveWeb({ port: 0 });
  });
  afterEach(() => {
    web.stop();
    daemon.stop();
    delete process.env.MODELBUS_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  test("two chats join, find each other, exchange a message, and one receives by sync", async () => {
    const a = await chat(web.url);
    const b = await chat(web.url);
    const tools = (await a.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["register", "send", "status", "sync", "who"]);

    const joinA = textOf(
      await a.callTool({ name: "register", arguments: { name: "planner", purpose: "plans" } }),
    );
    const joinB = textOf(
      await b.callTool({ name: "register", arguments: { name: "reviewer", purpose: "reviews" } }),
    );
    const idA = joinA.match(/your id is (\S+)/)?.[1];
    const idB = joinB.match(/your id is (\S+)/)?.[1];
    if (!idA || !idB) throw new Error(`join did not return ids: ${joinA} / ${joinB}`);

    const who = textOf(await a.callTool({ name: "who", arguments: {} }));
    expect(who).toContain("planner");
    expect(who).toContain("reviewer");

    const sent = textOf(
      await a.callTool({
        name: "send",
        arguments: { as: idA, to: "reviewer", body: "look at #12" },
      }),
    );
    expect(sent).toBe("sent to reviewer (sent: waiting for it to sync)");

    const got = textOf(await b.callTool({ name: "sync", arguments: { as: idB } }));
    expect(got).toBe("planner: look at #12");
    expect(textOf(await b.callTool({ name: "sync", arguments: { as: idB } }))).toBe("nothing");

    const bad = await a.callTool({
      name: "send",
      arguments: { as: "nope", to: "reviewer", body: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("call register first");
  });
});
