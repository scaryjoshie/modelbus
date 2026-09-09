#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { allAdapters } from "./adapters/index.ts";
import { type Identity, rpc } from "./client.ts";
import { ensureDaemon } from "./ensure.ts";
import { whoAmI } from "./identity.ts";
import { renderItem } from "./render.ts";

/**
 * modelbus CLI: a thin client of the daemon. Bus verbs live here; host-specific
 * verbs (hooks, helpers) are contributed by adapters through `commands()`.
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
  if (values.token) return { kind: "token", token: values.token };
  if (values.as) console.error(`(test identity: acting as "${values.as}")`);
  return (await whoAmI({ as: values.as })).identity;
}

interface Command {
  usage: string;
  /** Runs without the daemon (the CLI starts it for every other command). */
  standalone?: boolean;
  run(args: string[]): Promise<void>;
}

const commands: Record<string, Command> = {
  serve: {
    standalone: true,
    usage: "serve                                  run the daemon in the foreground",
    async run() {
      const { createDaemon } = await import("./daemon.ts");
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
    usage: "send [--as A|--token T] --to B [--wait N] <text>   send a DM",
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
      const d = r.delivery;
      console.log(`sent to ${r.to.name} (${d.status}${d.detail ? `: ${d.detail}` : ""})`);
      if (values.wait) console.log(r.reply ? renderItem(r.reply) : `no reply in ${values.wait}s`);
    },
  },
  sync: {
    usage: "sync [--as A|--token T] [--scope B] [--wait N]    read my inbox",
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
    usage: "who [filter] [--fresh]                 agents on the bus",
    async run(args) {
      const filter = args.find((x) => !x.startsWith("--"));
      const r = await rpc("who", {
        filter,
        fresh: args.includes("--fresh"),
      });
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
    usage: "log [--conversation A,B]               messages with delivery state",
    async run(args) {
      const { values } = parseArgs({ args, options: { conversation: { type: "string" } } });
      const [a, b] = (values.conversation ?? "").split(",").filter(Boolean);
      const r = await rpc("log", { a, b });
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
    standalone: true,
    usage: "mcp [--with-sync]                      stdio MCP shim (spawned by hosts)",
    async run(args) {
      const { runMcpShim } = await import("./mcp.ts");
      await runMcpShim({ withSync: args.includes("--with-sync") });
    },
  },
  init: {
    standalone: true,
    usage: "init [--write]                         show/apply host configuration",
    async run(args) {
      const plans = allAdapters()
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
(cmd.standalone ? cmd.run(args) : ensureDaemon().then(() => cmd.run(args))).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
