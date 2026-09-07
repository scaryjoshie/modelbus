import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LiveSession, Provider } from "../types.ts";
import { isAlive, listProcesses } from "../util/ps.ts";

/**
 * Claude Code writes one JSON file per running session to ~/.claude/sessions/<pid>.json
 * for its own cross-session messaging. It carries everything we want: name, cwd,
 * status, session id, and the messaging socket path. We treat a file as live only if
 * the pid it names is still running.
 */
const SessionFile = z.object({
  pid: z.number(),
  sessionId: z.string(),
  cwd: z.string(),
  startedAt: z.number().optional(),
  version: z.string().optional(),
  kind: z.string().optional(),
  entrypoint: z.string().optional(),
  messagingSocketPath: z.string().optional(),
  name: z.string().optional(),
  nameSource: z.string().optional(),
  status: z.string().optional(),
});

export const claudeCode: Provider = {
  kind: "claude-code",
  async detect(): Promise<LiveSession[]> {
    const dir = join(homedir(), ".claude", "sessions");
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return [];
    }
    const procs = await listProcesses();
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out: LiveSession[] = [];
    for (const f of files) {
      let parsed: z.infer<typeof SessionFile>;
      try {
        parsed = SessionFile.parse(await Bun.file(join(dir, f)).json());
      } catch {
        continue;
      }
      if (!isAlive(parsed.pid)) continue;
      const proc = byPid.get(parsed.pid);
      const reach: LiveSession["reach"] = parsed.messagingSocketPath
        ? ["claude-socket"]
        : ["pull-only"];
      out.push({
        host: "claude-code",
        name: parsed.name ?? `claude-${parsed.pid}`,
        pid: parsed.pid,
        tty: proc?.tty,
        cwd: parsed.cwd,
        status: parsed.status,
        sessionId: parsed.sessionId,
        startedAt: parsed.startedAt ?? proc?.startedAt,
        reach,
        extra: {
          version: parsed.version,
          kind: parsed.kind,
          socket: parsed.messagingSocketPath,
        },
      });
    }
    return out;
  },
};
