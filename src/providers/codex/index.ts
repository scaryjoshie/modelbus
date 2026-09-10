import { type DeliveryResult, failed, type Outbound, queued } from "../../core/delivery.ts";
import type { Observation, Provider, SelfIdentity } from "../../runtime/provider.ts";
import { attributed } from "../../util/attribution.ts";
import { ancestors, cwdOf, listProcesses } from "../../util/ps.ts";
import { fileOffset, watchTranscript } from "../../util/watch.ts";
import { configure } from "./configure.ts";
import { displayNames, isUserMessage, type Thread, threadMeta, threadsForPid } from "./threads.ts";

/**
 * Codex (OpenAI).
 *
 * Identity: the thread id of a process's root thread. Survives `codex resume`.
 * Delivery: the official `codex queue --thread`. Fails for a thread that has never
 * had a turn ("no rollout found"), reported as not reachable.
 * Receipt: the rollout records the queued text as a user message.
 */

export class CodexProvider implements Provider {
  readonly host = "codex";
  readonly discovery = { observe: this.observe.bind(this) };
  readonly connector = {
    deliver: this.deliver.bind(this),
  };

  private async observe(): Promise<Observation[]> {
    const procs = (await listProcesses()).filter((p) => p.exe === "codex" && p.tty);
    const found: Array<{ pid: number; startedAt?: number; threads: Thread[]; cwd?: string }> = [];
    for (const p of procs) {
      found.push({
        pid: p.pid,
        startedAt: p.startedAt,
        threads: await threadsForPid(p.pid),
        cwd: await cwdOf(p.pid),
      });
    }
    const names = displayNames(found.flatMap((f) => f.threads.filter((t) => t.root)));
    const out: Observation[] = [];
    for (const f of found) {
      for (const t of f.threads) {
        const queueable = t.root && Boolean(t.rolloutPath);
        out.push({
          key: t.id,
          name: names.get(t.id) ?? `codex-${t.id.slice(0, 4)}`,
          relationship: t.root ? "top-level" : t.parentId ? "subagent" : "unknown",
          reachable: queueable,
          note:
            t.root && !queueable
              ? "no turns yet; codex queue works after the first turn"
              : undefined,
          pid: f.pid,
          cwd: t.cwd ?? f.cwd,
          title: t.title,
          startedAt: f.startedAt,
        });
      }
    }
    return out;
  }

  async identifySelf(): Promise<SelfIdentity | null> {
    for (const a of await ancestors()) {
      if (a.comm.split("/").pop() !== "codex") continue;
      const roots = (await threadsForPid(a.pid)).filter((t) => t.root);
      const root = roots[0];
      if (roots.length !== 1 || !root) continue;
      return {
        host: this.host,
        key: root.id,
        name: displayNames([root]).get(root.id) ?? "codex-1",
      };
    }
    return null;
  }

  private async deliver(
    threadId: string,
    outbound: Outbound,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const { text, marker } = attributed(outbound);
    const meta = threadMeta(threadId);
    const fromOffset = meta.rolloutPath ? fileOffset(meta.rolloutPath) : 0;
    const proc = Bun.spawn(["codex", "queue", "--thread", threadId, "--message", text], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return failed(`codex queue: ${err || "failed"}`);
    }
    if (meta.rolloutPath) {
      watchTranscript({
        path: meta.rolloutPath,
        marker,
        fromOffset,
        accept: isUserMessage,
        onFound: onReceipt,
      });
    }
    return queued("codex queue");
  }

  configure = configure;
}
