#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { allAdapters } from "./adapters/index.ts";
import type { Identity } from "./client.ts";
import { rpc } from "./client.ts";
import type { Command, CommandContext } from "./core/adapter.ts";
import type { LogRow } from "./core/store.ts";
import { ensureDaemon } from "./ensure.ts";
import { whoAmI } from "./identity.ts";
import { renderItem } from "./render.ts";
import type { RosterEntry } from "./tracker.ts";

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

const commands: Record<string, Command> = {
  serve: {
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
    async run({ args }) {
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
      const r = await rpc<{
        to: { name: string };
        delivery: { outcome: string; detail?: string };
        reply?: Parameters<typeof renderItem>[0];
      }>(
        "send",
        { to: values.to, body, wait: values.wait ? Number(values.wait) : undefined },
        await identityFor(values),
      );
      const d = r.delivery.detail
        ? `${r.delivery.outcome}: ${r.delivery.detail}`
        : r.delivery.outcome;
      console.log(`sent to ${r.to.name} (${d})`);
      if (values.wait) console.log(r.reply ? renderItem(r.reply) : `no reply in ${values.wait}s`);
    },
  },
  sync: {
    usage: "sync [--as A|--token T] [--scope B] [--wait N]    read my inbox",
    async run({ args }) {
      const { values } = parseArgs({
        args,
        options: {
          as: { type: "string" },
          token: { type: "string" },
          scope: { type: "string" },
          wait: { type: "string" },
        },
      });
      const r = await rpc<{
        items: Parameters<typeof renderItem>[0][];
        more: number;
        moreElsewhere: number;
      }>(
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
    async run({ args }) {
      const filter = args.find((x) => !x.startsWith("--"));
      const r = await rpc<{ agents: RosterEntry[] }>("who", {
        filter,
        fresh: args.includes("--fresh"),
      });
      if (!r.agents.length) return console.log("nobody");
      console.log(
        table(
          ["name", "host", "delivery", "identity", "status", "cwd", "last-seen"],
          r.agents.map((a) => [
            a.name,
            a.host,
            a.reachable ? "reachable" : `no (${a.note ?? "?"})`,
            a.attestation ?? "",
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
    async run({ args }) {
      const { values } = parseArgs({ args, options: { conversation: { type: "string" } } });
      const [a, b] = (values.conversation ?? "").split(",").filter(Boolean);
      const r = await rpc<{ rows: LogRow[] }>("log", { a, b });
      console.log(
        table(
          ["seq", "id", "from", "to", "delivery", "receipt", "body"],
          r.rows.map((x) => [
            String(x.seq),
            x.id,
            x.fromName,
            x.toName,
            x.wakeResult ?? "",
            x.receivedAt ? "received" : "unreceived",
            x.body.split("\n")[0]?.slice(0, 60) ?? "",
          ]),
        ),
      );
    },
  },
  register: {
    usage:
      "register --name N [--host L] [--pid P] [--deliver CMD]   join as any process; prints a token",
    async run({ args }) {
      const { values } = parseArgs({
        args,
        options: {
          name: { type: "string" },
          host: { type: "string" },
          pid: { type: "string" },
          deliver: { type: "string" },
        },
      });
      if (!values.name) throw new Error("usage: modelbus register --name <name>");
      await ensureDaemon();
      const r = await rpc<{ agent: { name: string }; token: string }>("register", {
        name: values.name,
        host: values.host,
        pid: values.pid ? Number(values.pid) : undefined,
        deliver: values.deliver,
      });
      console.error(`registered as "${r.agent.name}"; use --token or MODELBUS_TOKEN`);
      console.log(r.token);
    },
  },
  mcp: {
    usage: "mcp [--with-sync]                      stdio MCP shim (spawned by hosts)",
    async run({ args }) {
      const { runMcpShim } = await import("./mcp.ts");
      await runMcpShim({ withSync: args.includes("--with-sync") });
    },
  },
  init: {
    usage: "init [--write]                         show/apply host configuration",
    async run({ args }) {
      const plans = allAdapters()
        .map((a) => a.configure?.())
        .filter((p) => p !== undefined);
      for (const p of plans) for (const line of p.describe) console.log(line);
      if (!args.includes("--write")) return console.log("\ndry run; pass --write to apply");
      for (const p of plans) for (const line of await p.apply()) console.log(`  ${line}`);
    },
  },
};

for (const adapter of allAdapters()) Object.assign(commands, adapter.commands?.() ?? {});

const [name = "help", ...args] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.error(
    ["usage: modelbus <command>", ...Object.values(commands).map((c) => `  ${c.usage}`)].join("\n"),
  );
  process.exit(name === "help" ? 0 : 1);
}
const ctx: CommandContext = {
  args,
  stdin: () => Bun.stdin.text(),
  rpc: (method, params, identity) => rpc(method, params, identity as Identity | undefined),
  ensureDaemon,
};
cmd.run(ctx).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
