import type { Api } from "./core/api.ts";
import type { Agent } from "./core/store.ts";
import { scan } from "./scan.ts";
import type { LiveSession } from "./types.ts";

/**
 * The roster merges bound agents (in the store) with live sessions the scanner sees.
 * A detected session that has never contacted the bus is "unbound"; `send` to it
 * binds it on the spot using the host's own session id, so any live session the
 * scanner can identify is addressable. Scan results are cached briefly.
 */

export interface RosterEntry {
  name: string;
  host: string;
  state: "live" | "unbound" | "offline";
  cwd?: string;
  status?: string;
  lastSeen?: number;
  agent?: Agent;
  session?: LiveSession;
}

const CACHE_MS = 5000;

export class Roster {
  private cache: { at: number; sessions: LiveSession[] } | undefined;

  constructor(
    private readonly api: Api,
    private readonly scanFn: () => Promise<LiveSession[]> = scan,
  ) {}

  async sessions(): Promise<LiveSession[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.sessions;
    let sessions: LiveSession[] = [];
    try {
      sessions = await this.scanFn();
    } catch {
      /* scanner failure just means no unbound entries this round */
    }
    this.cache = { at: Date.now(), sessions };
    return sessions;
  }

  /** Bound agents first, then detected sessions that are not bound yet. */
  async list(filter?: string): Promise<RosterEntry[]> {
    const agents = this.api.who();
    const sessions = (await this.sessions()).filter(
      (s) => s.sessionId && s.reach[0] !== "pull-only",
    );
    const boundRefs = new Set<string>();
    const entries: RosterEntry[] = [];
    for (const a of agents) {
      const b = this.api.store.binding(a.id);
      if (b) boundRefs.add(`${b.host}:${b.host_session_ref}`);
      const s = sessions.find((x) => x.host === b?.host && x.sessionId === b?.host_session_ref);
      entries.push({
        name: a.name,
        host: a.host,
        state: "live",
        cwd: s?.cwd,
        status: s?.status,
        lastSeen: a.last_seen,
        agent: a,
        session: s,
      });
    }
    for (const s of sessions) {
      if (boundRefs.has(`${s.host}:${s.sessionId}`)) continue;
      if (agents.some((a) => a.name === s.name)) continue;
      entries.push({
        name: s.name,
        host: s.host,
        state: "unbound",
        cwd: s.cwd,
        status: s.status,
        session: s,
      });
    }
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(f) ||
        e.host.toLowerCase().includes(f) ||
        (e.cwd ?? "").toLowerCase().includes(f) ||
        String(e.session?.extra?.title ?? "")
          .toLowerCase()
          .includes(f),
    );
  }

  /** Resolve a name to a bound agent, binding a detected session if needed. */
  async resolveOrBind(name: string): Promise<Agent | null> {
    const bound = this.api.store.agentByName(name);
    if (bound) return bound;
    const s = (await this.sessions()).find(
      (x) => x.name === name && x.sessionId && x.reach[0] !== "pull-only",
    );
    if (!s?.sessionId) return null;
    return this.api.bind({
      host: s.host,
      hostSessionRef: s.sessionId,
      preferredName: s.name,
      evidence: `auto-bound from scan (pid ${s.pid ?? "?"})`,
    });
  }
}
