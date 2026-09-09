import { existsSync } from "node:fs";
import type { HostAdapter, Observation } from "../../core/adapter.ts";
import { type DeliveryResult, failed, queued } from "../../core/delivery.ts";
import { fileOffset, watchTranscript } from "../../util/watch.ts";
import { configure } from "./configure.ts";
import { accounts, asideCli, daemonUp, isUserEntry, sessionsOf, transcriptPath } from "./state.ts";

/**
 * Aside (the browser).
 *
 * Identity: Aside's session record id. Stored indefinitely by Aside.
 * Delivery: `aside --account u<N> session queue <id> "<text>"`.
 * Receipt: the session's messages.jsonl records the queued text as a user entry.
 *
 * Outbound: Aside spawns one MCP shim per account, so a message an Aside session
 * sends is attributed to the account (`init` names it in the shim's environment).
 */

/** Sessions untouched for longer than this are not listed. */
const RECENT_MS = 7 * 24 * 3600 * 1000;

export class AsideAdapter implements HostAdapter {
  readonly host = "aside";
  /** Which account each observed session belongs to; the CLI needs it. */
  private readonly accountOf = new Map<string, number>();

  async observe(): Promise<Observation[]> {
    if (!(await daemonUp())) return [];
    const cli = existsSync(asideCli());
    const recent = (Date.now() - RECENT_MS) / 1000;
    const out: Observation[] = [];
    for (const account of accounts()) {
      for (const s of sessionsOf(account)) {
        if (s.updated_at < recent) continue;
        this.accountOf.set(s.id, account);
        const subagent = Boolean(s.parent_id) || (s.trigger ?? "").includes('"subagent"');
        out.push({
          key: s.id,
          name: s.title || `aside-${s.id}`,
          relationship: subagent ? "subagent" : "top-level",
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

  async deliver(
    sessionId: string,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const account =
      this.accountOf.get(sessionId) ?? accounts().find((a) => transcriptPath(a, sessionId));
    if (account === undefined) return failed("account for session not found");
    if (!existsSync(asideCli())) return failed("aside cli not installed");
    const path = transcriptPath(account, sessionId);
    const fromOffset = path ? fileOffset(path) : 0;
    const proc = Bun.spawn(
      [asideCli(), "--account", `u${account}`, "session", "queue", sessionId, text],
      { stdout: "pipe", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return failed(`aside session queue: ${err || "failed"}`);
    }
    if (path)
      watchTranscript({ path, marker, fromOffset, accept: isUserEntry, onFound: onReceipt });
    return queued("aside session queue");
  }

  configure = configure;
}
