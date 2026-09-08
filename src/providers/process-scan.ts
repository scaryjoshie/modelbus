import type { HostKind, LiveSession, Provider } from "../types.ts";
import { cwdOf, listProcesses } from "../util/ps.ts";

/**
 * Generic detector for hosts that leave no registry on disk: we find them by
 * executable name in the process table and look up their cwd with lsof.
 * Only processes attached to a tty count; that filters helper daemons.
 */
const EXE_TO_HOST: Record<string, HostKind> = {
  gemini: "gemini",
  opencode: "opencode",
  goose: "goose",
  aider: "aider",
  "cursor-agent": "cursor-agent",
  copilot: "copilot",
  hermes: "hermes",
};

export const processScan: Provider = {
  kind: "unknown",
  async detect(): Promise<LiveSession[]> {
    const procs = await listProcesses();
    const out: LiveSession[] = [];
    for (const p of procs) {
      const host = EXE_TO_HOST[p.exe];
      if (!host || !p.tty) continue;
      out.push({
        host,
        name: `${host}-${p.pid}`,
        pid: p.pid,
        tty: p.tty,
        cwd: await cwdOf(p.pid),
        startedAt: p.startedAt,
        reach: ["pull-only"],
      });
    }
    return out;
  },
};
