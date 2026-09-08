import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigurePlan, HostAdapter, Observation } from "../core/adapter.ts";
import { cliPath } from "../ensure.ts";
import { aside as asideDetect } from "../providers/aside.ts";

/**
 * Aside adapter.
 *
 * v0 identity is one agent per Aside *account*, not per browser session: Aside's
 * daemon spawns MCP servers itself, so a shim cannot tell which session called it.
 * `init` writes the modelbus shim into each account's settings with MODELBUS_* env
 * naming the account, so the shim binds as that account. Delivery is pull: a
 * heartbeat routine (created inside Aside) calls the shim's `sync` tool.
 *
 * The settings shape is Aside's own (observed): settings.mcp.servers.<name> =
 * { enabled, transport: "stdio", command, args, env }.
 */

interface AsideHandle {
  account: number;
}

const usersDir = () => join(homedir(), ".aside", "u");

function accountDirs(): number[] {
  if (!existsSync(usersDir())) return [];
  return readdirSync(usersDir())
    .filter((d) => /^\d+$/.test(d) && existsSync(join(usersDir(), d, "settings.json")))
    .map(Number);
}

function accountHasShim(account: number): boolean {
  try {
    const s = JSON.parse(readFileSync(join(usersDir(), String(account), "settings.json"), "utf8"));
    return Boolean(s?.mcp?.servers?.modelbus?.enabled ?? s?.mcp?.servers?.modelbus);
  } catch {
    return false;
  }
}

export class AsideAdapter implements HostAdapter {
  readonly host = "aside" as const;

  async observe(): Promise<Observation[]> {
    const sessions = await asideDetect.detect();
    if (!sessions.length) return []; // daemon not running
    const byAccount = new Map<number, typeof sessions>();
    for (const s of sessions) {
      const acct = typeof s.extra?.account === "number" ? s.extra.account : -1;
      if (acct < 0) continue;
      byAccount.set(acct, [...(byAccount.get(acct) ?? []), s]);
    }
    const out: Observation[] = [];
    for (const account of accountDirs()) {
      const mine = byAccount.get(account) ?? [];
      const configured = accountHasShim(account);
      const handle: AsideHandle = { account };
      out.push({
        handle,
        key: `account:${account}`,
        name: account === 0 ? "aside" : `aside-${account}`,
        durability: "permanent",
        relationship: "top-level",
        evidence: `aside account dir u/${account} (${mine.length} sessions)`,
        reachable: configured,
        note: configured
          ? "pull: delivered when an Aside routine calls sync"
          : "run init to add the modelbus shim to this account's settings",
        pid: sessions[0]?.pid,
        title: mine[0]?.name,
        status: mine.some((s) => s.status === "running") ? "running" : "idle",
      });
    }
    return out;
  }

  handleFromKey(key: string): AsideHandle {
    return { account: Number(key.replace(/^account:/, "")) };
  }

  /** Pull-only: nothing to push. The message waits for the routine's next sync. */
  async deliver(): Promise<string> {
    return "waiting-for-pull";
  }

  configure(): ConfigurePlan {
    const bun = process.execPath;
    const cli = cliPath();
    const targets = accountDirs();
    const entryFor = (account: number) => ({
      enabled: true,
      transport: "stdio",
      command: bun,
      args: [cli, "mcp", "--with-sync"],
      env: {
        MODELBUS_HOST: "aside",
        MODELBUS_KEY: `account:${account}`,
        MODELBUS_NAME: account === 0 ? "aside" : `aside-${account}`,
      },
    });
    return {
      describe: targets.map(
        (a) =>
          `Aside (~/.aside/u/${a}/settings.json): merge mcp.servers.modelbus = ${JSON.stringify(entryFor(a))}`,
      ),
      apply: async () => {
        const done: string[] = [];
        for (const a of targets) {
          const path = join(usersDir(), String(a), "settings.json");
          const s = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
          const mcp = (s.mcp ??= {}) as { servers?: Record<string, unknown> };
          mcp.servers ??= {};
          mcp.servers.modelbus = entryFor(a);
          writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
          done.push(`aside u/${a}: wrote mcp.servers.modelbus`);
        }
        return done;
      },
    };
  }
}
