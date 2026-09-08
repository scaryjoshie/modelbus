import type { HostAdapter, Observation } from "../core/adapter.ts";
import { aside as asideDetect } from "../providers/aside.ts";

/**
 * Aside adapter (observation only in this milestone). Identity is Aside's session
 * record id, which its daemon stores indefinitely, so durability is permanent.
 * Delivery via MCP + heartbeat routine is milestone 4.
 */

interface AsideHandle {
  sessionId: string;
  account?: number;
}

export class AsideAdapter implements HostAdapter {
  readonly host = "aside" as const;

  async observe(): Promise<Observation[]> {
    const sessions = await asideDetect.detect();
    const recent = Date.now() - 7 * 24 * 3600 * 1000;
    return sessions
      .filter((s) => s.sessionId)
      .filter((s) => {
        const last = Date.parse(String(s.extra?.lastActive ?? ""));
        return Number.isNaN(last) || last >= recent;
      })
      .map((s) => {
        const handle: AsideHandle = {
          sessionId: s.sessionId as string,
          account: typeof s.extra?.account === "number" ? s.extra.account : undefined,
        };
        return {
          handle,
          key: s.sessionId as string,
          name: s.name,
          durability: "permanent",
          relationship: s.extra?.subagent ? "subagent" : "top-level",
          parentKey: typeof s.extra?.parentId === "string" ? s.extra.parentId : undefined,
          evidence: "aside state.db sessions row (parent_id / trigger.type)",
          reachable: false,
          note: "delivery not implemented yet (milestone 4)",
          pid: s.pid,
          cwd: s.cwd,
          status: s.status,
          startedAt: s.startedAt,
        } satisfies Observation;
      });
  }

  handleFromKey(key: string): AsideHandle {
    return { sessionId: key };
  }
}
