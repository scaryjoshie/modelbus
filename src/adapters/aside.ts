import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigurePlan, HostAdapter, Observation } from "../core/adapter.ts";
import { type DeliveryResult, delivered, failed, unavailable } from "../core/delivery.ts";
import { cliPath } from "../core/paths.ts";
import { fileOffset, watchTranscript } from "../util/watch.ts";

/**
 * Aside (the browser).
 *
 * Identity: Aside's session record id plus its account, from the per-account
 * SQLite store at ~/.aside/u/<N>/state.db (read-only). Stored indefinitely.
 *
 * Delivery: Aside's CLI, `aside --account u<N> session queue <id> "<text>"`, the
 * analogue of `codex queue`. Receipt: the session's messages.jsonl records the
 * queued text as a `user` entry.
 *
 * Outbound: Aside spawns one MCP shim per account, so a message an Aside session
 * sends is attributed to the account (`init` names it in the shim's environment).
 *
 * All of this is observed local layout, not a public contract.
 */

const usersDir = () => join(homedir(), ".aside", "u");
const asideCli = () => join(homedir(), ".local", "bin", "aside");
const HEALTH = "http://127.0.0.1:21420/health";

interface Row {
  id: string;
  title: string;
  status: string;
  updated_at: number;
  created_at: number;
  parent_id: string | null;
  trigger: string | null;
}

function accounts(): number[] {
  if (!existsSync(usersDir())) return [];
  return readdirSync(usersDir())
    .filter((d) => /^\d+$/.test(d) && existsSync(join(usersDir(), d, "settings.json")))
    .map(Number);
}

function sessionsOf(account: number): Row[] {
  const path = join(usersDir(), String(account), "state.db");
  if (!existsSync(path)) return [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db
        .query<Row, []>(
          `SELECT id, title, status, updated_at, created_at, parent_id, trigger FROM sessions
           WHERE archived_at IS NULL AND ephemeral = 0 ORDER BY updated_at DESC LIMIT 50`,
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function transcriptPath(account: number, sessionId: string): string | undefined {
  const dir = join(usersDir(), String(account), "sessions");
  if (!existsSync(dir)) return undefined;
  const match = readdirSync(dir).find((d) => d.endsWith(`_${sessionId}`));
  return match ? join(dir, match, "messages.jsonl") : undefined;
}

async function daemonUp(): Promise<boolean> {
  try {
    return (await fetch(HEALTH, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

interface Handle {
  sessionId: string;
  account: number;
}

export class AsideAdapter implements HostAdapter {
  readonly host = "aside";

  async observe(): Promise<Observation[]> {
    if (!(await daemonUp())) return [];
    const cli = existsSync(asideCli());
    const recent = Date.now() / 1000 - 7 * 24 * 3600;
    const out: Observation[] = [];
    for (const account of accounts()) {
      for (const s of sessionsOf(account)) {
        if (s.updated_at < recent) continue;
        const subagent = Boolean(s.parent_id) || (s.trigger ?? "").includes('"subagent"');
        out.push({
          handle: { sessionId: s.id, account } satisfies Handle,
          key: s.id,
          name: s.title || `aside-${s.id}`,
          durability: "permanent",
          relationship: subagent ? "subagent" : "top-level",
          parentKey: s.parent_id ?? undefined,
          evidence: `aside u/${account} state.db`,
          reachable: cli,
          note: cli ? undefined : "Aside CLI not installed (~/.local/bin/aside)",
          status: s.status,
          title: s.title,
          startedAt: s.created_at * 1000,
        });
      }
    }
    return out;
  }

  handleFromKey(key: string): Handle {
    return { sessionId: key, account: -1 };
  }

  async deliver(
    handle: unknown,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const h = handle as Handle;
    const account =
      h.account >= 0 ? h.account : accounts().find((a) => transcriptPath(a, h.sessionId));
    if (account === undefined) return unavailable("account for session not found");
    if (!existsSync(asideCli())) return unavailable("aside cli not installed");
    const path = transcriptPath(account, h.sessionId);
    const fromOffset = path ? fileOffset(path) : 0;
    const proc = Bun.spawn(
      [asideCli(), "--account", `u${account}`, "session", "queue", h.sessionId, text],
      { stdout: "pipe", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return failed(`aside session queue: ${err || "failed"}`);
    }
    if (path)
      watchTranscript({ path, marker, fromOffset, accept: isUserEntry, onFound: onReceipt });
    return delivered("aside session queue");
  }

  configure(): ConfigurePlan {
    const entry = (account: number) => ({
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [cliPath(), "mcp"],
      env: {
        MODELBUS_HOST: "aside",
        MODELBUS_KEY: `account:${account}`,
        MODELBUS_NAME: account === 0 ? "aside" : `aside-${account}`,
      },
    });
    // Aside only offers a server's tools once its settings hold a cached tool
    // inventory for it; it does not query a new server on its own.
    const inventory = {
      tools: [
        {
          name: "send",
          description: "Message another agent on this machine by name.",
          inputSchema: {
            type: "object",
            properties: {
              to: { type: "string" },
              body: { type: "string" },
              wait: { type: "number" },
            },
            required: ["to", "body"],
          },
        },
        {
          name: "who",
          description: "List the agents on this machine.",
          inputSchema: { type: "object", properties: { filter: { type: "string" } } },
        },
      ],
      refreshedAt: new Date().toISOString(),
    };
    return {
      describe: accounts().map(
        (a) => `Aside (~/.aside/u/${a}/settings.json): mcp.servers.modelbus + tool inventory`,
      ),
      apply: async () => {
        const done: string[] = [];
        for (const a of accounts()) {
          const path = join(usersDir(), String(a), "settings.json");
          const s = JSON.parse(readFileSync(path, "utf8")) as {
            mcp?: { servers?: Record<string, unknown>; inventories?: Record<string, unknown> };
          };
          const mcp = s.mcp ?? {};
          s.mcp = {
            ...mcp,
            servers: { ...mcp.servers, modelbus: entry(a) },
            inventories: { ...mcp.inventories, modelbus: inventory },
          };
          writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
          done.push(`aside u/${a}: wrote mcp.servers.modelbus + inventory`);
        }
        return done;
      },
    };
  }
}

function isUserEntry(line: string): boolean {
  try {
    return (JSON.parse(line) as { role?: string }).role === "user";
  } catch {
    return false;
  }
}
