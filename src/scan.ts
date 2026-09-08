import { aside } from "./providers/aside.ts";
import { claudeCode } from "./providers/claude-code.ts";
import { codex } from "./providers/codex.ts";
import { processScan } from "./providers/process-scan.ts";
import { cmuxSurfacesByTty } from "./terminals/cmux.ts";
import type { LiveSession, Provider, Reach } from "./types.ts";

const PROVIDERS: Provider[] = [claudeCode, codex, processScan, aside];

const REACH_ORDER: Reach[] = [
  "claude-socket",
  "codex-queue",
  "aside-mcp",
  "cmux-send",
  "tmux-paste",
  "pull-only",
];

/**
 * Run every provider, attach terminal locations by tty, and finalize reach.
 * Providers never throw; a failing provider just contributes nothing.
 */
export async function scan(): Promise<LiveSession[]> {
  const [results, surfaces] = await Promise.all([
    Promise.all(PROVIDERS.map((p) => p.detect().catch(() => [] as LiveSession[]))),
    cmuxSurfacesByTty(),
  ]);
  const sessions = results.flat();
  for (const s of sessions) {
    if (s.tty) {
      const loc = surfaces.get(s.tty) ?? surfaces.get(`/dev/${s.tty}`);
      if (loc) {
        s.terminal = loc;
        if (!s.reach.includes("cmux-send")) s.reach.push("cmux-send");
      }
    }
    if (s.reach.length > 1) s.reach = s.reach.filter((r) => r !== "pull-only");
    s.reach.sort((a, b) => REACH_ORDER.indexOf(a) - REACH_ORDER.indexOf(b));
  }
  sessions.sort((a, b) => {
    if (a.host !== b.host) return a.host.localeCompare(b.host);
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
  return sessions;
}
