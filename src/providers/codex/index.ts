import { existsSync, statSync } from "node:fs";
import { delivered, failed, type Outbound } from "../../core/delivery.ts";
import type { Delivered, Observation, Provider, SelfIdentity } from "../../runtime/provider.ts";
import { attributed } from "../../util/attribution.ts";
import { ancestors, cwdOf, listProcesses } from "../../util/ps.ts";
import { fileOffset, watchTranscript } from "../../util/watch.ts";
import { configure } from "./configure.ts";
import { handle, isUserMessage, type Thread, threadMeta, threadsForPid } from "./threads.ts";

/**
 * Codex (OpenAI).
 *
 * Identity: the thread id of a process's root thread. Survives `codex resume`.
 * Delivery: the official `codex queue --thread`. Fails for a thread that has never
 * had a turn ("no rollout found"), reported as not reachable.
 * Read: the rollout records the queued text as a user message.
 */

export class CodexProvider implements Provider {
  readonly host = "codex";
  readonly discovery = { observe: this.observe.bind(this) };
  readonly connector = {
    /** Verified 2026-09-10: a queued message is gone after `codex resume`. */
    queueSurvivesRestart: false,
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
    const out: Observation[] = [];
    for (const f of found) {
      for (const t of f.threads) {
        const queueable = t.root && Boolean(t.rolloutPath);
        out.push({
          key: t.id,
          name: handle(t),
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
          activeAt:
            t.rolloutPath && existsSync(t.rolloutPath)
              ? statSync(t.rolloutPath).mtimeMs
              : undefined,
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
        name: handle(root),
      };
    }
    return null;
  }

  private async deliver(
    threadId: string,
    outbound: Outbound,
    onRead: () => void,
  ): Promise<Delivered> {
    const { text, marker } = attributed(outbound);
    const meta = threadMeta(threadId);
    const fromOffset = meta.rolloutPath ? fileOffset(meta.rolloutPath) : 0;
    const proc = Bun.spawn(["codex", "queue", "--thread", threadId, "--message", text], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) {
      const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
      return { result: failed(`codex queue: ${err || "failed"}`) };
    }
    const watch = meta.rolloutPath
      ? watchTranscript({
          path: meta.rolloutPath,
          marker,
          fromOffset,
          accept: isUserMessage,
          onFound: onRead,
        })
      : undefined;
    return { result: delivered("codex queue"), watch };
  }

  configure = configure;
}
