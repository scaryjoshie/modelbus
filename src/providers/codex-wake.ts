import type { Api, WakeProvider } from "../core/api.ts";
import type { Agent, Message } from "../core/store.ts";
import { threadMeta } from "./codex.ts";
import { watchTranscript } from "./watch.ts";

/**
 * Delivers into a Codex TUI session with the official `codex queue` command, which
 * writes to Codex's shared queue database; the running TUI picks the item up as its
 * next turn. No token, no dialog on the receiving side (verified 2026-09-06).
 *
 * Receipt: the rollout file records the queued text as a user message
 * (`response_item` with payload.type "message" and role "user"). We watch for a
 * line containing our marker with that shape.
 */
export class CodexWake implements WakeProvider {
  readonly host = "codex";

  constructor(private readonly api: Api) {}

  async wake(agent: Agent, threadId: string, message: Message, text: string): Promise<string> {
    const proc = Bun.spawn(["codex", "queue", "--thread", threadId, "--message", text], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return `error: codex queue exit ${code}${err ? `: ${err.split("\n")[0]}` : ""}`;
    }
    const meta = threadMeta(threadId);
    if (meta.rolloutPath) {
      watchTranscript({
        path: meta.rolloutPath,
        marker: `#${message.id}`,
        accept: isCodexUserMessage,
        onFound: () => this.api.store.markReceived([message.id], agent.id),
      });
    }
    return "queued";
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
