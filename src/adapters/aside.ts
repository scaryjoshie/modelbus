import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigurePlan, HostAdapter, Observation } from "../core/adapter.ts";
import { cliPath } from "../ensure.ts";
import { aside as asideDetect } from "../providers/aside.ts";
import { watchTranscript } from "../providers/watch.ts";

/**
 * Aside adapter.
 *
 * Identity: Aside's session record id (stored by its daemon indefinitely), plus the
 * account it belongs to. Sealed in the handle.
 *
 * Delivery: Aside's CLI, `aside --account u<N> session queue <id> "<text>"`, which
 * queues the text into the existing session like `codex queue` does for Codex
 * (verified 2026-09-08: the text appears as a user message and a turn runs).
 * `steer` is the louder upgrade, not used in v0.
 *
 * Receipt: the session's `messages.jsonl` under ~/.aside/u/<N>/sessions/<date>_<id>/
 * records the queued text as a `user` entry containing our marker.
 *
 * Outbound: Aside spawns the MCP shim itself (one per account), so a message an
 * Aside session sends is attributed to the account, not the session. `init` writes
 * the shim into each account's settings with MODELBUS_* env naming that account.
 */

interface AsideHandle {
  sessionId: string;
  account: number;
}

const usersDir = () => join(homedir(), ".aside", "u");
const asideCli = () => join(homedir(), ".local", "bin", "aside");

function accountDirs(): number[] {
  if (!existsSync(usersDir())) return [];
  return readdirSync(usersDir())
    .filter((d) => /^\d+$/.test(d) && existsSync(join(usersDir(), d, "settings.json")))
    .map(Number);
}

function transcriptPath(account: number, sessionId: string): string | undefined {
  const dir = join(usersDir(), String(account), "sessions");
  if (!existsSync(dir)) return undefined;
  const match = readdirSync(dir).find((d) => d.endsWith(`_${sessionId}`));
  return match ? join(dir, match, "messages.jsonl") : undefined;
}

export class AsideAdapter implements HostAdapter {
  readonly host = "aside" as const;

  async observe(): Promise<Observation[]> {
    const sessions = await asideDetect.detect();
    if (!sessions.length) return []; // daemon not running
    const cli = existsSync(asideCli());
    const recent = Date.now() - 7 * 24 * 3600 * 1000;
    const out: Observation[] = [];
    for (const s of sessions) {
      if (!s.sessionId) continue;
      const account = typeof s.extra?.account === "number" ? s.extra.account : -1;
      if (account < 0) continue;
      const last = Date.parse(String(s.extra?.lastActive ?? ""));
      if (!Number.isNaN(last) && last < recent) continue;
      const subagent = Boolean(s.extra?.subagent);
      const handle: AsideHandle = { sessionId: s.sessionId, account };
      out.push({
        handle,
        key: s.sessionId,
        name: s.name,
        durability: "permanent",
        relationship: subagent ? "subagent" : "top-level",
        parentKey: typeof s.extra?.parentId === "string" ? s.extra.parentId : undefined,
        evidence: `aside u/${account} state.db sessions row`,
        reachable: cli,
        note: cli ? undefined : "Aside CLI not installed (~/.local/bin/aside)",
        pid: s.pid,
        status: s.status,
        title: s.name,
        startedAt: s.startedAt,
      });
    }
    return out;
  }

  handleFromKey(key: string): AsideHandle {
    // Only used when a session identifies itself; Aside sessions don't, so the
    // account is unknown here and delivery resolves it from the session id.
    return { sessionId: key, account: -1 };
  }

  async deliver(
    handle: unknown,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<string> {
    const h = handle as AsideHandle;
    const account = h.account >= 0 ? h.account : this.accountOf(h.sessionId);
    if (account === undefined) return "error: account for session not found";
    if (!existsSync(asideCli())) return "error: aside cli not installed";
    const proc = Bun.spawn(
      [asideCli(), "--account", `u${account}`, "session", "queue", h.sessionId, text],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return `error: aside session queue exit ${code}${err ? `: ${err.split("\n")[0]}` : ""}`;
    }
    const path = transcriptPath(account, h.sessionId);
    if (path) watchTranscript({ path, marker, accept: isAsideUserMessage, onFound: onReceipt });
    return "queued";
  }

  private accountOf(sessionId: string): number | undefined {
    for (const a of accountDirs()) if (transcriptPath(a, sessionId)) return a;
    return undefined;
  }

  configure(): ConfigurePlan {
    const bun = process.execPath;
    const cli = cliPath();
    const targets = accountDirs();
    const entryFor = (account: number) => ({
      enabled: true,
      transport: "stdio",
      command: bun,
      args: [cli, "mcp"],
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

export function isAsideUserMessage(line: string): boolean {
  try {
    const d = JSON.parse(line) as { role?: string };
    return d.role === "user";
  } catch {
    return false;
  }
}
