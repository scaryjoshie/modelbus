#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { type Identity, rpc } from "./client.ts";
import type { Agent, InboxItem } from "./core/store.ts";

/**
 * modelbus CLI. Test surface for the POC; see docs/poc-spec.md section 10.
 *   serve | send | sync | who | log | register | hook | attach | mcp | init
 * `--as <name>` is a TEST-ONLY identity override (spec section 6).
 */

function age(ms?: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

/** One inbox item as the model sees it: `name: body`, continuation lines indented. */
export function renderItem(i: InboxItem): string {
  const [first = "", ...rest] = i.body.split("\n");
  return [`${i.from_name}: ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}

async function resolveCliIdentity(values: { as?: string; token?: string }): Promise<Identity> {
  if (values.token) return { kind: "token", token: values.token };
  if (values.as) console.error(`(test identity: acting as "${values.as}")`);
  const { whoAmI } = await import("./identity.ts");
  try {
    return (await whoAmI({ as: values.as })).identity;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

const [cmd = "help", ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "serve": {
      await import("./daemon.ts")
        .then((m) => m.createDaemon())
        .then((d) => {
          console.log(`modelbus daemon pid ${process.pid} on ${d.unix}`);
          const stop = () => {
            d.stop();
            process.exit(0);
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
      return;
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          as: { type: "string" },
          token: { type: "string" },
          to: { type: "string" },
          wait: { type: "string" },
        },
        allowPositionals: true,
      });
      const body = positionals.join(" ");
      if (!values.to || !body) {
        console.error("usage: modelbus send --as A --to B [--wait N] <text>");
        process.exit(2);
      }
      const r = await rpc<{ to: Agent; wakeResult: string; reply?: InboxItem }>(
        "send",
        { to: values.to, body, wait: values.wait ? Number(values.wait) : undefined },
        await resolveCliIdentity(values),
      );
      console.log(`sent to ${r.to.name} (wake: ${r.wakeResult})`);
      if (values.wait) console.log(r.reply ? renderItem(r.reply) : `no reply in ${values.wait}s`);
      return;
    }
    case "sync": {
      const { values } = parseArgs({
        args: rest,
        options: {
          as: { type: "string" },
          token: { type: "string" },
          scope: { type: "string" },
          wait: { type: "string" },
        },
      });
      const r = await rpc<{ items: InboxItem[]; more: number; moreElsewhere: number }>(
        "pull",
        { scope: values.scope, wait: values.wait ? Number(values.wait) : undefined },
        await resolveCliIdentity(values),
      );
      if (!r.items.length) console.log("nothing");
      else console.log(r.items.map(renderItem).join("\n"));
      if (r.more) console.log(`[${r.more} more; call sync again]`);
      if (r.moreElsewhere) console.log(`[${r.moreElsewhere} unread in other DMs]`);
      return;
    }
    case "who": {
      const filter = rest.find((x) => !x.startsWith("--"));
      const r = await rpc<{
        agents: Array<{
          name: string;
          host: string;
          attestation?: string;
          status?: string;
          cwd?: string;
          reachable: boolean;
          note?: string;
          lastSeen: number;
        }>;
      }>("who", { filter, fresh: rest.includes("--fresh") });
      if (!r.agents.length) return console.log("nobody");
      console.log(
        table(
          r.agents.map((a) => [
            a.name,
            a.host,
            a.reachable ? "reachable" : `no (${a.note ?? "?"})`,
            a.attestation ?? "",
            a.status ?? "",
            shortCwd(a.cwd),
            age(a.lastSeen),
          ]),
          ["name", "host", "delivery", "identity", "status", "cwd", "last-seen"],
        ),
      );
      return;
    }
    case "log": {
      const { values } = parseArgs({ args: rest, options: { conversation: { type: "string" } } });
      const [a, b] = (values.conversation ?? "").split(",").filter(Boolean);
      const r = await rpc<{ rows: Array<Record<string, unknown>> }>("log", { a, b });
      console.log(
        table(
          r.rows.map((x) => [
            String(x.seq),
            String(x.id),
            String(x.from_name),
            String(x.to_name),
            String(x.wake_result ?? ""),
            x.received_at ? "received" : "unreceived",
            String(x.body).split("\n")[0]?.slice(0, 60) ?? "",
          ]),
          ["seq", "id", "from", "to", "wake", "receipt", "body"],
        ),
      );
      return;
    }
    case "register": {
      // Any process joins the bus by name. Prints the token that is its identity.
      const { values } = parseArgs({
        args: rest,
        options: {
          name: { type: "string" },
          host: { type: "string" },
          pid: { type: "string" },
          deliver: { type: "string" },
        },
      });
      if (!values.name) {
        console.error(
          "usage: modelbus register --name <name> [--host <label>] [--pid <n>] [--deliver <cmd>]",
        );
        process.exit(2);
      }
      await (await import("./ensure.ts")).ensureDaemon();
      const r = await rpc<{ agent: Agent; token: string }>("register", {
        name: values.name,
        host: values.host,
        pid: values.pid ? Number(values.pid) : undefined,
        deliver: values.deliver,
      });
      console.error(`registered as "${r.agent.name}"; use --token or MODELBUS_TOKEN for send/sync`);
      console.log(r.token);
      return;
    }
    case "hook": {
      // Claude Code SessionStart hook: stdin carries the hook JSON. Stdout is added
      // to the session's context, so print one useful line.
      const { hookSessionStart } = await import("./adapters/claude-code.ts");
      const stdin = await Bun.stdin.text();
      const name = await hookSessionStart(stdin);
      console.log(
        `modelbus: this session is registered as "${name}". Messages from other agents arrive here automatically; reply with the modelbus send tool.`,
      );
      return;
    }
    case "attach": {
      // Run inside a live Claude Code session (e.g. from its Bash tool) to register it
      // without the hook. Needs the session's environment.
      const { attachCurrentSession } = await import("./adapters/claude-code.ts");
      console.log(`attached as "${await attachCurrentSession()}"`);
      return;
    }
    case "post": {
      // Internal helper: {socketPath, token?, text} on stdin; write to the inbox
      // socket and exit immediately (see adapters/claude-code.ts).
      const { post } = await import("./adapters/claude-code.ts");
      const p = JSON.parse(await Bun.stdin.text()) as {
        socketPath: string;
        token?: string;
        text: string;
      };
      await post(p.socketPath, p.token, p.text);
      return;
    }
    case "mcp": {
      const { runMcpShim } = await import("./mcp.ts");
      await runMcpShim({ withSync: rest.includes("--with-sync") });
      return;
    }
    case "init": {
      const { allAdapters } = await import("./adapters/index.ts");
      const plans = allAdapters()
        .map((a) => a.configure?.())
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      for (const p of plans) for (const line of p.describe) console.log(line);
      if (!rest.includes("--write")) {
        console.log("\ndry run; pass --write to apply");
        return;
      }
      for (const p of plans) for (const line of await p.apply()) console.log(`  ${line}`);
      return;
    }
    default:
      console.error(
        [
          "usage: modelbus <command>",
          "  serve                                run the daemon",
          "  send [--as A] --to B [--wait N] <text> send a DM (as this session, or test identity)",
          "  sync [--as A] [--scope B] [--wait N]  read my inbox",
          "  who [filter] [--fresh]               agents on the bus (live sessions)",
          "  log [--conversation A,B]             messages with delivery state",
          "  register --name N [--deliver CMD]    join as any process; prints a token",
          "  attach                               register the Claude Code session this runs inside",
          "  hook claude-session-start            SessionStart hook entry (stdin JSON)",
          "  mcp [--with-sync]                    stdio MCP shim (spawned by hosts)",
          "  init [--write]                       show/apply Claude Code config",
        ].join("\n"),
      );
      process.exit(cmd === "help" ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
