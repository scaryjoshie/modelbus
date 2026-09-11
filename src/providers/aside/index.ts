import { existsSync } from "node:fs";
import { delivered, failed, type Outbound } from "../../core/delivery.ts";
import type { Delivered, Observation, Provider } from "../../runtime/provider.ts";
import { attributed } from "../../util/attribution.ts";
import { fileOffset, watchTranscript } from "../../util/watch.ts";
import { configure } from "./configure.ts";
import { accounts, asideCli, daemonUp, isUserEntry, sessionsOf, transcriptPath } from "./state.ts";

/**
 * Aside (the browser).
 *
 * Identity: Aside's session record id. Stored indefinitely by Aside.
 * Delivery: `aside --account u<N> session queue <id> "<text>"`.
 * Read: the session's messages.jsonl records the queued text as a user entry.
 *
 * Outbound: Aside spawns one MCP shim per account, so a message an Aside session
 * sends is attributed to the account (`init` names it in the shim's environment).
 */

/** How long a handle's id part is: enough to tell sessions apart, short enough to type. */
const HANDLE_ID_CHARS = 4;
/** Sessions untouched for longer than this are not listed. */
const RECENT_MS = 7 * 24 * 3600 * 1000;

export class AsideProvider implements Provider {
  readonly name = "aside";
  readonly discovery = { observe: this.observe.bind(this) };
  readonly connector = {
    deliver: this.deliver.bind(this),
  };
  /** Which account each observed session belongs to; the CLI needs it. */
  private readonly accountOf = new Map<string, number>();

  private async observe(): Promise<Observation[]> {
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
          name: `aside-${String(s.id).replace(/-/g, "").slice(-HANDLE_ID_CHARS)}`,
          relationship: subagent ? "subagent" : "top-level",
          reachable: cli,
          note: cli ? undefined : "Aside CLI not installed (~/.local/bin/aside)",
          status: s.status,
          title: s.title || undefined,
          startedAt: s.created_at * 1000,
          activeAt: s.updated_at * 1000,
        });
      }
    }
    return out;
  }

  private async deliver(
    sessionId: string,
    outbound: Outbound,
    onRead: () => void,
  ): Promise<Delivered> {
    const { text, marker } = attributed(outbound);
    const account =
      this.accountOf.get(sessionId) ?? accounts().find((a) => transcriptPath(a, sessionId));
    if (account === undefined) return { result: failed("account for session not found") };
    if (!existsSync(asideCli())) return { result: failed("aside cli not installed") };
    const path = transcriptPath(account, sessionId);
    const fromOffset = path ? fileOffset(path) : 0;
    const proc = Bun.spawn(
      [asideCli(), "--account", `u${account}`, "session", "queue", sessionId, text],
      { stdout: "pipe", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return { result: failed(`aside session queue: ${err || "failed"}`) };
    }
    const watch = path
      ? watchTranscript({ path, marker, fromOffset, accept: isUserEntry, onFound: onRead })
      : undefined;
    return { result: delivered("aside session queue"), watch };
  }

  configure = configure;
}
