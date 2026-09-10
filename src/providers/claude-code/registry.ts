import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ancestors, isAlive } from "../../util/ps.ts";

/** Claude Code's per-session registry files, ~/.claude/sessions/<pid>.json. */

const sessionsDir = () => join(homedir(), ".claude", "sessions");

const Registry = z.object({
  pid: z.number(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  messagingSocketPath: z.string().optional(),
  status: z.string().optional(),
});

export interface Session {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  socketPath?: string;
  status?: string;
  transcriptPath: string;
}

export function readRegistry(pid: number): Session | null {
  const file = join(sessionsDir(), `${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    const r = Registry.parse(JSON.parse(readFileSync(file, "utf8")));
    const slug = r.cwd.replace(/[/.]/g, "-");
    return {
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      name: r.name ?? `claude-${r.pid}`,
      socketPath: r.messagingSocketPath,
      status: r.status,
      transcriptPath: join(homedir(), ".claude", "projects", slug, `${r.sessionId}.jsonl`),
    };
  } catch {
    return null;
  }
}

export function liveSessions(): Session[] {
  if (!existsSync(sessionsDir())) return [];
  const out: Session[] = [];
  for (const f of readdirSync(sessionsDir())) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!isAlive(pid)) continue;
    const s = readRegistry(pid);
    if (s) out.push(s);
  }
  return out;
}

/** The Claude Code session this process runs inside, by ancestor pid. */
export async function currentSession(): Promise<Session | null> {
  for (const a of await ancestors()) {
    const s = readRegistry(a.pid);
    if (s) return s;
  }
  return null;
}
