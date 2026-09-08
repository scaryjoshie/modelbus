import type { ConfigurePlan, HostAdapter, Observation } from "../core/adapter.ts";
import {
  type CodexThread,
  codexDisplayNames,
  threadMeta,
  threadsForPid,
} from "../providers/codex.ts";
import { codexInitPlan, codexInitWrite } from "../providers/codex-setup.ts";
import { watchTranscript } from "../providers/watch.ts";
import { cwdOf, listProcesses } from "../util/ps.ts";

/**
 * Codex adapter.
 *
 * Identity: the thread id of the process's root thread. One process can own a root
 * plus subagent threads (all visible as lock files it holds); roots are identified
 * from Codex's state DB, the rollout header, or the single-lock rule. Sealed in the
 * handle; survives `codex resume`.
 *
 * Delivery: the official `codex queue --thread`. Fails for a thread that has never
 * had a turn ("no rollout found"), which observe() reports as not reachable.
 *
 * Receipt: the rollout file records the queued text as a user message.
 */

interface CodexHandle {
  threadId: string;
}

export class CodexAdapter implements HostAdapter {
  readonly host = "codex" as const;

  async observe(): Promise<Observation[]> {
    const procs = (await listProcesses()).filter((p) => p.exe === "codex" && p.tty);
    const found: Array<{ p: (typeof procs)[number]; threads: CodexThread[]; cwd?: string }> = [];
    for (const p of procs) {
      found.push({ p, threads: await threadsForPid(p.pid), cwd: await cwdOf(p.pid) });
    }
    const names = codexDisplayNames(found.flatMap((f) => f.threads.filter((t) => t.root)));
    const out: Observation[] = [];
    for (const { p, threads, cwd } of found) {
      for (const t of threads) {
        const handle: CodexHandle = { threadId: t.id };
        const queueable = t.root && Boolean(t.rolloutPath);
        out.push({
          handle,
          key: t.id,
          name: names.get(t.id) ?? `codex-${t.id.slice(0, 4)}`,
          durability: "session",
          relationship: t.root ? "top-level" : t.parentId ? "subagent" : "unknown",
          parentKey: t.parentId,
          evidence: `lock file held by pid ${p.pid}; classified by ${t.evidence}`,
          reachable: queueable,
          note: t.root
            ? queueable
              ? undefined
              : "no turns yet; codex queue works after the first turn"
            : undefined,
          pid: p.pid,
          tty: p.tty,
          cwd: t.cwd ?? cwd,
          title: t.title,
          startedAt: p.startedAt,
        });
      }
    }
    return out;
  }

  handleFromKey(key: string): CodexHandle {
    return { threadId: key };
  }

  async deliver(
    handle: unknown,
    text: string,
    marker: string,
    onReceipt: () => void,
  ): Promise<string> {
    const h = handle as CodexHandle;
    const proc = Bun.spawn(["codex", "queue", "--thread", h.threadId, "--message", text], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return `error: codex queue exit ${code}${err ? `: ${err.split("\n")[0]}` : ""}`;
    }
    const meta = threadMeta(h.threadId);
    if (meta.rolloutPath) {
      watchTranscript({
        path: meta.rolloutPath,
        marker,
        accept: isCodexUserMessage,
        onFound: onReceipt,
      });
    }
    return "queued";
  }

  configure(): ConfigurePlan {
    const plan = codexInitPlan();
    return {
      describe: [
        plan.present
          ? `Codex (${plan.configPath}): already configured`
          : `Codex (${plan.configPath}): run ${plan.mcpCommand.join(" ")}`,
        `Codex (${plan.configPath}): pre-approve tools send/who/sync (approval_mode = "approve")`,
      ],
      apply: () => codexInitWrite(plan),
    };
  }
}

export function isCodexUserMessage(line: string): boolean {
  try {
    const d = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string } };
    return d.type === "response_item" && d.payload?.type === "message" && d.payload.role === "user";
  } catch {
    return false;
  }
}
