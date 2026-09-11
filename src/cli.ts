#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { type Identity, rpc } from "./client.ts";
import { ensureHome } from "./core/paths.ts";
import { parseToken, whoAmI } from "./identity.ts";
import { allProviders } from "./providers/index.ts";
import { renderItem } from "./render.ts";

/**
 * modelbus CLI: a thin client of the daemon. Bus verbs live here; host-specific
 * setup plans are contributed by providers through `configure()`. Nothing here
 * starts the daemon on its own: `start` is the user's explicit act.
 */

const age = (ms?: number | null) => {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const shortCwd = (cwd?: string) => {
  const home = process.env.HOME ?? "";
  return cwd && home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : (cwd ?? "");
};

function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

async function identityFor(values: { as?: string; token?: string }): Promise<Identity> {
  if (values.token) return parseToken(values.token);
  if (values.as) console.error(`(test identity: acting as "${values.as}")`);
  return (await whoAmI({ as: values.as })).identity;
}

interface Command {
  usage: string;
  run(args: string[]): Promise<void>;
}

const commands: Record<string, Command> = {
  start: {
    usage:
      "start                                  install the daemon as a login service and start it",
    async run() {
      const { start } = await import("./service.ts");
      for (const line of await start()) console.log(line);
    },
  },
  stop: {
    usage: "stop                                   stop the daemon and remove the login service",
    async run() {
      const { stop } = await import("./service.ts");
      for (const line of await stop()) console.log(line);
    },
  },
  restart: {
    usage:
      "restart                                restart the service's daemon (after a code change)",
    async run() {
      const { restart } = await import("./service.ts");
      for (const line of await restart()) console.log(line);
    },
  },
  serve: {
    usage: "serve                                  run the daemon in the foreground instead",
    async run() {
      const { createDaemon } = await import("./daemon.ts");
      ensureHome();
      const d = createDaemon();
      console.log(`modelbus daemon pid ${process.pid} on ${d.unix}`);
      const stop = () => {
        d.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  },
  send: {
    usage: "send [--as A|--token T] --to B|#group [--wait N] <text>   send to an agent or a group",
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        options: {
          as: { type: "string" },
          token: { type: "string" },
          to: { type: "string" },
          wait: { type: "string" },
        },
        allowPositionals: true,
      });
      const body = positionals.join(" ");
      if (!values.to || !body) throw new Error("usage: modelbus send --to <name> <text>");
      const r = await rpc(
        "send",
        { to: values.to, body, wait: values.wait ? Number(values.wait) : undefined },
        await identityFor(values),
      );
      for (const d of r.deliveries) {
        console.log(`sent to ${d.to.name} (${d.status}${d.detail ? `: ${d.detail}` : ""})`);
      }
      if (values.wait) console.log(r.reply ? renderItem(r.reply) : `no reply in ${values.wait}s`);
    },
  },
  sync: {
    usage: "sync [--as A|--token T] [--scope B|#group] [--wait N]   read my inbox",
    async run(args) {
      const { values } = parseArgs({
        args,
        options: {
          as: { type: "string" },
          token: { type: "string" },
          scope: { type: "string" },
          wait: { type: "string" },
        },
      });
      const r = await rpc(
        "pull",
        { scope: values.scope, wait: values.wait ? Number(values.wait) : undefined },
        await identityFor(values),
      );
      console.log(r.items.length ? r.items.map(renderItem).join("\n") : "nothing");
      if (r.more) console.log(`[${r.more} more; call sync again]`);
      if (r.moreElsewhere) console.log(`[${r.moreElsewhere} unread in other DMs]`);
    },
  },
  who: {
    usage: "who [filter] [--fresh] [--group #g] [--as A|--token T]   agents on the bus",
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        options: {
          fresh: { type: "boolean" },
          group: { type: "string" },
          as: { type: "string" },
          token: { type: "string" },
        },
        allowPositionals: true,
      });
      // Without an identity the roster is everyone; with one, that caller's groupmates.
      const identity = values.as || values.token ? await identityFor(values) : undefined;
      const r = await rpc(
        "who",
        { filter: positionals[0], fresh: values.fresh, group: values.group },
        identity,
      );
      if (!r.agents.length) return console.log("nobody");
      console.log(
        table(
          ["name", "host", "delivery", "status", "cwd", "last-seen"],
          r.agents.map((a) => [
            a.name,
            a.host,
            a.reachable ? (a.note ?? "reachable") : `no (${a.note ?? "?"})`,
            a.status ?? "",
            shortCwd(a.cwd),
            age(a.lastSeen),
          ]),
        ),
      );
    },
  },
  log: {
    usage: "log [--conversation A,B|#group]        messages with delivery state",
    async run(args) {
      const { values } = parseArgs({ args, options: { conversation: { type: "string" } } });
      const r = await rpc("log", { conversation: values.conversation });
      console.log(
        table(
          ["seq", "id", "from", "to", "status", "detail", "body"],
          r.rows.map((x) => [
            String(x.seq),
            x.id,
            x.fromName,
            x.toName,
            x.status,
            x.detail ?? "",
            x.body.split("\n")[0]?.slice(0, 60) ?? "",
          ]),
        ),
      );
    },
  },
  group: {
    usage: "group #name [--add A,B] [--remove C]     create a group or change its members",
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        options: { add: { type: "string" }, remove: { type: "string" } },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) throw new Error("usage: modelbus group #name [--add A,B] [--remove C]");
      const split = (s?: string) =>
        s
          ?.split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      const r = await rpc("group", { name, add: split(values.add), remove: split(values.remove) });
      console.log(
        `#${r.conversation.name}: ${r.members.map((m) => m.name).join(", ") || "(empty)"}`,
      );
    },
  },
  rename: {
    usage: "rename <agent> <name>                  pin a new name; the old one stays an alias",
    async run(args) {
      const [agent, ...rest] = args;
      const name = rest.join(" ");
      if (!agent || !name) throw new Error("usage: modelbus rename <agent> <name>");
      const r = await rpc("rename", { agent, name });
      console.log(`${r.agent.formerName ?? agent} is now ${r.agent.name}`);
    },
  },
  chats: {
    usage: "chats                                  every conversation, newest activity first",
    async run() {
      const r = await rpc("conversations", {});
      if (!r.conversations.length) return console.log("no conversations yet");
      console.log(
        table(
          ["chat", "members", "unread", "last"],
          r.conversations.map((c) => [
            c.kind === "group" ? `#${c.name}` : "dm",
            c.participants.map((p) => p.name).join(", "),
            String(c.unread),
            c.last ? `${c.last.fromName}: ${c.last.body.split("\n")[0]?.slice(0, 50) ?? ""}` : "",
          ]),
        ),
      );
    },
  },
  history: {
    usage: "history <#group|A,B> [--limit N] [--before SEQ]   read a conversation, newest last",
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        options: { limit: { type: "string" }, before: { type: "string" } },
        allowPositionals: true,
      });
      const conversation = positionals[0];
      if (!conversation) throw new Error("usage: modelbus history <#group|A,B>");
      const r = await rpc("history", {
        conversation,
        limit: values.limit ? Number(values.limit) : undefined,
        before: values.before ? Number(values.before) : undefined,
      });
      console.log(r.items.length ? r.items.map(renderItem).join("\n") : "nothing");
    },
  },
  register: {
    usage: "register --name N                      join as any process; prints a token",
    async run(args) {
      const { values } = parseArgs({ args, options: { name: { type: "string" } } });
      if (!values.name) throw new Error("usage: modelbus register --name <name>");
      const r = await rpc("register", { name: values.name });
      console.error(`registered as "${r.agent.name}"; use --token or MODELBUS_TOKEN`);
      console.log(r.token);
    },
  },
  attach: {
    usage:
      "attach                                 bind the host session this runs inside; hand over its door",
    async run() {
      const me = await whoAmI();
      const r = me.attach
        ? await rpc("attach", me.attach, me.identity)
        : { agent: (await rpc("bind", {}, me.identity)).agent, attached: false };
      // As a SessionStart hook, stdout is added to the session's context.
      console.log(`modelbus: this session is registered as "${r.agent.name}".`);
    },
  },
  mcp: {
    usage: "mcp [--with-sync]                      stdio MCP shim (spawned by hosts)",
    async run(args) {
      const { runMcpShim } = await import("./mcp.ts");
      await runMcpShim({ withSync: args.includes("--with-sync") });
    },
  },
  web: {
    usage:
      "web [--port N]                         serve the MCP door for web chats on localhost (default 8787)",
    async run(args) {
      const { values } = parseArgs({ args, options: { port: { type: "string" } } });
      const { serveWeb } = await import("./web.ts");
      const w = serveWeb({ port: values.port ? Number(values.port) : 8787 });
      console.log(`modelbus web on ${w.url}; expose it with a tunnel to reach it from the web`);
    },
  },
  tui: {
    usage: "tui                                    live view of agents and messages",
    async run() {
      const { runTui } = await import("./tui/index.ts");
      await runTui();
    },
  },
  init: {
    usage: "init [--write]                         show/apply host configuration",
    async run(args) {
      const plans = allProviders()
        .map((a) => a.configure?.())
        .filter((p) => p !== undefined);
      for (const p of plans) for (const line of p.describe) console.log(line);
      if (!args.includes("--write")) return console.log("\ndry run; pass --write to apply");
      for (const p of plans) for (const line of await p.apply()) console.log(`  ${line}`);
    },
  },
};

const [name = "help", ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.error(
    ["usage: modelbus <command>", ...Object.values(commands).map((c) => `  ${c.usage}`)].join("\n"),
  );
  process.exit(name === "help" ? 0 : 1);
}
cmd.run(args).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
